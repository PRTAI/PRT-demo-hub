const defaults = () => ({ query: '', status: 'all', page: 1, anchor: null });
export function requirementListStorage() {
  try { return window.sessionStorage; } catch { return null; }
}
export function readRequirementList(storage, key) {
  try {
    const value = JSON.parse(storage.getItem(key));
    if (!value || typeof value.query !== 'string' || value.query.length > 200 || !['all', 'open', 'needs_update', 'delivered', 'closed'].includes(value.status) || !Number.isSafeInteger(value.page) || value.page < 1) return defaults();
    const anchor = value.anchor;
    return { query: value.query, status: value.status, page: value.page, anchor: anchor && typeof anchor.id === 'string' && anchor.id.length <= 100 && Number.isFinite(anchor.y) && anchor.y >= 0 && Number.isFinite(anchor.offset) ? anchor : null };
  } catch { return defaults(); }
}
export function saveRequirementList(storage, key, state) {
  try { storage.setItem(key, JSON.stringify(state)); } catch { /* Storage may be unavailable; the in-memory position still works. */ }
}
export function requirementReturnTop(anchor, card, scrollY) {
  // Re-anchor to the same card even if its position changed after editing/status updates.
  return Math.max(0, card ? scrollY + card.getBoundingClientRect().top - anchor.offset : anchor.y);
}
