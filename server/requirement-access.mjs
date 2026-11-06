import { parse } from './db.mjs';

// Follow the current directory chain, never persist inherited grants. UNION and
// excluding the viewer at each step also bound legacy cyclic directory data.
export function superiorRequirementFilter(user, { requirement = 'r.id', asset = null } = {}) {
  if (!user?.enabled || user.deleted_at || !parse(user.roles, []).includes('supervisor')) return { sql: '0=1', args: [] };
  return { sql: `EXISTS (
    WITH RECURSIVE requirement_reports(id) AS (
      SELECT u.id FROM users u WHERE u.supervisor_id=? AND u.id<>? AND u.enabled=1 AND u.deleted_at IS NULL
      UNION
      SELECT u.id FROM users u JOIN requirement_reports reports ON u.supervisor_id=reports.id
      JOIN users parent ON parent.id=reports.id
      WHERE u.id<>? AND u.enabled=1 AND u.deleted_at IS NULL
        AND EXISTS(SELECT 1 FROM json_each(parent.roles) role WHERE role.value='supervisor')
    )
    SELECT 1 FROM requirement_assignees inherited_ra JOIN requirement_reports reports ON reports.id=inherited_ra.user_id
    ${asset ? 'JOIN asset_requirements inherited_ar ON inherited_ar.requirement_id=inherited_ra.requirement_id' : ''}
    WHERE ${asset ? `inherited_ar.asset_id=${asset}` : `inherited_ra.requirement_id=${requirement}`}
      AND EXISTS(SELECT 1 FROM requirements inherited_r WHERE inherited_r.id=inherited_ra.requirement_id AND inherited_r.deleted_at IS NULL)
  )`, args: [user.id, user.id, user.id] };
}

export function createRequirementAccess(store) {
  return {
    requirement(user, id) {
      const filter = superiorRequirementFilter(user);
      return !!store.one(`SELECT 1 FROM requirements r WHERE r.id=? AND ${filter.sql}`, id, ...filter.args);
    },
    asset(user, id) {
      const filter = superiorRequirementFilter(user, { asset: 'a.id' });
      return !!store.one(`SELECT 1 FROM assets a WHERE a.id=? AND ${filter.sql}`, id, ...filter.args);
    },
    validateSupervisor(userId, supervisorId) {
      const visited = new Set([userId]);
      let next = supervisorId;
      while (next) {
        if (visited.has(next)) return false;
        visited.add(next);
        next = store.one('SELECT supervisor_id FROM users WHERE id=?', next)?.supervisor_id;
      }
      return true;
    }
  };
}
