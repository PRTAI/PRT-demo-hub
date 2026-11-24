import { parse } from './db.mjs';
import { assetAccess, from } from './catalog.mjs';
import { requirementDate, validRequirementDate } from '../shared/requirement-schedule.mjs';

const demoStatuses = ['published', 'pending', 'draft', 'returned', 'offline'];
const requirementStatuses = ['open', 'needs_update', 'delivered', 'closed'];
const shiftDate = (value, days) => new Date(Date.parse(value + 'T00:00:00Z') + days * 86400000).toISOString().slice(0, 10);

// Aggregates for the 数据大屏. Every figure only covers the Demos and requirements the viewer may open.
export function dashboardData(store, user, currentTime = Date.now()) {
  const roles = parse(user.roles, []), access = assetAccess(user);
  const today = requirementDate(new Date(currentTime).toISOString());
  const demos = store.one(`SELECT COUNT(*) AS total, COALESCE(SUM(a.current_version_id IS NOT NULL),0) AS published,
    COALESCE(SUM(v.status='pending'),0) AS pending, COALESCE(SUM(v.status IN ('draft','returned')),0) AS incomplete,
    COALESCE(SUM((SELECT COUNT(*) FROM versions cnt WHERE cnt.asset_id=a.id)),0) AS versions ${from} WHERE ${access.sql}`, ...access.args);
  demos.pendingReviews = roles.includes('supervisor') ? store.one(`SELECT COUNT(*) AS n ${from} WHERE v.reviewer_id=? AND v.status='pending'`, user.id).n : 0;
  const statusCounts = new Map(store.all(`SELECT v.status, COUNT(*) AS count ${from} WHERE ${access.sql} GROUP BY v.status`, ...access.args).map(row => [row.status, row.count]));
  const categoryRows = store.all(`SELECT COALESCE(NULLIF(TRIM(json_extract(v.description,'$.category')),''),'未分类') AS category, COUNT(*) AS count
    ${from} WHERE ${access.sql} GROUP BY category ORDER BY count DESC, category`, ...access.args).map(row => ({ name: row.category, count: row.count }));
  const categories = categoryRows.length > 6 ? [...categoryRows.slice(0, 5), { name: '其他分类', count: categoryRows.slice(5).reduce((sum, row) => sum + row.count, 0), other: true }] : categoryRows;
  const recent = store.all(`SELECT a.id, cv.number, cv.description, cv.published_at AS publishedAt, u.id AS ownerId, u.name AS ownerName
    FROM assets a JOIN users u ON u.id=a.owner_id JOIN versions cv ON cv.id=a.current_version_id WHERE ${access.sql} ORDER BY cv.published_at DESC, a.id LIMIT 6`, ...access.args)
    .map(row => { const description = parse(row.description); return { id: row.id, title: description.title || '', category: description.category || '', number: row.number, publishedAt: row.publishedAt, owner: { id: row.ownerId, name: row.ownerName } }; });

  // Requirement visibility mirrors the requirement list: publishers see everything, others only their assignments.
  const everyRequirement = roles.includes('pm') || roles.includes('business');
  const requirements = store.all(`SELECT r.id, r.title, r.status, r.deadline_date AS deadlineDate,
    (SELECT COUNT(*) FROM asset_requirements ar JOIN assets a ON a.id=ar.asset_id WHERE ar.requirement_id=r.id AND ${access.sql}) AS demoCount
    FROM requirements r WHERE ${everyRequirement ? '1=1' : 'EXISTS(SELECT 1 FROM requirement_assignees ra WHERE ra.requirement_id=r.id AND ra.user_id=?)'}`, ...access.args, ...(everyRequirement ? [] : [user.id]));
  const active = requirements.filter(requirement => ['open', 'needs_update'].includes(requirement.status));
  const dated = active.filter(requirement => validRequirementDate(requirement.deadlineDate || '')), weekEnd = shiftDate(today, 6);
  return {
    generatedAt: new Date(currentTime).toISOString(), today, demos, categories, recent,
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
