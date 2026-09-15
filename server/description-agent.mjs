import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { previewType, readZip } from './preview.mjs';

const outputSchema = { type: 'object', additionalProperties: false, properties: { markdown: { type: 'string' } }, required: ['markdown'] };
const decode = buffer => { try { return new TextDecoder('utf-8',{fatal:true}).decode(buffer); } catch { return new TextDecoder('gb18030').decode(buffer); } };
function run(command, args, options) {
  return new Promise((resolve, reject) => { const child = spawn(command, args, { ...options, windowsHide: true, stdio: ['ignore','pipe','pipe'] }); let stdout='', stderr='', timedOut=false; const timer=setTimeout(()=>{ timedOut=true; child.kill(); },30000); child.stdout.on('data',v=>stdout+=v); child.stderr.on('data',v=>stderr+=v); child.on('error',reject); child.on('close',code=>{clearTimeout(timer);if(timedOut) return reject(new Error('Claude Code 响应超时（30 秒）'));code===0?resolve(stdout):reject(new Error(`数据说明 Agent 执行失败${stderr.trim()?`：${stderr.trim().slice(-300)}`:''}`));}); });
}
async function callCompatibleApi(config, prompt) {
  const controller=new AbortController(), timer=setTimeout(()=>controller.abort(),180000);
  try {
    const request=config.descriptionAgentFetch||fetch;
    const response=await request(`${config.descriptionAgentUrl.replace(/\/$/,'')}/v1/messages`,{method:'POST',signal:controller.signal,headers:{'content-type':'application/json','x-api-key':config.descriptionAgentKey,'authorization':`Bearer ${config.descriptionAgentKey}`,'anthropic-version':'2023-06-01'},body:JSON.stringify({model:config.descriptionAgentModel,max_tokens:8192,messages:[{role:'user',content:prompt}]})});
    const payload=await response.json().catch(()=>null);
    if(!response.ok) throw new Error(`兼容接口请求失败（HTTP ${response.status}）${payload?.error?.message?`：${payload.error.message}`:''}`);
    const anthropicText=Array.isArray(payload?.content)?payload.content.filter(item=>item.type==='text').map(item=>item.text).join('\n'):'';
    const openAiContent=payload?.choices?.[0]?.message?.content;
    const openAiText=Array.isArray(openAiContent)?openAiContent.filter(item=>item.type==='text'||item.type==='output_text').map(item=>item.text||item.content||'').join('\n'):openAiContent;
    const text=String(anthropicText||openAiText||payload?.output_text||payload?.text||'').trim();
    if(!text) throw new Error('兼容接口没有返回文本内容');
    const cleaned=text.replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'').trim();
    try { return JSON.parse(cleaned); } catch { return { markdown:cleaned }; }
  } finally { clearTimeout(timer); }
}
async function inventory(files, root) {
  const lines=[];
  for (const file of files) {
    const target=path.join(root,'files',file.id), type=previewType(file.name); lines.push(`\n上传文件：${file.name}（${file.size} bytes）`);
    if (type.kind==='archive') {
      const entries=await readZip(target); lines.push('ZIP 目录：\n'+entries.slice(0,1000).map(e=>`${e.directory?'[目录]':'[文件]'} ${e.name}`).join('\n'));
      let sampled=0; for (const [index,entry] of entries.entries()) { if (sampled>=12||entry.directory||entry.size>262144||previewType(entry.name).kind!=='text') continue; const item=await readZip(target,index); lines.push(`\n文件片段 ${entry.name}：\n${decode(item.buffer).slice(0,6000)}`); sampled++; }
    } else if (type.kind==='text' && file.size<=1048576) lines.push('文件片段：\n'+decode(fs.readFileSync(target)).slice(0,8000));
  }
  return lines.join('\n').slice(0,90000);
}
export function createDescriptionAgent(config, store) {
  return async files => {
    if (!config.descriptionAgentKey || !config.descriptionAgentUrl || !config.descriptionAgentModel) throw Object.assign(new Error('尚未配置数据说明 Agent，请联系管理员填写独立的 Key、URL 和模型名称'),{status:503});
    const material=await inventory(files,store.root), prompt=`请分析以下 Demo 数据材料，生成一段可直接保存的中文 Markdown 数据说明。只能包含以下两个一级标题，不能生成成本预估、难度说明、简介、注意事项或其他一级标题。\n\n# 数据概述\n使用一段完整文字说明数据内容、组织方式、用途和适用场景。\n\n# 数据格式\n先使用 Markdown 代码块展示最小单位的单个目录结构，不要出现具体任务名称、批次名称或 Demo 名称。目录树中的每个关键文件后面用“#”标注功能。代码块之后说明关键文件的内容。\n\n不得虚构未观察到的文件或字段。输出 JSON 的 markdown 字段。\n\n材料：${material}`;
    let result;
    if (config.descriptionAgentRunner) result = await config.descriptionAgentRunner({ prompt, files });
    else {
      const env={...process.env,ANTHROPIC_API_KEY:config.descriptionAgentKey,ANTHROPIC_BASE_URL:config.descriptionAgentUrl,ANTHROPIC_MODEL:config.descriptionAgentModel,CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1'};
      delete env.ANTHROPIC_AUTH_TOKEN;
      try {
        const stdout=await run(config.descriptionAgentCommand||'claude',['--bare','-p','--no-session-persistence','--permission-mode','dontAsk','--tools','','--model',config.descriptionAgentModel,'--output-format','json','--json-schema',JSON.stringify(outputSchema),prompt],{cwd:store.root,env});
        const envelope=JSON.parse(stdout); result=envelope.structured_output || (typeof envelope.result==='string'?JSON.parse(envelope.result):envelope.result) || envelope;
      } catch (cliError) {
        try { result=await callCompatibleApi(config,prompt); }
        catch (apiError) { throw new Error(`${cliError.message}；备用接口失败：${apiError.message}`); }
      }
    }
    if (!result?.markdown?.trim() || !result.markdown.includes('# 数据概述') || !result.markdown.includes('# 数据格式')) throw new Error('数据说明 Agent 返回内容不完整');
    return { markdown:result.markdown.trim().slice(0,20000) };
  };
}
