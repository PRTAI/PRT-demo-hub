// A generated placeholder becomes a requirement card only after a Demo file is
// committed. Keep its record and binding so interrupted uploads can resume, but
// do not list empty placeholders left by file removal or older application code.
// Once somebody maintains the requirement, it has its own lifecycle and remains
// available even if its Demo is later removed.
export function requirementCardSql(alias = 'r') {
  return `(${alias}.deleted_at IS NULL AND (${alias}.source<>'demo' OR ${alias}.calendar_ready=1 OR ${alias}.revision>0
    OR EXISTS(SELECT 1 FROM requirement_files card_rf WHERE card_rf.requirement_id=${alias}.id)
    OR EXISTS(SELECT 1 FROM requirement_replies card_reply WHERE card_reply.requirement_id=${alias}.id)
    OR EXISTS(SELECT 1 FROM asset_requirements card_ar
      JOIN versions card_v ON card_v.asset_id=card_ar.asset_id
      JOIN version_files card_vf ON card_vf.version_id=card_v.id
      JOIN files card_f ON card_f.id=card_vf.file_id
      WHERE card_ar.requirement_id=${alias}.id AND card_f.size>0)))`;
}

export const hasRequirementCard = (store, id) => !!store.one(`SELECT 1 FROM requirements r WHERE r.id=? AND ${requirementCardSql()}`, id);
