export const taskFormats = [
  { value: 'trajectory', label: '轨迹' },
  { value: 'harbor_task', label: 'Harbor Task' }
];

export const evaluationFields = [
  ['taskFormat', '任务格式'], ['rolloutModel', 'Rollout 模型'],
  ['rolloutCount', '每个任务 Rollout 次数'], ['passRate', '通过率']
];

export const modelEvaluationFields = [['difficulty', '模型难度说明'], ...evaluationFields];
export const isModelData = category => typeof category === 'string' && category.trim() === '大模型';

export function evaluationValue(description, key) {
  const value = description?.[key];
  if (value === undefined || value === null || value === '') return '';
  if (key === 'taskFormat') return taskFormats.find(format => format.value === value)?.label || '';
  if (key === 'rolloutCount') return `${value} 次 / 任务`;
  if (key === 'passRate') return `${value}%`;
  return String(value);
}

// Accepting an AI draft updates the text and only fills previously empty fields.
// A reported 0% is a real result and must not be treated as an empty value.
export function applyDescriptionDraft(description, result) {
  const next = { ...description, content: result.markdown };
  if (!isModelData(description.category)) return next;
  for (const key of ['difficulty', ...evaluationFields.map(([key]) => key)]) {
    const current = description[key], proposed = result[key];
    if ((current === undefined || current === null || typeof current === 'string' && !current.trim())
      && proposed !== undefined && proposed !== null && proposed !== '') next[key] = proposed;
  }
  return next;
}
