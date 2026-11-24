import { z } from 'zod';
import { parse } from './db.mjs';
import { assetAccess, from } from './catalog.mjs';
import { requirementDate, validRequirementDate } from '../shared/requirement-schedule.mjs';

const querySchema = z.object({ period: z.enum(['month', 'week']).default('month') });
const demoStatuses = ['published', 'pending', 'draft', 'returned', 'offline'];
const requirementStatuses = ['open', 'needs_update', 'delivered', 'closed'];
const shiftDate = (value, days) => new Date(Date.parse(value + 'T00:00:00Z') + days * 86400000).toISOString().slice(0, 10);
const monday = value => shiftDate(value, -((new Date(value + 'T00:00:00Z').getUTCDay() + 6) % 7));

// Beijing-time buckets, oldest first: the last 6 months or the last 12 weeks starting on Mondays.
function trendBuckets(period, today) {
  if (period === 'week') return Array.from({ length: 12 }, (_, i) => shiftDate(monday(today), (i - 11) * 7));
  const [year, month] = today.split('-').map(Number);
  return Array.from({ length: 6 }, (_, i) => new Date(Date.UTC(year, month - 6 + i, 1)).toISOString().slice(0, 7));
}

// Aggregates for the 数据大屏. Every figure only covers the Demos and requirements the viewer may open.
export function dashboardData(store, user, input = {}, currentTime = Date.now()) {
  const { period } = querySchema.parse(input), roles = parse(user.roles, []), access = assetAccess(user);
  const today = requirementDate(new Date(currentTime).toISOString());
  const demos = store.one(`SELECT COUNT(*) AS total, COALESCE(SUM(a.current_version_id IS NOT NULL),0) AS published,
    COALESCE(SUM(v.status='pending'),0) AS pending, COALESCE(SUM(v.status IN ('draft','returned')),0) AS incomplete,
    COALESCE(SUM((SELECT COUNT(*) FROM versions cnt WHERE cnt.asset_id=a.id)),0) AS versions ${from} WHERE ${access.sql}`, ...access.args);
  demos.pendingReviews = roles.includes('supervisor') ? store.one(`SELECT COUNT(*) AS n ${from} WHERE v.reviewer_id=? AND v.status='pending'`, user.id).n : 0;
  const statusCounts = new Map(store.all(`SELECT v.status, COUNT(*) AS count ${from} WHERE ${access.sql} GROUP BY v.status`, ...access.args).map(row => [row.status, row.count]));
  const categoryRows = store.all(`SELECT COALESCE(NULLIF(TRIM(json_extract(v.description,'$.category')),''),'未分类') AS category, COUNT(*) AS count
    ${from} WHERE ${access.sql} GROUP BY category ORDER BY count DESC, category`, ...access.args).map(row => ({ name: row.category, count: row.count }));
  const categories = categoryRows.length > 6 ? [...categoryRows.slice(0, 5), { name: '其他分类', count: categoryRows.slice(5).reduce((sum, row) => sum + row.count, 0), other: true }] : categoryRows;
  const contributors = store.all(`SELECT u.id, u.name, COUNT(*) AS demos, COALESCE(SUM(a.current_version_id IS NOT NULL),0) AS published
    ${from} WHERE ${access.sql} GROUP BY u.id ORDER BY published DESC, demos DESC, u.name LIMIT 5`, ...access.args);
  const recent = store.all(`SELECT a.id, cv.number, cv.description, cv.published_at AS publishedAt, u.id AS ownerId, u.name AS ownerName
    FROM assets a JOIN users u ON u.id=a.owner_id JOIN versions cv ON cv.id=a.current_version_id WHERE ${access.sql} ORDER BY cv.published_at DESC, a.id LIMIT 6`, ...access.args)
    .map(row => { const description = parse(row.description); return { id: row.id, title: description.title || '', category: description.category || '', number: row.number, publishedAt: row.publishedAt, owner: { id: row.ownerId, name: row.ownerName } }; });

  const keys = trendBuckets(period, today), bucketOf = date => period === 'week' ? monday(date) : date.slice(0, 7);
  const trend = keys.map(key => ({ key, demos: 0, published: 0, requirements: 0 })), buckets = new Map(trend.map(item => [item.key, item]));
  const count = (field, date) => { const bucket = buckets.get(bucketOf(date)); if (bucket) bucket[field]++; };
  const since = new Date(Date.parse((period === 'week' ? keys[0] : keys[0] + '-01') + 'T00:00:00+08:00')).toISOString();
  for (const row of store.all(`SELECT a.created_at AS at FROM assets a WHERE ${access.sql} AND a.created_at>=?`, ...access.args, since)) count('demos', requirementDate(row.at));
  for (const row of store.all(`SELECT pv.published_at AS at FROM versions pv JOIN assets a ON a.id=pv.asset_id WHERE ${access.sql} AND pv.published_at>=?`, ...access.args, since)) count('published', requirementDate(row.at));

  // Requirement visibility mirrors the requirement list: publishers see everything, others only their assignments.
  const everyRequirement = roles.includes('pm') || roles.includes('business');
  const requirements = store.all(`SELECT r.id, r.title, r.status, r.planned_date AS plannedDate, r.deadline_date AS deadlineDate, r.created_at AS createdAt,
    (SELECT COUNT(*) FROM asset_requirements ar JOIN assets a ON a.id=ar.asset_id WHERE ar.requirement_id=r.id AND ${access.sql}) AS demoCount
    FROM requirements r WHERE ${everyRequirement ? '1=1' : 'EXISTS(SELECT 1 FROM requirement_assignees ra WHERE ra.requirement_id=r.id AND ra.user_id=?)'}`, ...access.args, ...(everyRequirement ? [] : [user.id]));
  const active = requirements.filter(requirement => ['open', 'needs_update'].includes(requirement.status));
  const dated = active.filter(requirement => validRequirementDate(requirement.deadlineDate || '')), weekEnd = shiftDate(today, 6);
  for (const requirement of requirements) count('requirements', requirement.plannedDate || requirementDate(requirement.createdAt));
  return {
    generatedAt: new Date(currentTime).toISOString(), today, period, demos, categories, contributors, recent, trend,
    statuses: demoStatuses.map(key => ({ key, count: statusCounts.get(key) || 0 })),
    requirements: {
      total: requirements.length, active: active.length, covered: active.filter(requirement => requirement.demoCount > 0).length,
      overdue: dated.filter(requirement => requirement.deadlineDate < today).length,
      dueSoon: dated.filter(requirement => requirement.deadlineDate >= today && requirement.deadlineDate <= weekEnd).length,
      statuses: requirementStatuses.map(key => ({ key, count: requirements.filter(requirement => requirement.status === key).length }))
    },
    deadlines: dated.sort((a, b) => a.deadlineDate.localeCompare(b.deadlineDate) || a.title.localeCompare(b.title, 'zh-CN')).slice(0, 6)
      .map(({ id, title, status, deadlineDate, demoCount }) => ({ id, title, status, deadlineDate, demoCount }))
  };
}
