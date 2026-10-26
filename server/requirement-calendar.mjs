import { uid, now } from './db.mjs';
import { feishuRequirementLink } from './notifications.mjs';
import { requirementDate, nextRequirementDate } from '../shared/requirement-schedule.mjs';
import { splitRequirementOwners } from '../shared/requirement-owners.mjs';
import { safeFeishuAppLink as safeAppLink } from '../shared/feishu-links.mjs';

const statusLabels = { open: '进行中', needs_update: '待更新', delivered: '已交付', closed: '已关闭' };
export function createRequirementCalendar(store, config, notifications) {
  const { one, all, run, tx } = store;
  store.db.exec(`CREATE TABLE IF NOT EXISTS requirement_calendar (
    requirement_id TEXT PRIMARY KEY REFERENCES requirements(id), event_key TEXT NOT NULL,
    calendar_id TEXT NOT NULL DEFAULT '', event_id TEXT NOT NULL DEFAULT '', app_link TEXT NOT NULL DEFAULT '',
    generation INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
    next_at INTEGER NOT NULL DEFAULT 0, error TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL, synced_at TEXT
  ); CREATE INDEX IF NOT EXISTS requirement_calendar_pending ON requirement_calendar(status,next_at);`);
  function enqueue(id) {
    run(`INSERT INTO requirement_calendar(requirement_id,event_key,updated_at) VALUES(?,?,?)
      ON CONFLICT(requirement_id) DO UPDATE SET generation=generation+1,status='pending',attempts=0,next_at=0,error='',updated_at=excluded.updated_at`, id, uid(), now());
  }
  tx(() => {
    const refreshLayout = one("SELECT value FROM metadata WHERE key='requirement_calendar_fields_version'")?.value !== '2';
    for (const requirement of all(refreshLayout ? 'SELECT id FROM requirements' : 'SELECT id FROM requirements WHERE id NOT IN (SELECT requirement_id FROM requirement_calendar)')) enqueue(requirement.id);
    run("INSERT OR REPLACE INTO metadata(key,value) VALUES('requirement_calendar_fields_version','2')");
  });
  const participants = id => all(`SELECT u.* FROM users u WHERE u.enabled=1 AND u.deleted_at IS NULL AND
    (u.id=(SELECT publisher_id FROM requirements WHERE id=?) OR EXISTS(SELECT 1 FROM requirement_assignees ra WHERE ra.requirement_id=? AND ra.user_id=u.id)) ORDER BY u.name,u.id`, id, id).filter(user => !user.open_id.startsWith('preview:'));
  function enqueueForUser(userId) {
    for (const requirement of all('SELECT id FROM requirements r WHERE publisher_id=? OR EXISTS(SELECT 1 FROM requirement_assignees ra WHERE ra.requirement_id=r.id AND ra.user_id=?)', userId, userId)) enqueue(requirement.id);
  }
  function info(id) {
    const job = one('SELECT status,error,app_link,synced_at FROM requirement_calendar WHERE requirement_id=?', id);
    return job ? { status: job.status, error: job.error, appLink: safeAppLink(job.app_link), syncedAt: job.synced_at, messages: notifications.requirementCalendarSummary(id) } : null;
  }
  const list = () => all('SELECT c.*,r.title FROM requirement_calendar c JOIN requirements r ON r.id=c.requirement_id ORDER BY c.updated_at DESC LIMIT 100').map(job => ({ ...job, app_link: safeAppLink(job.app_link) }));
  function retry(id) {
    return run("UPDATE requirement_calendar SET status='pending',attempts=0,next_at=0,error='',updated_at=? WHERE requirement_id=? AND status='failed'", now(), id).changes > 0;
  }
  const call = config.calendarFetch || fetch;
  let token = '', expires = 0, running = null;
  async function tokenFor() {
    if (token && expires > Date.now()) return token;
    if (!config.appId || !config.appSecret) throw new Error('未配置飞书应用凭据');
    const response = await call('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(15000), body: JSON.stringify({ app_id: config.appId, app_secret: config.appSecret }) });
    const data = await response.json();
    if (!response.ok || data.code !== 0 || !data.tenant_access_token) throw new Error(`飞书应用鉴权失败 (${data.code || response.status})`);
    token = data.tenant_access_token; expires = Date.now() + Math.max(0, (data.expire || 7200) - 120) * 1000;
    return token;
  }
  async function request(resource, method = 'GET', body) {
    const bearer = await tokenFor();
    const response = await call('https://open.feishu.cn/open-apis/calendar/v4/' + resource, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bearer}` }, signal: AbortSignal.timeout(15000), ...(body ? { body: JSON.stringify(body) } : {}) });
    const data = await response.json();
    if (!response.ok || data.code !== 0) {
      token = '';
      if (data.code === 99991672) throw new Error('飞书应用缺少日历接口权限 (99991672)，请应用管理员在飞书开放平台开通对应的应用身份权限并发布新版本，再重试同步');
      throw new Error(`飞书日历同步失败 (${data.code || response.status})，请检查日历权限、机器人能力及应用可用范围`);
    }
    return data.data || {};
  }
  let checkedCalendarId = '';
  async function calendarFor(job) {
    if (job.calendar_id) return job.calendar_id;
    const key = 'requirement_calendar:' + config.appId;
    let id = config.requirementCalendarId || one('SELECT value FROM metadata WHERE key=?', key)?.value;
    if (!id) {
      const data = await request('calendars', 'POST', { summary: 'PRT 需求协作', description: 'PRT 数据平台需求日程，由应用自动维护。', permissions: 'private' });
      id = data.calendar?.calendar_id;
      if (!id) throw new Error('飞书创建日历未返回日历 ID');
      run('INSERT OR REPLACE INTO metadata(key,value) VALUES(?,?)', key, id);
      checkedCalendarId = id;
    }
    if (id !== checkedCalendarId) {
      const calendar = await request('calendars/' + encodeURIComponent(id));
      if (calendar.permissions !== 'private' || !['writer', 'owner'].includes(calendar.role) || !['shared', 'primary'].includes(calendar.type)) throw new Error('飞书需求日历必须为私密日历，并授权当前应用 writer 或 owner 权限');
      checkedCalendarId = id;
    }
    run('UPDATE requirement_calendar SET calendar_id=? WHERE requirement_id=?', id, job.requirement_id);
    return id;
  }
  function eventData(requirement) {
    const publisher = one('SELECT name FROM users WHERE id=?', requirement.publisher_id);
    const owners = all('SELECT u.name,ra.responsibility FROM users u JOIN requirement_assignees ra ON ra.user_id=u.id WHERE ra.requirement_id=? AND u.enabled=1 AND u.deleted_at IS NULL ORDER BY u.name,u.id', requirement.id), groups = splitRequirementOwners(owners);
    const date = requirement.planned_date || requirementDate(requirement.created_at), deadline = requirement.deadline_date || '';
    return { summary: `【需求·${statusLabels[requirement.status]}】${requirement.title}`, description: `发布人：${publisher.name}\n发布日期：${date}\n截止日期：${deadline || '未设置'}\n商务负责人：${groups.businessOwners.map(user => user.name).join('、') || '未指定'}\n研发负责人：${groups.developmentOwners.map(user => user.name).join('、') || '未指定'}\n查看需求：${feishuRequirementLink(config.appId, requirement.id)}`, start_time: { date }, end_time: { date: nextRequirementDate(deadline || date) }, visibility: 'private', attendee_ability: 'none', free_busy_status: 'free', need_notification: true };
  }
  async function sync(job) {
    const requirement = one('SELECT * FROM requirements WHERE id=?', job.requirement_id);
    if (!requirement) return;
    const calendarId = await calendarFor(job), root = 'calendars/' + encodeURIComponent(calendarId) + '/events';
    let eventId = job.event_id;
    if (!eventId) {
      const data = await request(root + '?' + new URLSearchParams({ idempotency_key: job.event_key, user_id_type: 'open_id' }), 'POST', eventData(requirement));
      eventId = data.event?.event_id;
      if (!eventId) throw new Error('飞书创建日程未返回日程 ID');
      run('UPDATE requirement_calendar SET event_id=?,app_link=? WHERE requirement_id=?', eventId, safeAppLink(data.event.app_link), requirement.id);
    }
    const eventRoot = root + '/' + encodeURIComponent(eventId), existing = [];
    let pageToken = '';
    do {
      const params = new URLSearchParams({ user_id_type: 'open_id', page_size: '100', ...(pageToken ? { page_token: pageToken } : {}) });
      const data = await request(eventRoot + '/attendees?' + params);
      existing.push(...(data.items || []));
      if (data.has_more && (!data.page_token || data.page_token === pageToken)) throw new Error('飞书日程参与人分页异常，请稍后重试');
      pageToken = data.has_more ? data.page_token : '';
    } while (pageToken);
    const desired = participants(requirement.id), desiredIds = new Set(desired.map(user => user.open_id));
    const removed = existing.filter(attendee => attendee.type === 'user' && !attendee.is_organizer && !desiredIds.has(attendee.user_id));
    for (let offset = 0; offset < removed.length; offset += 50) await request(eventRoot + '/attendees/batch_delete?user_id_type=open_id', 'POST', { attendee_ids: removed.slice(offset, offset + 50).map(attendee => attendee.attendee_id), need_notification: true });
    const data = await request(eventRoot + '?user_id_type=open_id', 'PATCH', eventData(one('SELECT * FROM requirements WHERE id=?', requirement.id)));
    if (data.event?.app_link) run('UPDATE requirement_calendar SET app_link=? WHERE requirement_id=?', safeAppLink(data.event.app_link), requirement.id);
    const added = participants(requirement.id).filter(user => !existing.some(attendee => attendee.user_id === user.open_id));
    for (let offset = 0; offset < added.length; offset += 50) await request(eventRoot + '/attendees?user_id_type=open_id', 'POST', { attendees: added.slice(offset, offset + 50).map(user => ({ type: 'user', user_id: user.open_id })), need_notification: true });
    tx(() => {
      const result = run("UPDATE requirement_calendar SET status='synced',attempts=0,error='',synced_at=? WHERE requirement_id=? AND generation=?", now(), requirement.id, job.generation);
      if (result.changes) notifications.enqueueRequirementCalendar(one('SELECT * FROM requirements WHERE id=?', requirement.id));
    });
  }
  async function processJobs() {
    for (const job of all("SELECT * FROM requirement_calendar WHERE status='pending' AND next_at<=? ORDER BY updated_at,requirement_id LIMIT 10", Date.now())) {
      try { await sync(job); }
      catch (error) {
        const attempts = job.attempts + 1;
        const message = /^(飞书|未配置)/.test(error.message) ? error.message : '日历网络请求失败，请稍后重试';
        run('UPDATE requirement_calendar SET status=?,attempts=?,next_at=?,error=? WHERE requirement_id=? AND generation=?', attempts >= 5 ? 'failed' : 'pending', attempts, Date.now() + Math.min(300000, 15000 * 2 ** attempts), message, job.requirement_id, job.generation);
      }
    }
  }
  function drain() {
    if (config.demoMode) return Promise.resolve();
    if (!running) running = processJobs().finally(() => { running = null; });
    return running;
  }
  return { enqueue, enqueueForUser, info, list, retry, drain, start() { const timer = setInterval(() => drain().catch(() => console.error('Requirement calendar worker failed')), 5000); timer.unref(); return () => { clearInterval(timer); return running; }; } };
}
