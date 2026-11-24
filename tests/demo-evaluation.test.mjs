import test from 'node:test';
import assert from 'node:assert/strict';
import { applyDescriptionDraft, evaluationValue } from '../shared/demo-evaluation.mjs';

test('evaluation display distinguishes unknown results from zero percent and uses per-task rollout units', () => {
  assert.equal(evaluationValue({ taskFormat: 'trajectory' }, 'taskFormat'), '轨迹');
  assert.equal(evaluationValue({ taskFormat: 'harbor_task' }, 'taskFormat'), 'Harbor Task');
  assert.equal(evaluationValue({ rolloutCount: 5 }, 'rolloutCount'), '5 次 / 任务');
  assert.equal(evaluationValue({ passRate: 0 }, 'passRate'), '0%');
  assert.equal(evaluationValue({ passRate: 25.5 }, 'passRate'), '25.5%');
  assert.equal(evaluationValue({ passRate: null }, 'passRate'), '');
  assert.equal(evaluationValue({}, 'rolloutCount'), '');
});

test('accepting an AI draft fills empty evaluation fields and preserves concurrent edits and measured zero results', () => {
  const original = { category: '大模型', content: '旧说明', difficulty: '人工补充的模型难度', rolloutModel: '实际评测模型', taskFormat: '', rolloutCount: null, passRate: 0, notes: '生成期间的备注' };
  const result = { markdown: '# 模型难度\n新说明\n# 数据格式\n任务结构', difficulty: 'AI 难度建议', taskFormat: 'harbor_task', rolloutModel: '另一模型', rolloutCount: 5, passRate: 80 };
  const applied = applyDescriptionDraft(original, result);
  assert.equal(applied.content, result.markdown); assert.equal(applied.difficulty, original.difficulty);
  assert.equal(applied.rolloutModel, original.rolloutModel); assert.equal(applied.passRate, 0);
  assert.equal(applied.taskFormat, 'harbor_task'); assert.equal(applied.rolloutCount, 5); assert.equal(applied.notes, original.notes);
  assert.equal(original.content, '旧说明'); assert.equal(original.rolloutCount, null);
  const empty = applyDescriptionDraft({ category: '大模型', difficulty: ' ', passRate: null }, { markdown: result.markdown, difficulty: '模型的长程规划难度', passRate: 0 });
  assert.equal(empty.difficulty, '模型的长程规划难度'); assert.equal(empty.passRate, 0);
  assert.equal(applyDescriptionDraft(original, { markdown: '旧任务生成结果' }).rolloutModel, original.rolloutModel);
});


test('accepting a non-model draft only updates text, even if the result contains model metrics', () => {
  for (const category of ['', '通用数据', '爬虫', '金融服务']) {
    const description = { category, content: '旧说明', taskFormat: '', rolloutCount: null };
    assert.deepEqual(applyDescriptionDraft(description, { markdown: '新说明', difficulty: '模型难度', taskFormat: 'trajectory', rolloutCount: 5, passRate: 0 }), { ...description, content: '新说明' });
  }
});
