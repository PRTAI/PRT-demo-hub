export function requirementDate(timestamp = new Date().toISOString()) {
  return new Date(Date.parse(timestamp) + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export function validRequirementDate(value) {
  if (!/^(19|20|21)\d{2}-\d{2}-\d{2}$/.test(value)) return false;
  const timestamp = Date.parse(value + 'T00:00:00Z');
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
}

export function nextRequirementDate(value) {
  return new Date(Date.parse(value + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10);
}

export function requirementDeadlineState(deadlineDate, status, currentTime = Date.now()) {
  if (!validRequirementDate(deadlineDate || '')) return 'none';
  if (['closed', 'delivered'].includes(status)) return 'normal';
  const remaining = Date.parse(nextRequirementDate(deadlineDate) + 'T00:00:00+08:00') - currentTime;
  if (remaining <= 0) return 'overdue';
  return remaining < 86400000 ? 'urgent' : 'normal';
}
