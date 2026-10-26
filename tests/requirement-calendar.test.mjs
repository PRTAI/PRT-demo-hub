import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore, uid, now } from '../server/db.mjs';
import { seedPreview } from '../server/seed.mjs';
import { createRequirementCalendar } from '../server/requirement-calendar.mjs';
import { createNotifications, feishuRequirementLink } from '../server/notifications.mjs';
import { requirementDate, validRequirementDate, nextRequirementDate } from '../shared/requirement-schedule.mjs';

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prt-calendar-test-'));
  const ctx = { root, store: openStore(root), calls: [], events: new Map(), attendees: new Map(), messages: [], controls: {} };
  t.after(() => { ctx.store.db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  seedPreview(ctx.store);
  ctx.id = ctx.store.one('SELECT id FROM requirements').id;
  ctx.store.run("UPDATE users SET open_id='ou_' || id");
  ctx.store.run('DELETE FROM requirement_assignees');
  for (const id of ['preview-employee', 'preview-pm']) ctx.store.run('INSERT INTO requirement_assignees(requirement_id,user_id,assigned_by,created_at) VALUES(?,?,?,?)', ctx.id, id, 'preview-pm', now());
  ctx.store.run('UPDATE requirements SET planned_date=?,created_at=? WHERE id=?', '2027-12-31', '2027-12-30T16:30:00.000Z', ctx.id);
  ctx.config = { demoMode: false, appId: 'cli_mock', appSecret: 'secret_mock', calendarFetch: async (value, options) => {
    const url = new URL(value), method = options.method, body = options.body ? JSON.parse(options.body) : null;
    ctx.calls.push({ url, method, body });
    if (ctx.controls.onRequest) await ctx.controls.onRequest({ url, method, body });
    const response = data => ({ ok: true, json: async () => ({ code: 0, data }) });
    if (url.pathname.includes('tenant_access_token')) return { ok: true, json: async () => ({ code: 0, tenant_access_token: 'token_mock', expire: 7200 }) };
    assert.equal(options.headers.Authorization, 'Bearer token_mock');
    if (url.pathname.endsWith('/calendars') && method === 'POST') return response({ calendar: { calendar_id: 'calendar_mock' } });
    if (/\/calendars\/[^/]+$/.test(url.pathname) && method === 'GET') return response({ calendar_id: 'calendar_mock', permissions: ctx.controls.publicCalendar ? 'public' : 'private', role: 'owner', type: 'shared' });
    if (url.pathname.endsWith('/events') && method === 'POST') {
      const key = url.searchParams.get('idempotency_key'); assert.ok(key);
      if (!ctx.events.has(key)) ctx.events.set(key, { ...body, event_id: 'event_mock', app_link: 'https://applink.feishu.cn/client/calendar/event/detail?event_id=event_mock' });
      if (ctx.controls.failCreateResponse) { ctx.controls.failCreateResponse--; throw new Error('network response lost'); }
      return response({ event: ctx.events.get(key) });
    }
    if (url.pathname.endsWith('/events/event_mock') && method === 'PATCH') {
      const event = ctx.events.values().next().value; Object.assign(event, body);
      return response({ event });
    }
    if (url.pathname.endsWith('/attendees') && method === 'GET') {
      assert.equal(url.searchParams.get('user_id_type'), 'open_id');
      return response({ items: [...ctx.attendees.values()], has_more: false });
    }
    if (url.pathname.endsWith('/attendees') && method === 'POST') {
      if (ctx.controls.failInvite) { ctx.controls.failInvite--; throw new Error('network failure with secret_mock'); }
      for (const attendee of body.attendees) ctx.attendees.set(attendee.user_id, { ...attendee, attendee_id: 'attendee_' + attendee.user_id, is_organizer: false });
      return response({ attendees: [...ctx.attendees.values()] });
    }
    if (url.pathname.endsWith('/attendees/batch_delete') && method === 'POST') {
      for (const [id, attendee] of ctx.attendees) if (body.attendee_ids.includes(attendee.attendee_id)) ctx.attendees.delete(id);
      return response({});
    }
    throw new Error('Unexpected mock request ' + method + ' ' + url.pathname);
  }, ...options };
  ctx.config.notificationFetch = async (url, options) => {
    if (url.includes('tenant_access_token')) return { ok: true, json: async () => ({ code: 0, tenant_access_token: 'message_token', expire: 7200 }) };
    assert.ok(url.startsWith('https://open.feishu.cn/open-apis/im/v1/messages'));
    const message = JSON.parse(options.body); ctx.messages.push(message);
    if (ctx.controls.failMessageResponse) { ctx.controls.failMessageResponse--; throw new Error('lost response secret_mock'); }
    const code = ctx.controls.failMessages ? 230013 : 0;
    return { ok: true, json: async () => ({ code }) };
  };
  ctx.notifications = createNotifications(ctx.store, ctx.config);
  ctx.calendar = createRequirementCalendar(ctx.store, ctx.config, ctx.notifications);
  ctx.job = () => ctx.store.one('SELECT * FROM requirement_calendar WHERE requirement_id=?', ctx.id);
  ctx.ready = () => ctx.store.run('UPDATE requirement_calendar SET next_at=0');
  return ctx;
}

test('requirement schedule uses China dates, validates dates and handles exclusive all-day end dates', () => {
  assert.equal(requirementDate('2027-12-31T16:01:00Z'), '2028-01-01');
  assert.equal(requirementDate('2027-12-31T15:59:00Z'), '2027-12-31');
  assert.equal(validRequirementDate('2028-02-29'), true); assert.equal(validRequirementDate('2027-02-29'), false);
  assert.equal(validRequirementDate('2027-4-01'), false); assert.equal(nextRequirementDate('2028-02-29'), '2028-03-01');
  assert.equal(nextRequirementDate('2027-12-31'), '2028-01-01');
  const link = new URL(feishuRequirementLink('cli_test', 'requirement_test'));
  assert.equal(link.searchParams.get('path'), '/?view=requirements&requirement=requirement_test');
});

test('calendar backfills old requirements and creates private all-day events with deduplicated publisher and owners', async t => {
  const ctx = fixture(t);
  assert.equal(ctx.calendar.info(ctx.id).status, 'pending');
  await Promise.all([ctx.calendar.drain(), ctx.calendar.drain()]);
  assert.equal(ctx.calendar.info(ctx.id).status, 'synced'); assert.equal(ctx.events.size, 1);
  const event = ctx.events.values().next().value;
  assert.deepEqual(event.start_time, { date: '2027-12-31' }); assert.deepEqual(event.end_time, { date: '2028-01-01' });
  assert.equal(event.visibility, 'private'); assert.equal(event.free_busy_status, 'free'); assert.equal(event.attendee_ability, 'none');
  assert.ok(event.description.includes('负责人：')); assert.ok(event.description.includes(ctx.id));
  assert.ok(!event.description.includes('准备可复用的合成数据'));
  assert.deepEqual(new Set(ctx.attendees.keys()), new Set(['ou_preview-pm', 'ou_preview-employee']));
  const invitation = ctx.calls.find(call => call.method === 'POST' && call.url.pathname.endsWith('/attendees'));
  assert.equal(invitation.body.need_notification, true); assert.equal(invitation.body.attendees.length, 2);
  assert.equal(ctx.calls.find(call => call.url.pathname.endsWith('/calendars')).body.permissions, 'private');
  assert.ok(ctx.calendar.info(ctx.id).appLink.startsWith('https://applink.feishu.cn/'));
  const count = ctx.calls.length; await ctx.calendar.drain(); assert.equal(ctx.calls.length, count);
  assert.equal(ctx.store.one("SELECT COUNT(*) AS count FROM notifications WHERE kind='requirement_publish'").count, 0);
  assert.equal(ctx.store.one("SELECT COUNT(*) AS count FROM notifications WHERE kind='requirement_calendar'").count, 2);
});

test('calendar persists event IDs before invites and resumes failed invitations after reopening SQLite without duplicate events', async t => {
  const ctx = fixture(t); ctx.controls.failInvite = 1;
  await ctx.calendar.drain();
  assert.equal(ctx.job().event_id, 'event_mock'); assert.equal(ctx.job().status, 'pending'); assert.equal(ctx.job().attempts, 1);
  assert.ok(!ctx.job().error.includes('secret_mock')); assert.equal(ctx.events.size, 1);
  const key = ctx.job().event_key;
  ctx.store.db.close(); ctx.store = openStore(ctx.root); ctx.notifications = createNotifications(ctx.store, ctx.config); ctx.calendar = createRequirementCalendar(ctx.store, ctx.config, ctx.notifications);
  assert.equal(ctx.job().event_key, key); ctx.ready(); await ctx.calendar.drain();
  assert.equal(ctx.job().status, 'synced'); assert.equal(ctx.events.size, 1); assert.equal(ctx.attendees.size, 2);
  assert.equal(ctx.calls.filter(call => call.url.pathname.endsWith('/events') && call.method === 'POST').length, 1);
});

test('calendar create retries use the persisted idempotency key if the response is lost', async t => {
  const ctx = fixture(t); ctx.controls.failCreateResponse = 1;
  await ctx.calendar.drain(); assert.equal(ctx.job().event_id, ''); assert.equal(ctx.events.size, 1);
  ctx.ready(); await ctx.calendar.drain();
  const creates = ctx.calls.filter(call => call.url.pathname.endsWith('/events') && call.method === 'POST');
  assert.equal(creates.length, 2); assert.equal(creates[0].url.searchParams.get('idempotency_key'), creates[1].url.searchParams.get('idempotency_key'));
  assert.equal(ctx.events.size, 1); assert.equal(ctx.job().status, 'synced');
});

test('calendar updates existing events, adds forwarded owners and removes revoked or disabled participants', async t => {
  const ctx = fixture(t); await ctx.calendar.drain();
  ctx.store.run('INSERT INTO requirement_assignees(requirement_id,user_id,assigned_by,created_at) VALUES(?,?,?,?)', ctx.id, 'preview-colleague', 'preview-pm', now());
  ctx.calendar.enqueue(ctx.id); await ctx.calendar.drain(); assert.equal(ctx.attendees.size, 3);
  ctx.store.run('DELETE FROM requirement_assignees WHERE requirement_id=? AND user_id=?', ctx.id, 'preview-employee');
  ctx.store.run('UPDATE users SET enabled=0 WHERE id=?', 'preview-colleague');
  ctx.store.run("UPDATE requirements SET title='需求修订标题',status='needs_update',planned_date='2028-02-29' WHERE id=?", ctx.id);
  ctx.calendar.enqueue(ctx.id); await ctx.calendar.drain();
  assert.deepEqual([...ctx.attendees.keys()], ['ou_preview-pm']); assert.equal(ctx.events.size, 1);
  const event = ctx.events.values().next().value;
  assert.ok(event.summary.includes('待更新')); assert.ok(event.summary.includes('需求修订标题'));
  assert.deepEqual(event.end_time, { date: '2028-03-01' }); assert.ok(!event.description.includes('陈思远'));
  assert.ok(ctx.calls.some(call => call.url.pathname.endsWith('/attendees/batch_delete')));
});

test('calendar distinguishes owner groups and spans publication through deadline inclusively while updating the same event', async testContext => {
  const ctx = fixture(testContext);
  ctx.store.run('UPDATE requirements SET deadline_date=? WHERE id=?', '2028-01-02', ctx.id);
  ctx.store.run("UPDATE users SET roles='[\"business\",\"pm\"]' WHERE id='preview-pm'");
  ctx.store.run("UPDATE requirement_assignees SET responsibility='both' WHERE requirement_id=? AND user_id='preview-pm'", ctx.id);
  await ctx.calendar.drain();
  const event = ctx.events.values().next().value, key = ctx.job().event_key;
  assert.deepEqual(event.start_time, { date: '2027-12-31' }); assert.deepEqual(event.end_time, { date: '2028-01-03' });
  assert.ok(event.description.includes('发布日期：2027-12-31')); assert.ok(event.description.includes('截止日期：2028-01-02'));
  assert.ok(event.description.includes('商务负责人：周亦舒')); assert.ok(event.description.includes('研发负责人：'));
  assert.ok(event.description.includes('陈思远')); assert.equal(ctx.attendees.size, 2);
  ctx.store.run("UPDATE requirements SET deadline_date='' WHERE id=?", ctx.id);
  ctx.calendar.enqueue(ctx.id); await ctx.calendar.drain();
  assert.deepEqual(event.end_time, { date: '2028-01-01' }); assert.ok(event.description.includes('截止日期：未设置'));
  assert.equal(ctx.events.size, 1); assert.equal(ctx.job().event_key, key); assert.equal(ctx.job().event_id, 'event_mock');
});

test('calendar field upgrade resynchronizes existing events once without duplicate events or historical notifications', async testContext => {
  const ctx = fixture(testContext); await ctx.calendar.drain();
  const key = ctx.job().event_key, generation = ctx.job().generation;
  ctx.store.run("DELETE FROM metadata WHERE key='requirement_calendar_fields_version'");
  ctx.calendar = createRequirementCalendar(ctx.store, ctx.config, ctx.notifications);
  assert.equal(ctx.job().status, 'pending'); assert.equal(ctx.job().generation, generation + 1);
  assert.equal(ctx.job().event_key, key); assert.equal(ctx.job().event_id, 'event_mock');
  await ctx.calendar.drain();
  ctx.calendar = createRequirementCalendar(ctx.store, ctx.config, ctx.notifications);
  assert.equal(ctx.job().status, 'synced'); assert.equal(ctx.job().generation, generation + 1);
  assert.equal(ctx.calls.filter(call => call.url.pathname.endsWith('/events') && call.method === 'POST').length, 1);
  assert.equal(ctx.store.one("SELECT COUNT(*) AS count FROM notifications WHERE kind='requirement_publish'").count, 0);
  assert.equal(ctx.store.one("SELECT COUNT(*) AS count FROM notifications WHERE kind='requirement_calendar'").count, 2);
});

test('calendar keeps a new pending generation when requirements change during an in-flight sync', async t => {
  const ctx = fixture(t); await ctx.calendar.drain(); ctx.calendar.enqueue(ctx.id);
  let changed = false;
  ctx.controls.onRequest = ({ method }) => {
    if (method === 'PATCH' && !changed) { changed = true; ctx.store.run("UPDATE requirements SET title='同步期间修改' WHERE id=?", ctx.id); ctx.calendar.enqueue(ctx.id); }
  };
  await ctx.calendar.drain(); assert.equal(ctx.job().status, 'pending');
  await ctx.calendar.drain(); assert.equal(ctx.job().status, 'synced');
  assert.ok(ctx.events.values().next().value.summary.includes('同步期间修改')); assert.equal(ctx.events.size, 1);
});

test('calendar failures stop after five attempts, support manual retry and do not run in preview', async t => {
  const ctx = fixture(t, { appId: '', appSecret: '' });
  for (let attempt = 0; attempt < 5; attempt++) { ctx.ready(); await ctx.calendar.drain(); }
  assert.equal(ctx.job().status, 'failed'); assert.equal(ctx.job().attempts, 5); assert.equal(ctx.calls.length, 0);
  assert.equal(ctx.calendar.retry(ctx.id), true); assert.equal(ctx.job().attempts, 0);
  ctx.config.appId = 'cli_mock'; ctx.config.appSecret = 'secret_mock'; await ctx.calendar.drain();
  assert.equal(ctx.job().status, 'synced'); assert.equal(ctx.calendar.retry(ctx.id), false);
  ctx.config.demoMode = true; ctx.calendar.enqueue(ctx.id); const count = ctx.calls.length;
  await ctx.calendar.drain(); assert.equal(ctx.calls.length, count); assert.equal(ctx.job().status, 'pending');
});

test('calendar refuses an explicitly configured public calendar and rejects unsafe returned app links', async t => {
  const ctx = fixture(t, { requirementCalendarId: 'calendar_mock' }); ctx.controls.publicCalendar = true;
  await ctx.calendar.drain(); assert.equal(ctx.job().status, 'pending'); assert.ok(ctx.job().error.includes('私密日历')); assert.equal(ctx.events.size, 0);
  ctx.controls.publicCalendar = false; ctx.ready(); await ctx.calendar.drain(); assert.equal(ctx.job().status, 'synced');
  for (const link of ['javascript:alert(1)', 'https://applink.feishu.cn.attacker.example/path', 'https://user:pass@feishu.cn/path']) {
    ctx.store.run('UPDATE requirement_calendar SET app_link=? WHERE requirement_id=?', link, ctx.id);
    assert.equal(ctx.calendar.info(ctx.id).appLink, ''); assert.equal(ctx.calendar.list()[0].app_link, '');
  }
});

test('calendar identifies missing Feishu app permissions without exposing the raw response or credentials', async t => {
  const ctx = fixture(t, { calendarFetch: async url => {
    if (url.includes('tenant_access_token')) return { ok: true, json: async () => ({ code: 0, tenant_access_token: 'token_mock', expire: 7200 }) };
    return { ok: true, json: async () => ({ code: 99991672, msg: 'Access denied with raw secret_mock token_mock' }) };
  } });
  await ctx.calendar.drain();
  assert.equal(ctx.job().status, 'pending'); assert.equal(ctx.job().attempts, 1);
  assert.ok(ctx.job().error.includes('99991672')); assert.ok(ctx.job().error.includes('飞书应用缺少日历接口权限'));
  assert.ok(ctx.job().error.includes('发布新版本')); assert.ok(!ctx.job().error.includes('secret_mock')); assert.ok(!ctx.job().error.includes('token_mock'));
});

test('successful calendar invitations queue deduplicated actionable cards and subsequent syncs only notify new owners', async t => {
  const ctx = fixture(t);
  assert.equal(ctx.notifications.list().length, 0);
  await ctx.notifications.drain(); assert.equal(ctx.messages.length, 0);
  ctx.controls.failInvite = 1;
  await ctx.calendar.drain();
  assert.equal(ctx.notifications.list().length, 0); assert.equal(ctx.calendar.info(ctx.id).status, 'pending');
  ctx.ready(); await ctx.calendar.drain();
  assert.deepEqual(ctx.calendar.info(ctx.id).messages, { pending: 2, sent: 0, failed: 0, skipped: 0 });
  await ctx.notifications.drain();
  assert.equal(ctx.messages.length, 2);
  assert.deepEqual(new Set(ctx.messages.map(item => item.receive_id)), new Set(['ou_preview-pm', 'ou_preview-employee']));
  const card = JSON.parse(ctx.messages[0].content);
  assert.equal(ctx.messages[0].msg_type, 'interactive'); assert.equal(card.header.title.content, '需求日程已创建');
  assert.equal(card.config.enable_forward, false);
  const content = JSON.stringify(card);
  assert.ok(content.includes('发布日期：2027-12-31')); assert.ok(content.includes('截止日期：未设置'));
  assert.ok(content.includes('商务负责人：')); assert.ok(content.includes('研发负责人：')); assert.ok(content.includes('发布人：周亦舒'));
  const buttons = card.elements.find(element => element.tag === 'action').actions;
  assert.equal(buttons[0].text.content, '打开飞书日程'); assert.ok(buttons[0].url.includes('event_mock'));
  assert.ok(buttons[1].url.includes(ctx.id));
  assert.ok(!content.includes('准备可复用的合成数据'));
  assert.deepEqual(ctx.calendar.info(ctx.id).messages, { pending: 0, sent: 2, failed: 0, skipped: 0 });
  ctx.store.run('INSERT INTO requirement_assignees(requirement_id,user_id,assigned_by,created_at) VALUES(?,?,?,?)', ctx.id, 'preview-colleague', 'preview-pm', now());
  ctx.calendar.enqueue(ctx.id); await ctx.calendar.drain(); await ctx.notifications.drain();
  assert.equal(ctx.messages.length, 3); assert.equal(ctx.messages[2].receive_id, 'ou_preview-colleague');
  ctx.calendar.enqueue(ctx.id); await ctx.calendar.drain(); await ctx.notifications.drain();
  assert.equal(ctx.messages.length, 3); assert.equal(ctx.events.size, 1);
});

test('calendar card failures preserve synced events and retry with persistent message IDs across restart', async t => {
  const ctx = fixture(t); await ctx.calendar.drain(); ctx.controls.failMessageResponse = 1;
  await ctx.notifications.drain();
  const pending = ctx.notifications.list().find(item => item.status === 'pending');
  assert.ok(pending); assert.equal(pending.attempts, 1); assert.ok(!pending.error.includes('secret_mock'));
  assert.equal(ctx.calendar.info(ctx.id).status, 'synced');
  ctx.store.db.close(); ctx.store = openStore(ctx.root);
  ctx.notifications = createNotifications(ctx.store, ctx.config); ctx.calendar = createRequirementCalendar(ctx.store, ctx.config, ctx.notifications);
  ctx.store.run('UPDATE notifications SET next_at=0'); await ctx.notifications.drain();
  const attempts = ctx.messages.filter(message => message.uuid === pending.id);
  assert.equal(attempts.length, 2); assert.equal(attempts[0].receive_id, attempts[1].receive_id);
  assert.equal(ctx.notifications.list().find(item => item.id === pending.id).status, 'sent'); assert.equal(ctx.events.size, 1);
  ctx.store.run('INSERT INTO requirement_assignees(requirement_id,user_id,assigned_by,created_at) VALUES(?,?,?,?)', ctx.id, 'preview-colleague', 'preview-pm', now());
  ctx.calendar.enqueue(ctx.id); await ctx.calendar.drain(); ctx.controls.failMessages = true;
  for (let attempt = 0; attempt < 5; attempt++) { ctx.store.run('UPDATE notifications SET next_at=0'); await ctx.notifications.drain(); }
  assert.equal(ctx.calendar.info(ctx.id).status, 'synced'); assert.equal(ctx.calendar.info(ctx.id).messages.failed, 1);
  const failed = ctx.notifications.list().find(item => item.recipient_id === 'preview-colleague');
  assert.equal(failed.status, 'failed'); assert.equal(failed.attempts, 5);
  ctx.controls.failMessages = false;
  ctx.store.run("UPDATE notifications SET status='pending',attempts=0,next_at=0 WHERE id=?", failed.id);
  await ctx.notifications.drain(); assert.equal(ctx.calendar.info(ctx.id).messages.sent, 3);
});

test('calendar cards recheck assignments and account state, use current schedule and suppress unsafe links', async t => {
  const ctx = fixture(t);
  for (const id of ['preview-colleague', 'preview-other']) ctx.store.run('INSERT INTO requirement_assignees(requirement_id,user_id,assigned_by,created_at) VALUES(?,?,?,?)', ctx.id, id, 'preview-pm', now());
  await ctx.calendar.drain();
  ctx.store.run('DELETE FROM requirement_assignees WHERE requirement_id=? AND user_id=?', ctx.id, 'preview-employee');
  ctx.store.run('UPDATE users SET enabled=0 WHERE id=?', 'preview-colleague');
  ctx.store.run('UPDATE users SET deleted_at=? WHERE id=?', now(), 'preview-other');
  ctx.store.run("UPDATE requirements SET title='新版 <b>日程</b>',deadline_date='2028-01-03' WHERE id=?", ctx.id);
  ctx.calendar.enqueue(ctx.id);
  await ctx.notifications.drain(); assert.equal(ctx.messages.length, 0);
  await ctx.calendar.drain();
  ctx.store.run("UPDATE requirement_calendar SET app_link='https://feishu.cn.attacker.example/path' WHERE requirement_id=?", ctx.id);
  await ctx.notifications.drain(); assert.equal(ctx.messages.length, 1);
  const card = JSON.parse(ctx.messages[0].content), content = JSON.stringify(card);
  assert.equal(card.elements[0].text.tag, 'plain_text'); assert.equal(card.elements[0].text.content, '新版 <b>日程</b>');
  assert.ok(content.includes('截止日期：2028-01-03')); assert.ok(!content.includes('attacker.example'));
  assert.equal(card.elements.find(element => element.tag === 'action').actions.length, 1);
  assert.deepEqual(ctx.calendar.info(ctx.id).messages, { pending: 0, sent: 1, failed: 0, skipped: 3 });
  ctx.store.run('INSERT INTO requirement_assignees(requirement_id,user_id,assigned_by,created_at) VALUES(?,?,?,?)', ctx.id, 'preview-employee', 'preview-pm', now());
  ctx.calendar.enqueue(ctx.id); await ctx.calendar.drain(); await ctx.notifications.drain();
  assert.equal(ctx.messages.length, 2); assert.equal(ctx.messages[1].receive_id, 'ou_preview-employee');
});

test('waiting calendar cards do not block other requirement notifications in the shared queue', async t => {
  const ctx = fixture(t); await ctx.calendar.drain();
  const jobs = ctx.notifications.list();
  for (let round = 1; round <= 4; round++) for (const job of jobs) ctx.store.run('INSERT INTO notifications(id,requirement_id,kind,round,recipient_id,created_at) VALUES(?,?,?,?,?,?)', uid(), ctx.id, 'requirement_calendar', round, job.recipient_id, '2000-01-01T00:00:00Z');
  ctx.calendar.enqueue(ctx.id);
  assert.equal(ctx.notifications.list().length, 10);
  ctx.notifications.enqueueRequirement(ctx.store.one('SELECT * FROM requirements WHERE id=?', ctx.id));
  await ctx.notifications.drain();
  assert.equal(ctx.messages.length, 2); assert.ok(ctx.messages.every(message => message.msg_type === 'text'));
  assert.equal(ctx.calendar.info(ctx.id).messages.pending, 10);
});

test('old notification schema migrates without losing queued jobs and supports independent requirement subjects', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prt-notification-migration-')), store = openStore(root);
  t.after(() => { store.db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  seedPreview(store);
  store.db.exec(`CREATE TABLE notifications(id TEXT PRIMARY KEY,version_id TEXT NOT NULL,kind TEXT NOT NULL,round INTEGER NOT NULL,recipient_id TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,next_at INTEGER NOT NULL DEFAULT 0,error TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL,sent_at TEXT,UNIQUE(version_id,kind,round,recipient_id));`);
  const id = uid(), version = store.one('SELECT id FROM versions').id;
  store.run('INSERT INTO notifications(id,version_id,kind,round,recipient_id,created_at) VALUES(?,?,?,?,?,?)', id, version, 'publish', 1, 'preview-pm', now());
  const notifications = createNotifications(store, { demoMode: true });
  assert.equal(store.one('SELECT version_id FROM notifications WHERE id=?', id).version_id, version);
  const requirement = store.one('SELECT * FROM requirements'); notifications.enqueueRequirement(requirement); notifications.enqueueRequirement(requirement);
  assert.equal(store.one('SELECT COUNT(*) AS count FROM notifications WHERE requirement_id=?', requirement.id).count, 8);
  assert.equal(store.one('SELECT COUNT(*) AS count FROM notifications WHERE version_id IS NULL').count, 8);
  assert.deepEqual(store.all('PRAGMA foreign_key_check'), []);
});
