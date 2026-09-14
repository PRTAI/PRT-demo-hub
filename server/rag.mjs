import { z } from 'zod';
import { parse } from './db.mjs';

const inputSchema = z.object({ question: z.string().trim().min(2, '请至少输入两个字').max(500) });
const toolSchema = z.object({ query: z.string().max(200).default(''), category: z.string().max(80).optional(), status: z.enum(['draft', 'pending', 'returned', 'published', 'offline']).optional(), limit: z.number().int().min(1).max(12).default(8) });
function terms(value) { const text=String(value||'').toLowerCase().normalize('NFKC'), words=text.match(/[a-z0-9][a-z0-9_.-]+|[\p{Script=Han}]+/gu)||[], result=new Set(words); for(const word of words) if(/^[\p{Script=Han}]+$/u.test(word)){for(let i=0;i<word.length;i++)result.add(word[i]);for(let i=0;i<word.length-1;i++)result.add(word.slice(i,i+2));} return [...result]; }
function rank(query,rows,limit){const wanted=terms(query);return rows.map(row=>{const d=parse(row.description),fields=[d.title,d.summary,d.category,...(d.tags||[]),d.content,d.usage,d.costEstimate,d.difficulty,d.notes,d.changes],haystack=fields.join('\n').toLowerCase();let score=0;for(const term of wanted)if(haystack.includes(term))score+=term.length>1?3:.35;if(d.title&&query.includes(d.title))score+=12;return{row,description:d,score};}).filter(item=>!query||item.score>0).sort((a,b)=>b.score-a.score||b.row.updated_at.localeCompare(a.row.updated_at)).slice(0,limit);}
function source(item,index){return{ref:index+1,id:item.row.id,title:item.description.title||'未命名 Demo',category:item.description.category,summary:item.description.summary,tags:item.description.tags,content:item.description.content,usage:item.description.usage,costEstimate:item.description.costEstimate,difficulty:item.description.difficulty,notes:item.description.notes,owner:item.row.owner_name,status:item.row.status};}
async function chat(config,messages,tools){const response=await(config.fetch||fetch)(config.llmBaseUrl.replace(/\/$/,'')+'/chat/completions',{method:'POST',signal:AbortSignal.timeout(30000),headers:{Authorization:`Bearer ${config.llmApiKey}`,'Content-Type':'application/json'},body:JSON.stringify({model:config.llmModel,temperature:.1,max_tokens:900,messages,...(tools?{tools,tool_choice:'auto'}:{})})});if(!response.ok)throw new Error(`模型服务暂时不可用（${response.status}）`);const body=await response.json();return body.choices?.[0]?.message;}
export function createRagSearch(store,config,helpers){
  const loadRows=user=>store.all(`SELECT a.*,u.name AS owner_name,v.id AS version_id,v.number,v.status,v.description FROM assets a JOIN users u ON u.id=a.owner_id JOIN versions v ON v.id=(SELECT vv.id FROM versions vv WHERE vv.asset_id=a.id ORDER BY vv.number DESC LIMIT 1) ORDER BY a.updated_at DESC`).filter(row=>helpers.visible(user,row)).map(row=>({...row,description:JSON.stringify(helpers.descriptionFor(user,row,parse(row.description)))}));
  return async(user,body,emit=()=>{})=>{
    const{question}=inputSchema.parse(body||{}),rows=loadRows(user),found=new Map();emit({type:'stage',key:'understand',text:'正在理解你的检索意图…'});
    if(!config.llmApiKey){emit({type:'stage',key:'retrieve',text:'正在检索可见 Demo 的数据说明…'});const matches=rank(question,rows,8);return finishLocal(matches,helpers,user,'模型未配置，已使用本地检索。');}
    const tools=[{type:'function',function:{name:'search_demos',description:'在当前用户有权查看的 Demo 数据说明中检索。可多次调用并调整关键词、分类或状态。',parameters:{type:'object',properties:{query:{type:'string',description:'用于匹配名称、简介、标签、数据概述和数据格式的精炼关键词'},category:{type:'string',description:'可选业务分类'},status:{type:'string',enum:['draft','pending','returned','published','offline']},limit:{type:'integer',minimum:1,maximum:12}},required:['query']}}}];
    const messages=[{role:'system',content:'你是企业内部数据资产检索 Agent。先分析问题，再调用 search_demos。若首轮结果少或不理想，应换关键词再次调用，最多三轮。只能依据工具结果回答，使用 [1] 形式引用结果；证据不足要明确说明。'},{role:'user',content:question}];
    try{
      for(let round=0;round<3;round++){
        const message=await chat(config,messages,tools);if(!message)throw new Error('模型未返回内容');messages.push(message);
        if(!message.tool_calls?.length){const matches=[...found.values()].slice(0,8);emit({type:'stage',key:'compose',text:'检索完成，正在整理答案…'});return finish(message.content,matches,helpers,user,true,'');}
        for(const call of message.tool_calls){if(call.function?.name!=='search_demos')continue;let args;try{args=toolSchema.parse(JSON.parse(call.function.arguments||'{}'));}catch{args={query:question,limit:8};}
          emit({type:'stage',key:`retrieve-${round}`,text:round?`正在调整关键词并继续检索：“${args.query||question}”…`:`正在检索数据说明：“${args.query||question}”…`});
          const matches=rank(args.query,rows.filter(row=>(!args.category||parse(row.description).category===args.category)&&(!args.status||row.status===args.status)),args.limit);matches.forEach(x=>found.set(x.row.id,x));
          messages.push({role:'tool',tool_call_id:call.id,content:JSON.stringify(matches.map(item=>source(item,[...found.keys()].indexOf(item.row.id))))});emit({type:'stage',key:`found-${round}`,text:`本轮找到 ${matches.length} 个候选 Demo，正在判断是否需要继续检索…`});
        }
      }
      emit({type:'stage',key:'compose',text:'检索完成，正在生成最终答案…'});const message=await chat(config,[...messages,{role:'system',content:'工具调用轮次已用完。现在根据已有结果直接给出最终回答，不要再调用工具。'}]);return finish(message?.content,[...found.values()].slice(0,8),helpers,user,true,'');
    }catch(error){emit({type:'stage',key:'fallback',text:'模型检索暂时不可用，正在切换到本地检索…'});return finishLocal(rank(question,rows,8),helpers,user,error.message);}
  };
}
function finish(answer,matches,helpers,user,modelUsed,modelError){return{answer:answer?.trim()||'没有找到足够相关的 Demo。',modelUsed,modelError,sources:matches.map(item=>({...helpers.summary(user,item.row,false),relevance:Number(item.score.toFixed(2))}))};}
function finishLocal(matches,helpers,user,error){const answer=matches.length?`找到 ${matches.length} 个可能相关的 Demo。你可以先查看“${matches[0].description.title||'未命名 Demo'}”，再结合下方结果确认。`:'当前可见 Demo 的数据说明中没有找到足够相关的内容，可以换一种业务场景或字段名称再试。';return finish(answer,matches,helpers,user,false,error);}
