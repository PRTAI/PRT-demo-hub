import { z } from 'zod';
import { parse } from './db.mjs';

const querySchema = z.object({
  page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(5).max(100).default(10),
  scope: z.enum(['library', 'mine', 'team', 'reviews']).default('library'),
  q: z.string().max(200).default(''), status: z.enum(['all', 'published', 'pending', 'incomplete', 'draft', 'returned', 'offline']).default('all'),
  category: z.string().max(80).default('all'), owner: z.string().max(100).default('all'),
  days: z.coerce.number().int().min(0).max(3650).default(0), sort: z.enum(['updated', 'created', 'name']).default('updated'),
});
const from = `FROM assets a JOIN users u ON u.id=a.owner_id JOIN versions v ON v.id=(SELECT vv.id FROM versions vv WHERE vv.asset_id=a.id ORDER BY number DESC LIMIT 1)`;
export function queryCatalog(store, user, input) {
  const query = querySchema.parse(input), roles = parse(user.roles, []), conditions = [], args = [];
  const canOwn = roles.includes('employee') || roles.includes('supervisor'), manager = roles.includes('supervisor');
  const access = [], accessArgs = [];
  if (canOwn) { access.push('a.owner_id=?'); accessArgs.push(user.id); }
  if (manager) { access.push('EXISTS(SELECT 1 FROM versions rv WHERE rv.asset_id=a.id AND rv.reviewer_id=?)'); accessArgs.push(user.id); }
  access.push('EXISTS(SELECT 1 FROM asset_permissions ap WHERE ap.asset_id=a.id AND ap.user_id=?)'); accessArgs.push(user.id);
  if (roles.includes('pm') || roles.includes('business')) access.push('1=1');
  conditions.push(`(${access.length ? access.join(' OR ') : '0=1'})`); args.push(...accessArgs);
  if (query.scope === 'mine') { conditions.push('a.owner_id=?'); args.push(user.id); }
  if (['team', 'reviews'].includes(query.scope)) {
    conditions.push(manager ? '(a.owner_id=? OR EXISTS(SELECT 1 FROM versions rv WHERE rv.asset_id=a.id AND rv.reviewer_id=?))' : '0=1'); if (manager) args.push(user.id, user.id);
  }
  if (query.scope === 'reviews') conditions.push("v.status='pending'");
  const baseWhere = conditions.join(' AND '), baseArgs = [...args];
  const stats = store.one(`SELECT COUNT(*) AS total, COALESCE(SUM(a.current_version_id IS NOT NULL),0) AS published,
    COALESCE(SUM(v.status='pending'),0) AS pending, COALESCE(SUM(v.status='draft'),0) AS draft,
    COALESCE(SUM(v.status='returned'),0) AS returned, COALESCE(SUM(v.status='offline'),0) AS offline,
    COALESCE(SUM((SELECT COUNT(*) FROM versions cnt WHERE cnt.asset_id=a.id)),0) AS versions ${from} WHERE ${baseWhere}`, ...baseArgs);
  const owners = store.all(`SELECT DISTINCT u.id,u.name ${from} WHERE ${baseWhere} ORDER BY u.name`, ...baseArgs);
  const categories = store.all(`SELECT DISTINCT json_extract(v.description,'$.category') AS category ${from} WHERE ${baseWhere}`, ...baseArgs).map(r => r.category).filter(Boolean);
  const pendingReviews = manager ? store.one(`SELECT COUNT(*) AS n ${from} WHERE v.reviewer_id=? AND v.status='pending'`, user.id).n : 0;
  if (query.status === 'published') conditions.push('a.current_version_id IS NOT NULL');
  else if (query.status === 'incomplete') conditions.push("v.status IN ('draft','returned')");
  else if (query.status !== 'all') { conditions.push('v.status=?'); args.push(query.status); }
  if (query.category !== 'all') { conditions.push("json_extract(v.description,'$.category')=?"); args.push(query.category); }
  if (query.owner !== 'all') { conditions.push('a.owner_id=?'); args.push(query.owner); }
  if (query.days) { conditions.push('a.updated_at>=?'); args.push(new Date(Date.now() - query.days * 86400000).toISOString()); }
  if (query.q.trim()) {
    conditions.push(`(json_extract(v.description,'$.title') LIKE ? ESCAPE '\\' OR json_extract(v.description,'$.summary') LIKE ? ESCAPE '\\' OR json_extract(v.description,'$.tags') LIKE ? ESCAPE '\\' OR u.name LIKE ? ESCAPE '\\')`);
    const pattern = '%' + query.q.trim().replace(/[\\%_]/g, '\\$&') + '%'; args.push(pattern, pattern, pattern, pattern);
  }
  const where = conditions.join(' AND '), total = store.one(`SELECT COUNT(*) AS n ${from} WHERE ${where}`, ...args).n;
  const pages = Math.max(1, Math.ceil(total / query.pageSize)), page = Math.min(query.page, pages);
  const order = { updated: 'a.updated_at DESC,a.id', created: 'a.created_at DESC,a.id', name: "json_extract(v.description,'$.title'),a.id" }[query.sort];
  const assets = store.all(`SELECT a.* ${from} WHERE ${where} ORDER BY ${order} LIMIT ? OFFSET ?`, ...args, query.pageSize, (page - 1) * query.pageSize);
  return { assets, stats, owners, categories, pendingReviews, total, page, pageSize: query.pageSize, pages };
}
