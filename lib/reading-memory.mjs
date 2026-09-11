import { createReadStream } from 'node:fs';
import { mkdir, open, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';

const MAX_RECORDS = 5000;
const MAX_SUMMARY = 5000;
const MAX_FINDINGS = 24;
const MAX_FINDING = 1200;
const MAX_TOPICS = 16;
const MAX_PAGES = 300;
const now = () => new Date().toISOString();
const clone = value => JSON.parse(JSON.stringify(value));
const inside = (file, root) => {
  const relative = path.relative(root, file);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

async function atomicJson(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  await rename(temporary, file);
}

async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function pdfHeader(file) {
  const handle = await open(file, 'r');
  try {
    const buffer = Buffer.alloc(5);
    const { bytesRead } = await handle.read(buffer, 0, 5, 0);
    return bytesRead === 5 && buffer.toString('ascii') === '%PDF-';
  } finally { await handle.close(); }
}

function text(value, label, maximum, required = true) {
  if (value === undefined || value === null) value = '';
  if (typeof value !== 'string') throw new Error(`${label}必須是文字。`);
  const cleaned = value.trim();
  if ((required && !cleaned) || cleaned.length > maximum || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(cleaned)) {
    throw new Error(`${label}${required ? '不可空白，且' : ''}最多 ${maximum.toLocaleString('en-US')} 個字元。`);
  }
  return cleaned;
}

function cleanPages(value, label = '閱讀頁碼') {
  if (!Array.isArray(value) || !value.length || value.length > MAX_PAGES) throw new Error(`${label}需包含 1–${MAX_PAGES} 個 PDF 頁碼。`);
  const pages = value.map((page, index) => {
    if (!Number.isSafeInteger(page) || page < 1 || page > 100000) throw new Error(`${label}[${index}] 必須是正整數。`);
    return page;
  });
  return [...new Set(pages)].sort((a, b) => a - b);
}

function cleanTopics(value, fallback) {
  const items = value === undefined ? [fallback] : value;
  if (!Array.isArray(items) || !items.length || items.length > MAX_TOPICS) throw new Error(`頁面主題需包含 1–${MAX_TOPICS} 項。`);
  return [...new Set(items.map((item, index) => text(item, `頁面主題[${index}]`, 160)))];
}

function cleanFindings(value, pages) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_FINDINGS) throw new Error(`閱讀發現最多 ${MAX_FINDINGS} 項。`);
  return value.map((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`閱讀發現[${index}] 必須是物件。`);
    const findingPages = raw.pages === undefined ? pages : cleanPages(raw.pages, `閱讀發現[${index}].pages`);
    if (findingPages.some(page => !pages.includes(page))) throw new Error(`閱讀發現[${index}] 的頁碼不在本次閱讀頁碼內。`);
    return {
      text: text(raw.text, `閱讀發現[${index}].text`, MAX_FINDING),
      pages: findingPages,
      conditions: text(raw.conditions, `閱讀發現[${index}].conditions`, 800, false),
    };
  });
}

function tokens(value) {
  const normalized = String(value || '').toLocaleLowerCase('zh-Hant').normalize('NFKC');
  const result = new Set(normalized.match(/[a-z0-9][a-z0-9._+-]{1,}/g) || []);
  for (const run of normalized.match(/[\p{Script=Han}]{2,}/gu) || []) {
    for (let index = 0; index < run.length - 1; index++) result.add(run.slice(index, index + 2));
  }
  return result;
}

function score(query, candidate) {
  const wanted = tokens(query), available = tokens(candidate);
  if (!wanted.size || !available.size) return 0;
  let overlap = 0;
  for (const token of wanted) if (available.has(token)) overlap++;
  return overlap / Math.sqrt(wanted.size * available.size);
}

function reportFindings(report, sourceId) {
  const results = [];
  const add = item => {
    const citation = (item?.citations || []).find(value => value.sourceId === sourceId);
    if (citation && typeof item.text === 'string' && item.text.trim()) results.push({ text: item.text.trim().slice(0, MAX_FINDING), pages: citation.pages, conditions: '' });
  };
  for (const item of report.summary || []) add(item);
  for (const section of report.sections || []) for (const block of section.blocks || []) {
    if (block.type === 'paragraph') add(block);
    else if (block.type === 'bullets') for (const item of block.items || []) add(item);
  }
  return results.slice(0, MAX_FINDINGS);
}

export class ReadingMemoryStore {
  constructor(dataDir, { pageCounter = null } = {}) {
    this.file = path.join(dataDir, 'reading-memory.json');
    this.entries = new Map();
    this._save = Promise.resolve();
    this.pageCounter = pageCounter;
  }

  async init() {
    await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    try {
      const value = JSON.parse(await readFile(this.file, 'utf8'));
      if (value.version !== 1 || !Array.isArray(value.entries)) throw new Error('unsupported schema');
      for (const entry of value.entries.slice(-MAX_RECORDS)) {
        if (!entry || typeof entry.id !== 'string' || typeof entry.jobId !== 'string' || typeof entry.researchTopic !== 'string' ||
            !entry.source || typeof entry.source.path !== 'string' || typeof entry.source.title !== 'string' || !/^[a-f0-9]{64}$/.test(entry.source.sha256 || '') ||
            !Array.isArray(entry.pages) || !entry.pages.every(page => Number.isSafeInteger(page) && page > 0) ||
            !Array.isArray(entry.topics) || !entry.topics.length || !entry.topics.every(topic => typeof topic === 'string') ||
            typeof entry.summary !== 'string' || !Array.isArray(entry.findings)) continue;
        this.entries.set(entry.id, entry);
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error('閱讀記憶無法讀取；原檔已保留，請先檢查 reading-memory.json。');
    }
  }

  persist() {
    this._save = this._save.catch(() => {}).then(() => atomicJson(this.file, {
      version: 1,
      updatedAt: now(),
      entries: [...this.entries.values()].sort((a, b) => a.recordedAt.localeCompare(b.recordedAt)).slice(-MAX_RECORDS),
    }));
    return this._save;
  }

  count() { return this.entries.size; }
  countForJob(jobId) { return [...this.entries.values()].filter(entry => (entry.jobIds || [entry.jobId]).includes(jobId)).length; }

  async resolveSource(sourcePath, sourceRoots) {
    if (typeof sourcePath !== 'string' || !path.isAbsolute(sourcePath)) throw new Error('閱讀來源必須是允許目錄內的絕對 PDF 路徑。');
    const file = await realpath(sourcePath);
    const roots = await Promise.all(sourceRoots.map(root => realpath(root)));
    if (!roots.some(root => inside(file, root))) throw new Error('閱讀來源超出允許的 PDF 目錄。');
    const info = await stat(file);
    if (!info.isFile() || path.extname(file).toLowerCase() !== '.pdf' || !(await pdfHeader(file))) throw new Error('閱讀來源必須是有效 PDF。');
    return { path: file, bytes: info.size, mtimeMs: Math.trunc(info.mtimeMs), sha256: await sha256(file) };
  }

  async record(job, body, sourceRoots, { method = 'page-observation' } = {}) {
    if (!job?.id || typeof job.topic !== 'string') throw new Error('閱讀記憶缺少研究任務資訊。');
    const source = await this.resolveSource(body?.sourcePath, sourceRoots);
    source.title = text(body?.sourceTitle, '來源標題', 600);
    const pages = cleanPages(body?.pages);
    if (typeof this.pageCounter === 'function') {
      const pageCount = await this.pageCounter(source.path);
      if (!Number.isSafeInteger(pageCount) || pageCount < 1) throw new Error('無法確認閱讀來源的 PDF 頁數。');
      if (pages.some(page => page > pageCount)) throw new Error(`閱讀頁碼超出 PDF 的 ${pageCount} 頁範圍。`);
      source.pageCount = pageCount;
    }
    const topics = cleanTopics(body?.topics, job.topic);
    const summary = text(body?.summary, '閱讀摘要', MAX_SUMMARY);
    const findings = cleanFindings(body?.findings, pages);
    const query = text(body?.query, '搜尋詞', 600, false);
    const identity = JSON.stringify({ sha256: source.sha256, pages });
    const id = `reading-${createHash('sha256').update(identity).digest('hex').slice(0, 32)}`;
    const previous = this.entries.get(id);
    const preferNew = method === 'page-observation' || previous?.method !== 'page-observation';
    const mergedFindings = [...(preferNew ? findings : previous?.findings || []), ...(preferNew ? previous?.findings || [] : findings)]
      .filter((finding, index, values) => values.findIndex(value => JSON.stringify(value) === JSON.stringify(finding)) === index)
      .slice(0, MAX_FINDINGS);
    const entry = {
      id, jobId: job.id, researchTopic: job.topic, method,
      recordedAt: previous?.recordedAt || now(), updatedAt: now(), active: true,
      jobIds: [...new Set([...(previous?.jobIds || (previous?.jobId ? [previous.jobId] : [])), job.id])].slice(-100),
      researchTopics: [...new Set([job.topic, ...(previous?.researchTopics || (previous?.researchTopic ? [previous.researchTopic] : []))])].slice(0, MAX_TOPICS),
      source, pages,
      topics: [...new Set([...topics, ...(previous?.topics || [])])].slice(0, MAX_TOPICS),
      query: preferNew ? (query || previous?.query || '') : (previous?.query || query),
      summary: preferNew ? summary : previous.summary,
      findings: mergedFindings,
    };
    if (!preferNew && previous) entry.method = previous.method;
    if (previous && JSON.stringify({ ...previous, updatedAt: null }) === JSON.stringify({ ...entry, updatedAt: null })) return clone(previous);
    this.entries.set(id, entry);
    while (this.entries.size > MAX_RECORDS) this.entries.delete(this.entries.keys().next().value);
    await this.persist();
    return clone(entry);
  }

  async captureReport(job, report, sourceRoots) {
    const saved = [];
    for (const source of report?.sources || []) {
      if (source.kind === 'web' || !source.path || !Array.isArray(source.pagesRead) || !source.pagesRead.length) continue;
      const pages = [...new Set((report.evidence || [])
        .filter(item => item.sourceId === source.id && item.method === 'pdf-search-screenshot' && source.pagesRead.includes(item.page))
        .map(item => item.page))].sort((a, b) => a - b);
      if (!pages.length) continue;
      const findings = reportFindings(report, source.id);
      const evidence = (report.evidence || []).filter(item => item.sourceId === source.id && item.note).map(item => `p.${item.page}: ${item.note}`);
      const summary = [...findings.map(item => item.text), ...evidence].join('\n').slice(0, MAX_SUMMARY) || `本次研究已核對 PDF p.${pages.join('、')}。`;
      saved.push(await this.record(job, {
        sourcePath: source.path, sourceTitle: source.title, pages,
        topics: [job.topic], summary, findings, query: '',
      }, sourceRoots, { method: 'validated-report' }));
    }
    return saved;
  }

  async contextFor(topic, sourceRoots) {
    const candidates = [...this.entries.values()].filter(entry => entry.active !== false).map(entry => ({
      entry,
      relevance: score(topic, [...(entry.researchTopics || [entry.researchTopic]), entry.source.title, entry.topics.join(' '), entry.summary].join(' ')),
    })).filter(value => value.relevance > 0).sort((a, b) => b.relevance - a.relevance || b.entry.updatedAt.localeCompare(a.entry.updatedAt));
    const fingerprints = new Map(), records = [], seen = new Set();
    let staleCount = 0;
    for (const { entry, relevance } of candidates) {
      try {
        let fingerprint = fingerprints.get(entry.source.path);
        if (fingerprint === undefined) {
          try { fingerprint = await this.resolveSource(entry.source.path, sourceRoots); }
          catch { fingerprint = null; }
          fingerprints.set(entry.source.path, fingerprint);
        }
        if (!fingerprint) { staleCount++; continue; }
        if (fingerprint.sha256 !== entry.source.sha256) { staleCount++; continue; }
        const key = `${entry.source.sha256}:${entry.pages.join(',')}`;
        if (seen.has(key)) continue;
        seen.add(key);
        records.push({
          readingId: entry.id, researchTopic: entry.researchTopic, researchTopics: entry.researchTopics || [entry.researchTopic], recordedAt: entry.recordedAt, method: entry.method,
          source: { title: entry.source.title, path: entry.source.path, sha256: entry.source.sha256, ...(entry.source.pageCount ? { pageCount: entry.source.pageCount } : {}) },
          pages: entry.pages, topics: entry.topics, query: entry.query, summary: entry.summary, findings: entry.findings,
          relevance: Number(relevance.toFixed(3)),
        });
        if (records.length >= 10) break;
      } catch { staleCount++; }
    }
    return { version: 1, records, staleCount };
  }
}

export const READING_MEMORY_LIMITS = { MAX_RECORDS, MAX_SUMMARY, MAX_FINDINGS, MAX_TOPICS, MAX_PAGES };
