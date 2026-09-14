import { uid, now, parse } from './db.mjs';
const messageTemplates = {
  submit: ['Demo 待审核', '员工已提交审核，请检查文件和数据说明。'], withdraw: ['Demo 已撤回', '员工已撤回本次审核申请。'],
  reject: ['Demo 需要返修', '主管已退回该版本，请修改后重新提交。'], publish: ['Demo 已发布', '该版本已审核通过并发布。'],
  unpublish: ['Demo 已下架', '该版本已下架，文件停止下载和预览。'], restore: ['Demo 已恢复发布', '该版本已恢复发布。'],
  set_default: ['Demo 默认版本已变更', '该版本已设为默认发布版本。'],
  description_generated: ['AI 数据说明已生成', '数据说明已生成，请进入应用审查并决定是否应用到草稿。']
};
export function feishuAppLink(appId, assetId) {
  const link = new URL('https://applink.feishu.cn/client/web_app/open');
  link.searchParams.set('appId', appId);
  link.searchParams.set('mode', 'appCenter');
  link.searchParams.set('path', '/');
  link.searchParams.set('demo', assetId);
  return link.toString();
}
export function createNotifications(store, config) {
  const {one,all,run} = store;
  store.db.exec(`CREATE TABLE IF NOT EXISTS notifications (
    id TEXT PRIMARY KEY, version_id TEXT NOT NULL, kind TEXT NOT NULL, round INTEGER NOT NULL,
    recipient_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
    next_at INTEGER NOT NULL DEFAULT 0, error TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL,
    sent_at TEXT, UNIQUE(version_id,kind,round,recipient_id));`);
  if (!all('PRAGMA table_info(notifications)').some(column => column.name === 'detail')) store.db.exec("ALTER TABLE notifications ADD COLUMN detail TEXT NOT NULL DEFAULT '{}'");
  function enqueue(action, asset, version, actor, workflowRound, detail = {}) {
    if (!messageTemplates[action]) return;
    const owner = one('SELECT * FROM users WHERE id=?', asset.owner_id);
    const supervisor = one('SELECT * FROM users WHERE id=?', one('SELECT reviewer_id FROM versions WHERE id=?',version.id)?.reviewer_id || '');
    const pms = all('SELECT * FROM users WHERE enabled=1').filter(user => parse(user.roles,[]).includes('pm'));
    const cc = action==='publish' ? all('SELECT u.* FROM version_cc c JOIN users u ON u.id=c.user_id WHERE c.version_id=?',version.id) : [];
    let users = ['submit','withdraw'].includes(action) ? [supervisor] : action === 'reject' ? [owner] : [owner,...pms,...cc];
    users = [...new Map(users.filter(user => user?.enabled && user.id !== actor.id).map(user => [user.id,user])).values()];
    const eventSequence = action === 'submit' ? workflowRound : version.revision + 1;
    for (const user of users) run('INSERT OR IGNORE INTO notifications(id,version_id,kind,round,recipient_id,detail,created_at) VALUES(?,?,?,?,?,?,?)',uid(),version.id,action,eventSequence,user.id,JSON.stringify({...detail,workflowRound}),now());
    if (!users.length) run('INSERT OR IGNORE INTO notifications(id,version_id,kind,round,recipient_id,status,error,detail,created_at) VALUES(?,?,?,?,?,?,?,?,?)',uid(),version.id,action,eventSequence,'','skipped','没有可通知的对应人员',JSON.stringify({...detail,workflowRound}),now());
  }
  function enqueueDirect(action, version, recipient, sequence, detail = {}) {
    if (!messageTemplates[action] || !recipient?.enabled) return;
    run('INSERT OR IGNORE INTO notifications(id,version_id,kind,round,recipient_id,detail,created_at) VALUES(?,?,?,?,?,?,?)',uid(),version.id,action,sequence,recipient.id,JSON.stringify(detail),now());
  }
  let busy=false, token='', expires=0;
  const call = config.notificationFetch || fetch;
  async function tokenFor() {
    if(token && expires>Date.now()) return token;
    if(!config.appId || !config.appSecret) throw new Error('未配置飞书应用凭据');
    const response=await call('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',{method:'POST',headers:{'Content-Type':'application/json'},signal:AbortSignal.timeout(15000),body:JSON.stringify({app_id:config.appId,app_secret:config.appSecret})});
    const data=await response.json();
    if(!response.ok || data.code!==0 || !data.tenant_access_token) throw new Error(`飞书应用鉴权失败 (${data.code || response.status})`);
    token=data.tenant_access_token; expires=Date.now()+Math.max(0,(data.expire||7200)-120)*1000; return token;
  }
  async function drain() {
    if(busy || config.demoMode) return;
    busy=true;
    try {
      for(const job of all("SELECT * FROM notifications WHERE status='pending' AND next_at<=? ORDER BY created_at LIMIT 10",Date.now())) {
        const version=one('SELECT * FROM versions WHERE id=?',job.version_id), asset=version&&one('SELECT * FROM assets WHERE id=?',version.asset_id), owner=asset&&one('SELECT * FROM users WHERE id=?',asset.owner_id), recipient=one('SELECT * FROM users WHERE id=?',job.recipient_id);
        const roles=recipient?parse(recipient.roles,[]):[], isOwner=recipient?.id===owner?.id, isSupervisor=recipient?.id===version?.reviewer_id&&roles.includes('supervisor'), isPm=roles.includes('pm'), isCc=!!one('SELECT 1 FROM version_cc WHERE version_id=? AND user_id=?',version?.id||'',recipient?.id||'');
        const detail=parse(job.detail,{});
        const stateOk=({submit:version?.status==='pending'&&version.submission_count===job.round,withdraw:version?.status==='draft',reject:version?.status==='returned',publish:version?.status==='published',unpublish:version?.status==='offline',restore:version?.status==='published',set_default:version?.status==='published'&&asset?.current_version_id===version?.id,description_generated:!!version})[job.kind];
        const audienceOk=job.kind==='description_generated'?true:['submit','withdraw'].includes(job.kind)?isSupervisor:job.kind==='reject'?isOwner:isOwner||isPm||(job.kind==='publish'&&isCc);
        if(!version||!recipient?.enabled||!audienceOk||!stateOk||recipient.open_id.startsWith('preview:')) { run("UPDATE notifications SET status='skipped',error=? WHERE id=?",'状态或接收人权限已变化，已取消通知',job.id); continue; }
        try {
          const bearer=await tokenFor(), title=parse(version.description).title||'未命名 Demo', [heading,body]=messageTemplates[job.kind];
          const text=`【${heading}】\n${title}\n版本：V${version.number}\n归属员工：${owner.name}\n${body}${detail.reason?`\n处理意见：${detail.reason}`:''}\n点击进入飞书应用：${feishuAppLink(config.appId,asset.id)}`;
          const response=await call('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${bearer}`},signal:AbortSignal.timeout(15000),body:JSON.stringify({receive_id:recipient.open_id,msg_type:'text',content:JSON.stringify({text}),uuid:job.id})});
          const data=await response.json(); if(!response.ok||data.code!==0){token='';throw new Error(`飞书发送失败 (${data.code||response.status})，请检查机器人、发送消息权限及应用可用范围`);}
          run("UPDATE notifications SET status='sent',attempts=attempts+1,sent_at=?,error='' WHERE id=?",now(),job.id);
        } catch(error) { const attempts=job.attempts+1; run('UPDATE notifications SET status=?,attempts=?,next_at=?,error=? WHERE id=?',attempts>=5?'failed':'pending',attempts,Date.now()+Math.min(300000,15000*2**attempts),error.message.startsWith('飞书')||error.message.startsWith('未配置')?error.message:'网络请求失败，请稍后重试',job.id); }
      }
    } finally { busy=false; }
  }
  const list=()=>all('SELECT n.*,u.name AS recipient FROM notifications n LEFT JOIN users u ON u.id=n.recipient_id ORDER BY n.created_at DESC LIMIT 100');
  return {enqueue,enqueueDirect,drain,list,start(){const timer=setInterval(()=>drain().catch(()=>console.error('Notification worker failed')),5000);timer.unref();return()=>clearInterval(timer);}};
}
