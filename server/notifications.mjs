import { uid, now, parse } from './db.mjs';
import { splitRequirementOwners } from '../shared/requirement-owners.mjs';
import { requirementDate } from '../shared/requirement-schedule.mjs';
import { safeFeishuAppLink } from '../shared/feishu-links.mjs';
const messageTemplates = {
  submit: ['Demo 待审核', '员工已提交审核，请检查文件和数据说明。'], withdraw: ['Demo 已撤回', '员工已撤回本次审核申请。'],
  reject: ['Demo 需要返修', '主管已退回该版本，请修改后重新提交。'], publish: ['Demo 已发布', '该版本已审核通过并发布。'],
  unpublish: ['Demo 已下架', '该版本已下架，文件停止下载和预览。'], restore: ['Demo 已恢复发布', '该版本已恢复发布。'],
  set_default: ['Demo 默认版本已变更', '该版本已设为默认发布版本。'],
  description_generated: ['AI 数据说明已生成', '数据说明已生成，请进入应用审查并决定是否应用到草稿。'],
  requirement_publish: ['新需求已发布', '你是该需求的负责人或发布人，请查看需求详情。'],
  requirement_calendar: ['需求日程已创建', '请查看飞书日程及邀请。']
};
const publicationActions = ['publish', 'restore'];
export function feishuAppLink(appId, assetId) {
  const link = new URL('https://applink.feishu.cn/client/web_app/open');
  link.searchParams.set('appId', appId);
  link.searchParams.set('mode', 'appCenter');
  link.searchParams.set('path', '/');
  link.searchParams.set('demo', assetId);
  return link.toString();
}
export function feishuRequirementLink(appId, requirementId) {
  const link = new URL('https://applink.feishu.cn/client/web_app/open');
  link.searchParams.set('appId', appId);
  link.searchParams.set('mode', 'appCenter');
  link.searchParams.set('path', '/?' + new URLSearchParams({ view: 'requirements', requirement: requirementId }));
  link.searchParams.set('view', 'requirements');
  link.searchParams.set('requirement', requirementId);
  return link.toString();
}
export function createNotifications(store, config) {
  const {one,all,run} = store;
  store.db.exec(`CREATE TABLE IF NOT EXISTS notifications (
    id TEXT PRIMARY KEY, version_id TEXT, requirement_id TEXT, kind TEXT NOT NULL, round INTEGER NOT NULL,
    recipient_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
    next_at INTEGER NOT NULL DEFAULT 0, error TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL,
    sent_at TEXT, UNIQUE(version_id,kind,round,recipient_id));`);
  if (!all('PRAGMA table_info(notifications)').some(column => column.name === 'detail')) store.db.exec("ALTER TABLE notifications ADD COLUMN detail TEXT NOT NULL DEFAULT '{}'");
  if (!all('PRAGMA table_info(notifications)').some(column => column.name === 'requirement_id')) {
    store.tx(() => store.db.exec(`CREATE TABLE notifications_new (
      id TEXT PRIMARY KEY, version_id TEXT, requirement_id TEXT, kind TEXT NOT NULL, round INTEGER NOT NULL,
      recipient_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
      next_at INTEGER NOT NULL DEFAULT 0, error TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL,
      sent_at TEXT, detail TEXT NOT NULL DEFAULT '{}', UNIQUE(version_id,kind,round,recipient_id));
      INSERT INTO notifications_new(id,version_id,kind,round,recipient_id,status,attempts,next_at,error,created_at,sent_at,detail)
        SELECT id,version_id,kind,round,recipient_id,status,attempts,next_at,error,created_at,sent_at,detail FROM notifications;
      DROP TABLE notifications; ALTER TABLE notifications_new RENAME TO notifications;`));
  }
  store.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS requirement_notification_recipient ON notifications(requirement_id,kind,round,recipient_id) WHERE requirement_id IS NOT NULL');
  function enqueueRequirement(requirement) {
    const recipients = all('SELECT u.* FROM users u WHERE u.enabled=1 AND u.deleted_at IS NULL AND (u.id=? OR EXISTS(SELECT 1 FROM requirement_assignees ra WHERE ra.requirement_id=? AND ra.user_id=u.id))', requirement.publisher_id, requirement.id);
    const owners = all('SELECT u.name,ra.responsibility FROM users u JOIN requirement_assignees ra ON ra.user_id=u.id WHERE ra.requirement_id=? ORDER BY u.name,u.id', requirement.id), groups = splitRequirementOwners(owners);
    const detail = JSON.stringify({ title: requirement.title, publisher: one('SELECT name FROM users WHERE id=?', requirement.publisher_id).name, assignedNames: owners.map(user => user.name), businessNames: groups.businessOwners.map(user => user.name), developmentNames: groups.developmentOwners.map(user => user.name), publishDate: requirement.planned_date || requirementDate(requirement.created_at), deadlineDate: requirement.deadline_date || '' });
    for (const recipient of recipients) run('INSERT OR IGNORE INTO notifications(id,requirement_id,kind,round,recipient_id,detail,created_at) VALUES(?,?,?,0,?,?,?)', uid(), requirement.id, 'requirement_publish', recipient.id, detail, now());
  }
  function enqueueRequirementCalendar(requirement) {
    const recipients = all(`SELECT u.id FROM users u WHERE u.enabled=1 AND u.deleted_at IS NULL AND u.open_id NOT LIKE 'preview:%' AND
      (u.id=? OR EXISTS(SELECT 1 FROM requirement_assignees ra WHERE ra.requirement_id=? AND ra.user_id=u.id))`, requirement.publisher_id, requirement.id);
    for (const recipient of recipients) run(`INSERT INTO notifications(id,requirement_id,kind,round,recipient_id,created_at) VALUES(?,?,?,0,?,?)
      ON CONFLICT(requirement_id,kind,round,recipient_id) WHERE requirement_id IS NOT NULL
      DO UPDATE SET status='pending',attempts=0,next_at=0,error='' WHERE notifications.status='skipped'`, uid(), requirement.id, 'requirement_calendar', recipient.id, now());
  }
  function enqueue(action, asset, version, actor, workflowRound, detail = {}) {
    if (!messageTemplates[action]) return;
    const owner = one('SELECT * FROM users WHERE id=?', asset.owner_id);
    const supervisor = one('SELECT * FROM users WHERE id=?', one('SELECT reviewer_id FROM versions WHERE id=?',version.id)?.reviewer_id || '');
    const enabledUsers = all('SELECT * FROM users WHERE enabled=1');
    const pms = enabledUsers.filter(user => parse(user.roles,[]).includes('pm'));
    const publication = publicationActions.includes(action);
    const requirements = publication ? all('SELECT r.id,r.title,r.publisher_id AS publisherId FROM requirements r JOIN asset_requirements ar ON ar.requirement_id=r.id WHERE ar.asset_id=? ORDER BY r.created_at,r.id',asset.id) : [];
    const businessPublishers = publication ? enabledUsers.filter(user => parse(user.roles,[]).includes('business') && requirements.some(requirement => requirement.publisherId === user.id)) : [];
    const cc = action==='publish' ? all('SELECT u.* FROM version_cc c JOIN users u ON u.id=c.user_id WHERE c.version_id=?',version.id) : [];
    let users = ['submit','withdraw'].includes(action) ? [supervisor] : action === 'reject' ? [owner] : [owner,...pms,...cc];
    users = [...users.filter(user => user?.id !== actor.id), ...(publication ? [...pms,...businessPublishers] : [])];
    users = [...new Map(users.filter(user => user?.enabled).map(user => [user.id,user])).values()];
    const eventSequence = action === 'submit' ? workflowRound : version.revision + 1;
    const messageDetail = JSON.stringify({...detail,workflowRound,...(publication ? { requirements: requirements.map(({id,title}) => ({id,title})) } : {})});
    for (const user of users) run('INSERT OR IGNORE INTO notifications(id,version_id,kind,round,recipient_id,detail,created_at) VALUES(?,?,?,?,?,?,?)',uid(),version.id,action,eventSequence,user.id,messageDetail,now());
    if (!users.length) run('INSERT OR IGNORE INTO notifications(id,version_id,kind,round,recipient_id,status,error,detail,created_at) VALUES(?,?,?,?,?,?,?,?,?)',uid(),version.id,action,eventSequence,'','skipped','没有可通知的对应人员',messageDetail,now());
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
      const calendarFilter = one("SELECT 1 FROM sqlite_master WHERE type='table' AND name='requirement_calendar'")
        ? "AND (kind<>'requirement_calendar' OR EXISTS(SELECT 1 FROM requirement_calendar c WHERE c.requirement_id=notifications.requirement_id AND c.status='synced' AND c.event_id<>''))"
        : "AND kind<>'requirement_calendar'";
      for(const job of all(`SELECT * FROM notifications WHERE status='pending' AND next_at<=? ${calendarFilter} ORDER BY created_at LIMIT 10`,Date.now())) {
        if (['requirement_publish', 'requirement_calendar'].includes(job.kind)) { await sendRequirement(job); continue; }
        const version=one('SELECT * FROM versions WHERE id=?',job.version_id), asset=version&&one('SELECT * FROM assets WHERE id=?',version.asset_id), owner=asset&&one('SELECT * FROM users WHERE id=?',asset.owner_id), recipient=one('SELECT * FROM users WHERE id=?',job.recipient_id);
        const roles=recipient?parse(recipient.roles,[]):[], isOwner=recipient?.id===owner?.id, isSupervisor=recipient?.id===version?.reviewer_id&&roles.includes('supervisor'), isPm=roles.includes('pm'), isCc=!!one('SELECT 1 FROM version_cc WHERE version_id=? AND user_id=?',version?.id||'',recipient?.id||'');
        const isBusinessPublisher=publicationActions.includes(job.kind)&&roles.includes('business')&&!!one('SELECT 1 FROM requirements r JOIN asset_requirements ar ON ar.requirement_id=r.id WHERE ar.asset_id=? AND r.publisher_id=? LIMIT 1',asset?.id||'',recipient?.id||'');
        const detail=parse(job.detail,{});
        const stateOk=({submit:version?.status==='pending'&&version.submission_count===job.round,withdraw:version?.status==='draft',reject:version?.status==='returned',publish:version?.status==='published',unpublish:version?.status==='offline',restore:version?.status==='published',set_default:version?.status==='published'&&asset?.current_version_id===version?.id,description_generated:!!version})[job.kind];
        const audienceOk=job.kind==='description_generated'?true:['submit','withdraw'].includes(job.kind)?isSupervisor:job.kind==='reject'?isOwner:isOwner||isPm||isBusinessPublisher||(job.kind==='publish'&&isCc);
        if(!version||!recipient?.enabled||recipient.deleted_at||!audienceOk||!stateOk||recipient.open_id.startsWith('preview:')) { run("UPDATE notifications SET status='skipped',error=? WHERE id=?",'状态或接收人权限已变化，已取消通知',job.id); continue; }
        try {
          const bearer=await tokenFor(), title=parse(version.description).title||'未命名 Demo', [heading,body]=messageTemplates[job.kind];
          const requirementText=detail.requirements?.length?`\n关联需求（发布时）：\n${detail.requirements.map(requirement=>`- ${requirement.title}`).join('\n')}`:'';
          const text=`【${heading}】\n${title}\n版本：V${version.number}\n归属员工：${owner.name}\n${body}${requirementText}${detail.reason?`\n处理意见：${detail.reason}`:''}\n点击进入飞书应用：${feishuAppLink(config.appId,asset.id)}`;
          const response=await call('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${bearer}`},signal:AbortSignal.timeout(15000),body:JSON.stringify({receive_id:recipient.open_id,msg_type:'text',content:JSON.stringify({text}),uuid:job.id})});
          const data=await response.json(); if(!response.ok||data.code!==0){token='';throw new Error(`飞书发送失败 (${data.code||response.status})，请检查机器人、发送消息权限及应用可用范围`);}
          run("UPDATE notifications SET status='sent',attempts=attempts+1,sent_at=?,error='' WHERE id=?",now(),job.id);
        } catch(error) { const attempts=job.attempts+1; run('UPDATE notifications SET status=?,attempts=?,next_at=?,error=? WHERE id=?',attempts>=5?'failed':'pending',attempts,Date.now()+Math.min(300000,15000*2**attempts),error.message.startsWith('飞书')||error.message.startsWith('未配置')?error.message:'网络请求失败，请稍后重试',job.id); }
      }
    } finally { busy=false; }
  }
  async function sendRequirement(job) {
    const requirement = one('SELECT * FROM requirements WHERE id=?', job.requirement_id), recipient = one('SELECT * FROM users WHERE id=?', job.recipient_id);
    const allowed = requirement && (requirement.publisher_id === recipient?.id || one('SELECT 1 FROM requirement_assignees WHERE requirement_id=? AND user_id=?', requirement.id, recipient?.id || ''));
    if (!allowed || !recipient?.enabled || recipient.deleted_at || recipient.open_id.startsWith('preview:')) {
      run("UPDATE notifications SET status='skipped',error=? WHERE id=?", '需求或接收人权限已变化，已取消通知', job.id); return;
    }
    const calendar = job.kind === 'requirement_calendar' ? one('SELECT * FROM requirement_calendar WHERE requirement_id=?', requirement.id) : null;
    if (job.kind === 'requirement_calendar' && (!calendar || calendar.status !== 'synced' || !calendar.event_id)) return;
    try {
      const bearer = await tokenFor(), detail = parse(job.detail);
      const ownerText = detail.businessNames || detail.developmentNames ? `商务负责人：${detail.businessNames?.join('、') || '未指定'}\n研发负责人：${detail.developmentNames?.join('、') || '未指定'}` : `负责人：${detail.assignedNames?.join('、') || '未指定'}`;
      const publishDate = detail.publishDate || detail.plannedDate;
      const text = `【新需求已发布】\n${detail.title}\n发布人：${detail.publisher}\n${ownerText}${publishDate ? `\n发布日期：${publishDate}\n截止日期：${detail.deadlineDate || '未设置'}` : ''}\n请查看需求详情：${feishuRequirementLink(config.appId, requirement.id)}`;
      const message = calendar ? { msg_type: 'interactive', content: JSON.stringify(requirementCalendarCard(requirement, calendar)) } : { msg_type: 'text', content: JSON.stringify({ text }) };
      const response = await call('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bearer}` }, signal: AbortSignal.timeout(15000), body: JSON.stringify({ receive_id: recipient.open_id, ...message, uuid: job.id }) });
      const data = await response.json();
      if (!response.ok || data.code !== 0) { token = ''; throw new Error(`飞书发送失败 (${data.code || response.status})，请检查机器人、发送消息权限及应用可用范围`); }
      run("UPDATE notifications SET status='sent',attempts=attempts+1,sent_at=?,error='' WHERE id=?", now(), job.id);
    } catch (error) {
      const attempts = job.attempts + 1;
      run('UPDATE notifications SET status=?,attempts=?,next_at=?,error=? WHERE id=?', attempts >= 5 ? 'failed' : 'pending', attempts, Date.now() + Math.min(300000, 15000 * 2 ** attempts), error.message.startsWith('飞书') || error.message.startsWith('未配置') ? error.message : '网络请求失败，请稍后重试', job.id);
    }
  }
  function requirementCalendarCard(requirement, calendar) {
    const publisher = one('SELECT name FROM users WHERE id=?', requirement.publisher_id);
    const owners = all('SELECT u.name,ra.responsibility FROM users u JOIN requirement_assignees ra ON ra.user_id=u.id WHERE ra.requirement_id=? AND u.enabled=1 AND u.deleted_at IS NULL ORDER BY u.name,u.id', requirement.id), groups = splitRequirementOwners(owners);
    const appLink = safeFeishuAppLink(calendar.app_link), plain = content => ({ tag: 'plain_text', content });
    return {
      config: { wide_screen_mode: true, enable_forward: false },
      header: { template: 'blue', title: plain('需求日程已创建') },
      elements: [
        { tag: 'div', text: plain(requirement.title) },
        { tag: 'div', fields: [
          ['发布人', publisher.name], ['发布日期', requirement.planned_date || requirementDate(requirement.created_at)],
          ['截止日期', requirement.deadline_date || '未设置'],
          ['商务负责人', groups.businessOwners.map(user => user.name).join('、') || '未指定'],
          ['研发负责人', groups.developmentOwners.map(user => user.name).join('、') || '未指定']
        ].map(([label, value]) => ({ is_short: false, text: plain(`${label}：${value}`) })) },
        { tag: 'note', elements: [plain('已发送日程邀请。日程为北京时间全天，不占用忙闲时间；如飞书提示，请接受邀请。')] },
        { tag: 'action', actions: [
          ...(appLink ? [{ tag: 'button', text: plain('打开飞书日程'), type: 'primary', url: appLink }] : []),
          { tag: 'button', text: plain('查看需求'), type: appLink ? 'default' : 'primary', url: feishuRequirementLink(config.appId, requirement.id) }
        ] }
      ]
    };
  }
  const list=()=>all('SELECT n.*,u.name AS recipient FROM notifications n LEFT JOIN users u ON u.id=n.recipient_id ORDER BY n.created_at DESC LIMIT 100');
  function requirementCalendarSummary(id) {
    const counts = { pending: 0, sent: 0, failed: 0, skipped: 0 };
    for (const row of all("SELECT status,COUNT(*) AS count FROM notifications WHERE requirement_id=? AND kind='requirement_calendar' GROUP BY status", id)) counts[row.status] = row.count;
    return counts;
  }
  return {enqueue,enqueueDirect,enqueueRequirement,enqueueRequirementCalendar,requirementCalendarSummary,drain,list,start(){const timer=setInterval(()=>drain().catch(()=>console.error('Notification worker failed')),5000);timer.unref();return()=>clearInterval(timer);}};
}
