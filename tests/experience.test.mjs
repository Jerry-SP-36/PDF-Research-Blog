import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ExperienceStore, EXPERIENCE_NOTE_LIMIT } from '../lib/experience.mjs';
import { developerInstructions } from '../lib/workflow.mjs';

const terminalJob = (overrides = {}) => ({
  id: 'job-224g', topic: '224G SerDes via stub 通道損耗', status: 'completed',
  error: null, stats: { sources: 4, figures: 6 }, report: { available: true },
  validation: { errors: [], warnings: [], valid: true }, ...overrides,
});

test('research experience persists process facts and user feedback, then selects it for later prompts', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pdf-experience-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new ExperienceStore(root);
  await store.init();
  const captured = await store.capture(terminalJob());
  assert.equal(captured.system.status, 'completed');
  assert.match(captured.system.summary, /技術內容是否正確/);
  assert.deepEqual(captured.feedback, { verdict: 'unreviewed', correct: '', mistakes: '', preferences: '' });

  const saved = await store.saveFeedback(terminalJob(), {
    verdict: 'partial',
    correct: '保留來源條件比較表。',
    mistakes: '不得把 224G 結果外推到 448G。',
    preferences: '所有結論保留協定、速率、距離與介質。',
  });
  assert.equal(saved.feedback.mistakes, '不得把 224G 結果外推到 448G。');
  assert.equal(saved.feedback.verdict, 'partial');
  assert.equal((await store.capture(terminalJob())).updatedAt, saved.updatedAt, 'restart capture does not make old feedback look new');
  const onDisk = JSON.parse(await readFile(path.join(root, 'experiences.json'), 'utf8'));
  assert.equal(onDisk.version, 1);
  assert.equal(onDisk.entries.length, 1);

  const restored = new ExperienceStore(root);
  await restored.init();
  assert.deepEqual(restored.get('job-224g').feedback, saved.feedback);
  const related = restored.contextFor('224G SerDes 的 via 設計方法');
  assert.equal(related.preferences.length, 1);
  assert.equal(related.related.length, 1);
  assert.match(related.related[0].mistakes, /448G/);
  assert.equal(related.related[0].userVerdict, 'partial');
  const unrelated = restored.contextFor('光學封裝熱分析');
  assert.equal(unrelated.preferences.length, 1, 'long-term preferences apply across topics');
  assert.equal(unrelated.related.length, 0, 'topic corrections require lexical relevance');

  const instructions = developerInstructions({ skillPath: '/skill', maxJobMinutes: 45, sourceRoots: ['/pdf'], pdfToolDir: '/tools', pythonPath: '/python' }, {
    ...terminalJob(), dir: '/job', sourceCount: null, figureTarget: null, experienceContext: related,
  });
  assert.match(instructions, /本機研究經驗/);
  assert.match(instructions, /所有結論保留協定、速率、距離與介質/);
  assert.match(instructions, /不能當成技術正確性的證據/);
});

test('experience feedback accepts clearing, rejects active jobs, invalid fields and oversized notes', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pdf-experience-bounds-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new ExperienceStore(root);
  await store.init();
  await assert.rejects(() => store.saveFeedback(terminalJob({ status: 'running' }), {}), error => error.statusCode === 409);
  await assert.rejects(() => store.saveFeedback(terminalJob(), { correct: 123 }), /必須是文字/);
  await assert.rejects(() => store.saveFeedback(terminalJob(), { verdict: 'maybe' }), /有效的技術內容判定/);
  await assert.rejects(() => store.saveFeedback(terminalJob(), { correct: 'x'.repeat(EXPERIENCE_NOTE_LIMIT + 1) }), /最多/);
  const cleared = await store.saveFeedback(terminalJob(), { correct: '', mistakes: '', preferences: '' });
  assert.deepEqual(cleared.feedback, { verdict: 'unreviewed', correct: '', mistakes: '', preferences: '' });
});

test('failed process details are retained as relevant recovery experience without being labeled correct', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pdf-experience-failed-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new ExperienceStore(root);
  await store.init();
  await store.capture(terminalJob({
    id: 'failed-via', status: 'failed', error: 'PDF Search 操作失敗', report: { available: false },
    validation: { errors: ['引用頁面沒有畫面證據'], warnings: [], valid: false },
  }));
  const context = store.contextFor('224G via stub');
  assert.equal(context.related[0].processStatus, 'failed');
  assert.match(context.related[0].processError, /PDF Search/);
  assert.deepEqual(context.related[0].validationErrors, ['引用頁面沒有畫面證據']);
  assert.equal(context.related[0].correct, '');
});
