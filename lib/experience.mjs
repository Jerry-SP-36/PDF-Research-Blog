import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

const TERMINAL = new Set(['completed', 'partial', 'failed', 'cancelled', 'interrupted']);
const VERDICTS = new Set(['unreviewed', 'correct', 'partial', 'incorrect']);
const MAX_NOTE = 1600;
const now = () => new Date().toISOString();

async function atomicJson(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  await rename(temporary, file);
}

function cleanNote(value, label) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new Error(`${label}必須是文字。`);
  const text = value.trim();
  if (text.length > MAX_NOTE || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) throw new Error(`${label}最多 ${MAX_NOTE.toLocaleString('en-US')} 個字元。`);
  return text;
}

function tokens(text) {
  const normalized = String(text || '').toLocaleLowerCase('zh-Hant').normalize('NFKC');
  const result = new Set(normalized.match(/[a-z0-9][a-z0-9._+-]{1,}/g) || []);
  for (const run of normalized.match(/[\p{Script=Han}]{2,}/gu) || []) {
    for (let index = 0; index < run.length - 1; index++) result.add(run.slice(index, index + 2));
  }
  return result;
}

function overlapScore(topic, candidate) {
  const wanted = tokens(topic), available = tokens(candidate);
  if (!wanted.size || !available.size) return 0;
  let overlap = 0;
  for (const token of wanted) if (available.has(token)) overlap++;
  return overlap / Math.sqrt(wanted.size * available.size);
}

function publicEntry(entry) {
  if (!entry) return null;
  return JSON.parse(JSON.stringify(entry));
}

function systemResult(job) {
  const status = TERMINAL.has(job.status) ? job.status : 'interrupted';
  const descriptions = {
    completed: '流程完成，報告已通過引用與檔案驗證；技術內容是否正確仍由使用者回饋判定。',
    partial: '流程有可用報告，但研究仍有已標示缺口。',
    failed: '流程失敗，未取得通過驗證的完整報告。',
    cancelled: '研究由使用者取消，已保留當時資料。',
    interrupted: '程式結束或連線中斷，研究沒有自動重跑。',
  };
  const errors = Array.isArray(job.validation?.errors) ? job.validation.errors : [];
  const warnings = Array.isArray(job.validation?.warnings) ? job.validation.warnings : [];
  return {
    status,
    summary: descriptions[status],
    error: typeof job.error === 'string' ? job.error.slice(0, 3000) : null,
    validationErrors: errors.map(value => String(value).slice(0, 1000)).slice(0, 20),
    validationWarnings: warnings.map(value => String(value).slice(0, 1000)).slice(0, 20),
    sources: Number.isFinite(job.stats?.sources) ? job.stats.sources : 0,
    figures: Number.isFinite(job.stats?.figures) ? job.stats.figures : 0,
    reportAvailable: Boolean(job.report?.available),
  };
}

export class ExperienceStore {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'experiences.json');
    this.entries = new Map();
    this._save = Promise.resolve();
  }

  async init() {
    await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    try {
      const value = JSON.parse(await readFile(this.file, 'utf8'));
      if (value.version !== 1 || !Array.isArray(value.entries)) throw new Error('unsupported schema');
      for (const entry of value.entries) {
        if (!entry || typeof entry.jobId !== 'string' || typeof entry.topic !== 'string' || !TERMINAL.has(entry.system?.status)) continue;
        this.entries.set(entry.jobId, {
          id: typeof entry.id === 'string' ? entry.id : `experience-${entry.jobId}`,
          jobId: entry.jobId,
          topic: entry.topic,
          createdAt: entry.createdAt || now(),
          updatedAt: entry.updatedAt || entry.createdAt || now(),
          active: entry.active !== false,
          system: entry.system,
          feedback: {
            verdict: VERDICTS.has(entry.feedback?.verdict) ? entry.feedback.verdict : 'unreviewed',
            correct: typeof entry.feedback?.correct === 'string' ? entry.feedback.correct.slice(0, MAX_NOTE) : '',
            mistakes: typeof entry.feedback?.mistakes === 'string' ? entry.feedback.mistakes.slice(0, MAX_NOTE) : '',
            preferences: typeof entry.feedback?.preferences === 'string' ? entry.feedback.preferences.slice(0, MAX_NOTE) : '',
          },
        });
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error('研究經驗資料無法讀取；原檔已保留，請先檢查 experiences.json。');
    }
  }

  persist() {
    this._save = this._save.catch(() => {}).then(() => atomicJson(this.file, {
      version: 1,
      updatedAt: now(),
      entries: [...this.entries.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    }));
    return this._save;
  }

  get(jobId) { return publicEntry(this.entries.get(jobId)); }

  async capture(job) {
    if (!TERMINAL.has(job.status)) return null;
    const previous = this.entries.get(job.id);
    const system = systemResult(job);
    if (previous && previous.topic === job.topic && JSON.stringify(previous.system) === JSON.stringify(system)) return publicEntry(previous);
    const entry = {
      id: previous?.id || `experience-${job.id}`,
      jobId: job.id,
      topic: job.topic,
      createdAt: previous?.createdAt || now(),
      updatedAt: now(),
      active: previous?.active !== false,
      system,
      feedback: previous?.feedback || { verdict: 'unreviewed', correct: '', mistakes: '', preferences: '' },
    };
    this.entries.set(job.id, entry);
    await this.persist();
    return publicEntry(entry);
  }

  async saveFeedback(job, body) {
    if (!TERMINAL.has(job.status)) throw Object.assign(new Error('研究結束後才能儲存這次經驗。'), { statusCode: 409 });
    await this.capture(job);
    const entry = this.entries.get(job.id);
    const verdict=body?.verdict ?? entry.feedback.verdict ?? 'unreviewed';
    if (!VERDICTS.has(verdict)) throw new Error('請選擇有效的技術內容判定。');
    entry.feedback = {
      verdict,
      correct: cleanNote(body?.correct, '「做對／保留」'),
      mistakes: cleanNote(body?.mistakes, '「錯誤／修正」'),
      preferences: cleanNote(body?.preferences, '「我的偏好」'),
    };
    entry.updatedAt = now();
    this.entries.set(job.id, entry);
    await this.persist();
    return publicEntry(entry);
  }

  contextFor(topic) {
    const newest = [...this.entries.values()].filter(entry => entry.active).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const preferences = newest.filter(entry => entry.feedback.preferences).slice(0, 6).map(entry => ({
      experienceId: entry.id, topic: entry.topic, updatedAt: entry.updatedAt, preference: entry.feedback.preferences,
    }));
    const related = newest.map(entry => ({ entry, score: overlapScore(topic, entry.topic) }))
      .filter(({ entry, score }) => score > 0 && (entry.feedback.verdict !== 'unreviewed' || entry.feedback.correct || entry.feedback.mistakes || ['partial', 'failed', 'interrupted'].includes(entry.system.status)))
      .sort((a, b) => b.score - a.score || b.entry.updatedAt.localeCompare(a.entry.updatedAt)).slice(0, 6)
      .map(({ entry }) => ({
        experienceId: entry.id, topic: entry.topic, updatedAt: entry.updatedAt, processStatus: entry.system.status,
        processError: entry.system.error, validationErrors: entry.system.validationErrors,
        userVerdict: entry.feedback.verdict, correct: entry.feedback.correct, mistakes: entry.feedback.mistakes,
      }));
    return { version: 1, preferences, related };
  }
}

export const EXPERIENCE_NOTE_LIMIT = MAX_NOTE;
