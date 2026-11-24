import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createApp } from '../server/app.mjs';
import { dashboardData } from '../server/dashboard.mjs';
import { requirementDate } from '../shared/requirement-schedule.mjs';

const origin = 'http://127.0.0.1:5173';
const shift = (date, days) => new Date(Date.parse(date + 'T00:00:00Z') + days * 86400000).toISOString().slice(0, 10);

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), '.prt-test-'));
  const ctx = createApp({ dataDir: path.join(root, 'data'), demoMode: true, origin, backupDir: path.join(root, 'backups') });
  t.after(() => { ctx.store.db.close(); if (!path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep + '.prt-test-')) throw new Error('Unexpected cleanup path'); fs.rmSync(root, { recursive: true, force: true }); });
  async function login(id) {
    const agent = request.agent(ctx.app);
    await agent.post('/api/auth/demo-login').set('Origin', origin).set('X-Requested-With', 'PRT').send({ userId: id }).expect(200);
    return url => agent.get('/api' + url);
  }
  const requirement = (title, status, deadlineDate, assignees = []) => {
    const id = randomUUID(), time = new Date().toISOString();
    ctx.store.run("INSERT INTO requirements(id,title,content,category,status,publisher_id,created_at,updated_at,planned_date,deadline_date) VALUES(?,?,'','通用数据',?,'preview-pm',?,?,?,?)", id, title, status, time, time, requirementDate(time), deadlineDate);
    for (const user of assignees) ctx.store.run("INSERT INTO requirement_assignees(requirement_id,user_id,assigned_by,created_at,responsibility) VALUES(?,?,'preview-pm',?,'development')", id, user, time);
    return id;
  };
  return { ...ctx, login, requirement, user: id => ctx.store.one('SELECT * FROM users WHERE id=?', id) };
}

test('dashboard figures only cover the Demos each role may open', async t => {
  const f = fixture(t);
  await request(f.app).get('/api/dashboard').expect(401);
  const pm = await f.login('preview-pm');

  const all = (await pm('/dashboard').expect(200)).body;
  assert.deepEqual(Object.keys(all).sort(), ['categories', 'deadlines', 'demos', 'generatedAt', 'recent', 'requirements', 'statuses', 'today']);
  assert.deepEqual(all.demos, { total: 8, published: 4, pending: 1, incomplete: 2, versions: 8, pendingReviews: 0 });
  assert.deepEqual(Object.fromEntries(all.statuses.map(item => [item.key, item.count])), { published: 4, pending: 1, draft: 1, returned: 1, offline: 1 });
  assert.deepEqual(Object.fromEntries(all.categories.map(item => [item.name, item.count])), { 零售与消费: 2, 工业制造: 2, 通用数据: 2, 金融服务: 1, 医疗健康: 1 });
  assert.equal(all.recent.length, 4);
  assert.deepEqual(Object.keys(all.recent[0]).sort(), ['category', 'id', 'number', 'owner', 'publishedAt', 'title']);

  for (const id of ['preview-employee', 'preview-manager', 'preview-other', 'preview-other-manager', 'preview-business', 'preview-admin']) {
    const get = await f.login(id), board = (await get('/dashboard').expect(200)).body, catalog = (await get('/catalog').expect(200)).body;
    assert.equal(board.demos.total, catalog.stats.total, id);
    assert.equal(board.demos.published, catalog.stats.published, id);
    assert.equal(board.demos.pendingReviews, catalog.pendingReviews, id);
    assert.equal(board.categories.reduce((sum, item) => sum + item.count, 0), board.demos.total, id);
    assert.ok(board.recent.every(item => catalog.items.some(asset => asset.id === item.id)), id);
  }
  const manager = await f.login('preview-manager');
  assert.equal((await manager('/dashboard').expect(200)).body.demos.pendingReviews, 1);
  const other = await f.login('preview-other'), isolated = (await other('/dashboard').expect(200)).body;
  assert.equal(isolated.demos.total, 1);
  assert.deepEqual(isolated.recent.map(item => item.title), ['项目二组经营数据']);
  const admin = await f.login('preview-admin'), empty = (await admin('/dashboard').expect(200)).body;
  assert.equal(empty.demos.total, 0);
  assert.deepEqual([empty.categories, empty.recent], [[], []]);
});

test('dashboard requirement figures follow requirement visibility and Beijing deadlines', async t => {
  const f = fixture(t), today = requirementDate();
  const seeded = f.store.one('SELECT id FROM requirements').id;
  const overdue = f.requirement('昨日截止需求', 'open', shift(today, -1), ['preview-other']);
  const soon = f.requirement('三天后截止需求', 'needs_update', shift(today, 3));
  const later = f.requirement('二十天后截止需求', 'open', shift(today, 20));
  f.requirement('已关闭的逾期需求', 'closed', shift(today, -5), ['preview-other']);
  f.requirement('已交付需求', 'delivered', '', ['preview-employee']);

  const pm = await f.login('preview-pm'), all = (await pm('/dashboard').expect(200)).body.requirements;
  assert.deepEqual({ ...all, statuses: undefined }, { total: 6, active: 4, covered: 1, overdue: 1, dueSoon: 1, statuses: undefined });
  assert.deepEqual(Object.fromEntries(all.statuses.map(item => [item.key, item.count])), { open: 3, needs_update: 1, delivered: 1, closed: 1 });
  const deadlines = (await pm('/dashboard').expect(200)).body.deadlines;
  assert.deepEqual(deadlines.map(item => item.id), [overdue, soon, later]);
  assert.deepEqual(Object.keys(deadlines[0]).sort(), ['deadlineDate', 'demoCount', 'id', 'status', 'title']);

  const employee = await f.login('preview-employee'), own = (await employee('/dashboard').expect(200)).body;
  assert.deepEqual({ total: own.requirements.total, active: own.requirements.active, overdue: own.requirements.overdue }, { total: 2, active: 1, overdue: 0 });
  assert.deepEqual(own.deadlines, []);

  const other = await f.login('preview-other'), assigned = (await other('/dashboard').expect(200)).body;
  assert.deepEqual({ total: assigned.requirements.total, active: assigned.requirements.active, overdue: assigned.requirements.overdue, covered: assigned.requirements.covered }, { total: 3, active: 2, overdue: 1, covered: 1 });
  assert.deepEqual(assigned.deadlines.map(item => [item.id, item.demoCount]), [[overdue, 0]]);
  // Only the Demo the viewer can open counts towards the seeded requirement.
  const business = await f.login('preview-business'), full = (await business('/dashboard').expect(200)).body;
  assert.equal(full.requirements.total, 6);
  assert.equal(f.store.one('SELECT COUNT(*) AS n FROM asset_requirements WHERE requirement_id=?', seeded).n, 8);
  assert.equal(dashboardData(f.store, f.user('preview-other')).requirements.covered, 1);
  assert.equal(dashboardData(f.store, f.user('preview-unassigned')).requirements.total, 0);
});

test('dashboard deadline windows use Beijing dates', t => {
  const f = fixture(t), currentTime = Date.parse('2026-03-01T17:00:00Z');
  for (const [title, deadline] of [['逾期', '2026-03-01'], ['今日截止', '2026-03-02'], ['第七天截止', '2026-03-08'], ['第八天截止', '2026-03-09']]) f.requirement(title, 'open', deadline);
  const board = dashboardData(f.store, f.user('preview-pm'), currentTime);
  assert.equal(board.today, '2026-03-02');
  assert.deepEqual({ overdue: board.requirements.overdue, dueSoon: board.requirements.dueSoon }, { overdue: 1, dueSoon: 2 });
  assert.deepEqual(board.deadlines.map(item => item.title), ['逾期', '今日截止', '第七天截止', '第八天截止']);
});
