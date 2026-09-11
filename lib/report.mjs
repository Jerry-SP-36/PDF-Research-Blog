import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const positive = value => Number.isSafeInteger(value) && value > 0;
const inside = (file, root) => file !== root && !path.relative(root, file).startsWith(`..${path.sep}`) && path.relative(root, file) !== '..' && !path.isAbsolute(path.relative(root, file));
const idPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;

async function prefix(file, bytes) {
  const handle = await open(file, 'r');
  try {
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
    return buffer.subarray(0, bytesRead);
  } finally { await handle.close(); }
}

async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

// Header validation only: this is deliberately not presented as full PDF/image decoding.
function imageHeaderValid(buffer, extension, size) {
  if (extension === '.png') {
    return buffer.length >= 33 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
      buffer.readUInt32BE(8) === 13 && buffer.toString('ascii', 12, 16) === 'IHDR' &&
      buffer.readUInt32BE(16) > 0 && buffer.readUInt32BE(20) > 0 &&
      [1, 2, 4, 8, 16].includes(buffer[24]) && [0, 2, 3, 4, 6].includes(buffer[25]) &&
      buffer[26] === 0 && buffer[27] === 0 && [0, 1].includes(buffer[28]);
  }
  if (extension === '.webp') {
    if (buffer.length < 25 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WEBP' || buffer.readUInt32LE(4) + 8 !== size) return false;
    const kind = buffer.toString('ascii', 12, 16);
    if (kind === 'VP8X') return buffer.length >= 30 && buffer.readUInt32LE(16) === 10;
    if (kind === 'VP8L') return buffer.length >= 25 && buffer[20] === 0x2f;
    return kind === 'VP8 ' && buffer.length >= 30 && buffer.subarray(23, 26).equals(Buffer.from([0x9d, 0x01, 0x2a])) && (buffer.readUInt16LE(26) & 0x3fff) > 0 && (buffer.readUInt16LE(28) & 0x3fff) > 0;
  }
  if (extension === '.jpg' || extension === '.jpeg') {
    if (buffer.length < 10 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return false;
    let offset = 2;
    while (offset + 4 <= buffer.length) {
      if (buffer[offset++] !== 0xff) return false;
      while (buffer[offset] === 0xff) offset++;
      const marker = buffer[offset++];
      if (marker === 0xda || marker === 0xd9) return false;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
      if (offset + 2 > buffer.length) return false;
      const length = buffer.readUInt16BE(offset);
      if (length < 2 || offset + length > buffer.length) return false;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        return length >= 8 && buffer.readUInt16BE(offset + 3) > 0 && buffer.readUInt16BE(offset + 5) > 0;
      }
      offset += length;
    }
  }
  return false;
}

/** Validate the report contract and local provenance without changing the input.
 * Source/page evidence is structural; PDF headers do not prove total page count or reading accuracy.
 * Null targets use documented research coverage instead of a fixed quota.
 * Fixed-target partial reports may have no figures; automatic reports need at least one cited source and displayed figure.
 */
export async function validateReport(input, options = {}) {
  const { jobDir, allowedSourceRoots = [], sourceTarget = 3, figureTarget = 8, requireEvidence = true } = options;
  const automaticTargets = sourceTarget === null || figureTarget === null;
  const errors = [], warnings = [];
  const fail = message => errors.push(message);
  const warn = message => warnings.push(message);
  function string(value, location, required = true) {
    if (typeof value !== 'string' || (required && !value.trim())) {
      fail(`${location}: expected ${required ? 'nonempty ' : ''}string`); return '';
    }
    if (value.includes('\0')) fail(`${location}: NUL characters are forbidden`);
    if (value.length > 100000) fail(`${location}: string exceeds 100000 characters`);
    return value.slice(0, 100000).trim();
  }
  function array(value, location, minimum = 0) {
    if (!Array.isArray(value)) { fail(`${location}: expected array`); return []; }
    if (value.length < minimum) fail(`${location}: must contain at least ${minimum} item(s)`);
    if (value.length > 1000) fail(`${location}: array exceeds 1000 items`);
    return value.slice(0, 1000);
  }
  function identifier(value, location) {
    const result = string(value, location);
    if (!idPattern.test(result)) fail(`${location}: use 1–80 letters, numbers, underscores or hyphens, starting with a letter or number`);
    return result;
  }
  function pages(value, location) {
    const result = array(value, location, 1).filter((item, index) => {
      if (!positive(item)) { fail(`${location}[${index}]: expected positive integer PDF page`); return false; }
      return true;
    });
    if (new Set(result).size !== result.length) fail(`${location}: duplicate page numbers`);
    return [...new Set(result)];
  }
  function record(value, location) {
    if (!object(value)) { fail(`${location}: expected object`); return {}; }
    return value;
  }
  const data = record(input, 'report');
  const report = {
    title: string(data.title, 'title'), summary: [], sections: [], sources: [], figures: [], evidence: [], limitations: [],
    completeness: data.completeness === 'complete' ? 'complete' : 'partial',
  };
  if (!['complete', 'partial'].includes(data.completeness)) fail('completeness: expected complete or partial');
  if ((sourceTarget !== null && !positive(sourceTarget)) || (figureTarget !== null && !positive(figureTarget))) fail('targets: sourceTarget and figureTarget must be positive integers or null for automatic coverage');
  if (typeof requireEvidence !== 'boolean') fail('requireEvidence: expected boolean');

  const sourceMap = new Map(), figureMap = new Map(), usedPages = new Set(), referencedFigures = new Set();
  for (const [index, value] of array(data.sources, 'sources', 1).entries()) {
    const where = `sources[${index}]`, item = record(value, where);
    const source = { id: identifier(item.id, `${where}.id`), title: string(item.title, `${where}.title`), path: string(item.path, `${where}.path`), pagesRead: pages(item.pagesRead, `${where}.pagesRead`) };
    if (item.relationship !== undefined) source.relationship = string(item.relationship, `${where}.relationship`);
    if (sourceMap.has(source.id)) fail(`${where}.id: duplicate source ID ${source.id}`);
    else sourceMap.set(source.id, source);
    report.sources.push(source);
  }
  function checkPage(sourceId, page, location, used = true) {
    const source = sourceMap.get(sourceId);
    if (!source) { fail(`${location}: unknown source ${sourceId}`); return false; }
    if (!positive(page) || !source.pagesRead.includes(page)) { fail(`${location}: page ${page} is not within ${sourceId}.pagesRead`); return false; }
    if (used) usedPages.add(`${sourceId}:${page}`);
    return true;
  }
  function citations(value, location) {
    const items = value === undefined ? [] : array(value, location);
    if (!items.length) warn(`${location}: claim has no citation; qualify unsupported inference explicitly`);
    return items.map((value, index) => {
      const where = `${location}[${index}]`, item = record(value, where);
      const citation = { sourceId: identifier(item.sourceId, `${where}.sourceId`), pages: pages(item.pages, `${where}.pages`) };
      for (const page of citation.pages) checkPage(citation.sourceId, page, where);
      return citation;
    });
  }
  function claim(value, location) {
    const item = record(value, location);
    return { text: string(item.text, `${location}.text`), citations: citations(item.citations, `${location}.citations`) };
  }
  for (const [index, value] of array(data.figures, 'figures').entries()) {
    const where = `figures[${index}]`, item = record(value, where);
    const figure = { id: identifier(item.id, `${where}.id`), path: string(item.path, `${where}.path`), sourceId: identifier(item.sourceId, `${where}.sourceId`), page: item.page, caption: string(item.caption, `${where}.caption`) };
    if (item.alt !== undefined) figure.alt = string(item.alt, `${where}.alt`);
    checkPage(figure.sourceId, figure.page, where, false);
    if (figureMap.has(figure.id)) fail(`${where}.id: duplicate figure ID ${figure.id}`);
    else figureMap.set(figure.id, figure);
    report.figures.push(figure);
  }
  report.summary = array(data.summary, 'summary', 1).map((value, index) => claim(value, `summary[${index}]`));
  report.sections = array(data.sections, 'sections', 1).map((value, index) => {
    const where = `sections[${index}]`, section = record(value, where);
    return { heading: string(section.heading, `${where}.heading`), blocks: array(section.blocks, `${where}.blocks`, 1).map((value, index) => {
      const blockWhere = `${where}.blocks[${index}]`, block = record(value, blockWhere);
      if (block.type === 'paragraph') return { type: 'paragraph', ...claim(block, blockWhere) };
      if (block.type === 'bullets') return { type: 'bullets', items: array(block.items, `${blockWhere}.items`, 1).map((value, index) => claim(value, `${blockWhere}.items[${index}]`)) };
      if (block.type === 'table') {
        const columns = array(block.columns, `${blockWhere}.columns`, 1).map((value, index) => string(value, `${blockWhere}.columns[${index}]`));
        const rows = array(block.rows, `${blockWhere}.rows`, 1).map((value, index) => {
          const cells = array(value, `${blockWhere}.rows[${index}]`, 1);
          if (cells.length !== columns.length) fail(`${blockWhere}.rows[${index}]: cell count must equal column count`);
          return cells.map((value, cellIndex) => string(value, `${blockWhere}.rows[${index}][${cellIndex}]`, false));
        });
        return { type: 'table', columns, rows, citations: citations(block.citations, `${blockWhere}.citations`) };
      }
      if (block.type === 'figure') {
        const figureId = identifier(block.figureId, `${blockWhere}.figureId`), figure = figureMap.get(figureId);
        if (!figure) fail(`${blockWhere}: unknown figure ${figureId}`);
        else { referencedFigures.add(figureId); checkPage(figure.sourceId, figure.page, blockWhere); }
        return { type: 'figure', figureId };
      }
      fail(`${blockWhere}.type: expected paragraph, bullets, table or figure`);
      return { type: 'paragraph', text: '', citations: [] };
    }) };
  });
  const evidencePages = new Set();
  for (const [index, value] of array(data.evidence, 'evidence').entries()) {
    const where = `evidence[${index}]`, item = record(value, where);
    const evidence = { sourceId: identifier(item.sourceId, `${where}.sourceId`), page: item.page, method: item.method };
    if (item.method !== 'pdf-search-screenshot') fail(`${where}.method: expected pdf-search-screenshot`);
    if (item.note !== undefined) evidence.note = string(item.note, `${where}.note`);
    if (checkPage(evidence.sourceId, evidence.page, where, false) && item.method === 'pdf-search-screenshot') evidencePages.add(`${evidence.sourceId}:${evidence.page}`);
    report.evidence.push(evidence);
  }
  if (requireEvidence) for (const key of usedPages) if (!evidencePages.has(key)) fail(`evidence: missing PDF Search screenshot evidence for ${key}`);
  report.limitations = array(data.limitations, 'limitations').map((value, index) => string(value, `limitations[${index}]`));
  if (automaticTargets || data.researchCoverage !== undefined) {
    const coverage = record(data.researchCoverage, 'researchCoverage');
    const stopReason = string(coverage.stopReason, 'researchCoverage.stopReason');
    if (!['saturated', 'time_limit', 'source_exhausted'].includes(stopReason)) fail('researchCoverage.stopReason: expected saturated, time_limit or source_exhausted');
    const questions = array(coverage.questions, 'researchCoverage.questions', 1).map((value, index) => {
      const where = `researchCoverage.questions[${index}]`, item = record(value, where);
      const question = string(item.question, `${where}.question`);
      const answerStatus = string(item.answerStatus, `${where}.answerStatus`);
      if (!['supported', 'uncertain', 'not_found'].includes(answerStatus)) fail(`${where}.answerStatus: expected supported, uncertain or not_found`);
      const sourceIds = array(item.sourceIds, `${where}.sourceIds`, answerStatus === 'supported' ? 1 : 0).map((value, index) => {
        const id = identifier(value, `${where}.sourceIds[${index}]`);
        if (!sourceMap.has(id)) fail(`${where}.sourceIds[${index}]: unknown source ${id}`);
        return id;
      });
      if (new Set(sourceIds).size !== sourceIds.length) fail(`${where}.sourceIds: duplicate source IDs`);
      if (['uncertain', 'not_found'].includes(answerStatus)) warn(`${where}: question remains ${answerStatus}`);
      return { question, answerStatus, sourceIds: [...new Set(sourceIds)] };
    });
    report.researchCoverage = { questions, stopReason, summary: string(coverage.summary, 'researchCoverage.summary') };
    if (stopReason === 'time_limit') warn('researchCoverage: research stopped at the time limit; coverage remains partial');
  }

  let realJobDir = '';
  try {
    if (typeof jobDir !== 'string' || !path.isAbsolute(jobDir)) throw new Error('jobDir must be absolute');
    realJobDir = await realpath(jobDir);
    if (!(await stat(realJobDir)).isDirectory()) throw new Error('jobDir must be a directory');
  } catch (error) { fail(`jobDir: ${error.message}`); }
  const roots = [];
  if (!Array.isArray(allowedSourceRoots) || !allowedSourceRoots.length) fail('allowedSourceRoots: at least one explicit source directory is required');
  else for (const root of allowedSourceRoots) {
    try {
      if (typeof root !== 'string' || !path.isAbsolute(root)) throw new Error('root must be absolute');
      const resolved = await realpath(root);
      if (!(await stat(resolved)).isDirectory()) throw new Error('root must be a directory');
      roots.push(resolved);
    } catch (error) { fail(`allowedSourceRoots: ${error.message}`); }
  }
  const sourceHashes = new Map(), validSourceIds = new Set();
  for (const source of report.sources) {
    try {
      if (!path.isAbsolute(source.path)) throw new Error('source path must be absolute');
      const file = await realpath(source.path);
      if (!roots.some(root => inside(file, root))) throw new Error('source escapes allowedSourceRoots');
      if (path.extname(file).toLowerCase() !== '.pdf' || !(await stat(file)).isFile()) throw new Error('source must be an existing PDF file');
      if ((await prefix(file, 5)).toString('ascii') !== '%PDF-') throw new Error('invalid PDF header');
      source.path = file;
      const hash = await sha256(file);
      if (sourceHashes.has(hash)) fail(`sources.${source.id}: duplicate PDF content of ${sourceHashes.get(hash)} (SHA-256)`);
      else { sourceHashes.set(hash, source.id); validSourceIds.add(source.id); }
    } catch (error) { fail(`sources.${source.id}: ${error.message}`); }
  }
  const figureHashes = new Map();
  for (const figure of report.figures) {
    if (!referencedFigures.has(figure.id)) warn(`figures.${figure.id}: unreferenced image is excluded from figure count`);
    try {
      if (!realJobDir) throw new Error('valid jobDir is required');
      const file = await realpath(path.resolve(realJobDir, figure.path));
      if (!inside(file, path.join(realJobDir, 'report-assets'))) throw new Error('figure escapes jobDir/report-assets');
      const details = await stat(file), extension = path.extname(file).toLowerCase();
      if (!details.isFile() || !['.png', '.jpg', '.jpeg', '.webp'].includes(extension)) throw new Error('figure must be an existing PNG, JPEG or WebP file');
      if (!imageHeaderValid(await prefix(file, Math.min(details.size, 1024 * 1024)), extension, details.size)) throw new Error('invalid image header');
      figure.path = file;
      if (referencedFigures.has(figure.id)) {
        const hash = await sha256(file);
        if (figureHashes.has(hash)) warn(`figures.${figure.id}: duplicate image content of ${figureHashes.get(hash)}; counted once`);
        else figureHashes.set(hash, figure.id);
      }
    } catch (error) { fail(`figures.${figure.id}: ${error.message}`); }
  }
  const citedSourceIds = new Set([...usedPages].map(key => key.slice(0, key.lastIndexOf(':'))));
  for (const source of report.sources) if (!citedSourceIds.has(source.id)) warn(`sources.${source.id}: source is not cited in the report and is excluded from source count`);
  const stats = { sources: [...validSourceIds].filter(id => citedSourceIds.has(id)).length, figures: figureHashes.size };
  if (automaticTargets && stats.sources < 1) fail('automatic coverage: at least one valid unique cited PDF source is required');
  if (automaticTargets && stats.figures < 1) fail('automatic coverage: at least one valid unique displayed figure is required');
  if (sourceTarget !== null && stats.sources < sourceTarget) warn(`Only ${stats.sources} unique cited PDF source(s); target is ${sourceTarget}`);
  if (figureTarget !== null && stats.figures < figureTarget) warn(`Only ${stats.figures} unique displayed figure(s); target is ${figureTarget}`);
  if (warnings.length || errors.length) report.completeness = 'partial';
  if (report.completeness === 'partial' && !report.limitations.length) warn('limitations: a partial report should state what is missing or uncertain');
  return { valid: errors.length === 0, errors, warnings, stats, report };
}

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const escapeMarkdown = value => String(value ?? '').replace(/\\/g, '\\\\').replace(/([`*_{}[\]<>!|#])/g, '\\$1');
const markdownPath = value => String(value).split('/').map(segment => encodeURIComponent(segment)).join('/');
const pageLabel = pages => pages.length === 1 ? `PDF p.${pages[0]}` : `PDF pp.${pages.join('、')}`;
const coverageScopeNote = '研究範圍僅限本次可用的本地 PDF 來源；結束搜尋不代表所有已出版資料均已涵蓋。';

function makeContext(report, jobId) {
  const sources = new Map(report.sources.map(source => [source.id, source]));
  const figures = new Map(report.figures.map(figure => [figure.id, figure]));
  const base = `/api/jobs/${encodeURIComponent(String(jobId ?? ''))}`;
  function htmlCitations(citations = []) {
    return citations.flatMap(citation => {
      const source = sources.get(citation.sourceId);
      if (!source) return [];
      return citation.pages.length ? [`<a class="source-citation" href="${base}/sources/${encodeURIComponent(source.id)}#page=${encodeURIComponent(citation.pages[0])}" target="_blank" rel="noopener" title="${escapeHtml(source.path)}">《${escapeHtml(source.title)}》，${escapeHtml(pageLabel(citation.pages))}</a>`] : [];
    }).join('；');
  }
  function mdCitations(citations = []) {
    return citations.flatMap(citation => {
      const source = sources.get(citation.sourceId);
      if (!source) return [];
      return citation.pages.length ? [`[《${escapeMarkdown(source.title)}》，${escapeMarkdown(pageLabel(citation.pages))}](<${markdownPath(source.path)}>)`] : [];
    }).join('；');
  }
  return { sources, figures, base, htmlCitations, mdCitations };
}

/** Render only synthesized content, figures, limitations and compact sources; never collection logs. */
export function renderMarkdown(report) {
  const context = makeContext(report);
  const cite = citations => { const result = context.mdCitations(citations); return result ? ` ${result}` : ''; };
  const lines = [`# ${escapeMarkdown(report.title)}`, ''];
  if (report.completeness === 'partial') lines.push('> 研究狀態：部分完成；請參閱文末限制。', '');
  for (const item of report.summary) lines.push(`${escapeMarkdown(item.text)}${cite(item.citations)}`, '');
  for (const section of report.sections) {
    lines.push(`## ${escapeMarkdown(section.heading)}`, '');
    for (const block of section.blocks) {
      if (block.type === 'paragraph') lines.push(`${escapeMarkdown(block.text)}${cite(block.citations)}`, '');
      else if (block.type === 'bullets') { for (const item of block.items) lines.push(`- ${escapeMarkdown(item.text)}${cite(item.citations)}`); lines.push(''); }
      else if (block.type === 'table') {
        const cell = value => escapeMarkdown(value).replace(/\r?\n/g, ' ');
        lines.push(`| ${block.columns.map(cell).join(' | ')} |`, `| ${block.columns.map(() => '---').join(' | ')} |`, ...block.rows.map(row => `| ${row.map(cell).join(' | ')} |`), '', context.mdCitations(block.citations), '');
      } else if (block.type === 'figure') {
        const figure = context.figures.get(block.figureId);
        if (figure) lines.push(`![${escapeMarkdown(figure.alt || figure.caption)}](<${markdownPath(figure.path)}>)`, '', `${escapeMarkdown(figure.caption)}${cite([{ sourceId: figure.sourceId, pages: [figure.page] }])}`, '');
      }
    }
  }
  if (report.researchCoverage) lines.push('## 研究範圍', '', escapeMarkdown(report.researchCoverage.summary), '', coverageScopeNote, '');
  if (report.limitations.length) lines.push('## 限制與待確認事項', '', ...report.limitations.map(value => `- ${escapeMarkdown(value)}`), '');
  lines.push('## 資料來源', '', ...report.sources.map(source => `- [《${escapeMarkdown(source.title)}》](<${markdownPath(source.path)}>)${source.relationship ? ` — ${escapeMarkdown(source.relationship)}` : ''}`), '', '圖表取自所標示的原始文件，權利屬原作者或權利人。', '');
  return lines.join('\n');
}

/** HTML is escaped plain text; no Markdown, raw HTML or external script execution. */
export function renderHtml(report, { jobId } = {}) {
  const context = makeContext(report, jobId);
  const cite = citations => { const result = context.htmlCitations(citations); return result ? ` <span class="citations">${result}</span>` : ''; };
  const claim = item => `${escapeHtml(item.text)}${cite(item.citations)}`;
  const sections = report.sections.map(section => `<section><h2>${escapeHtml(section.heading)}</h2>${section.blocks.map(block => {
    if (block.type === 'paragraph') return `<p>${claim(block)}</p>`;
    if (block.type === 'bullets') return `<ul>${block.items.map(item => `<li>${claim(item)}</li>`).join('')}</ul>`;
    if (block.type === 'table') return `<div class="table-wrap"><table><thead><tr>${block.columns.map(value => `<th>${escapeHtml(value)}</th>`).join('')}</tr></thead><tbody>${block.rows.map(row => `<tr>${row.map(value => `<td>${escapeHtml(value)}</td>`).join('')}</tr>`).join('')}</tbody></table></div><p class="table-sources">${context.htmlCitations(block.citations)}</p>`;
    if (block.type === 'figure') {
      const figure = context.figures.get(block.figureId);
      if (!figure) return '';
      const url = `${context.base}/figures/${encodeURIComponent(figure.id)}`;
      return `<figure><a href="${url}" target="_blank" rel="noopener"><img loading="lazy" src="${url}" alt="${escapeHtml(figure.alt || figure.caption)}"></a><figcaption>${escapeHtml(figure.caption)}${cite([{ sourceId: figure.sourceId, pages: [figure.page] }])}</figcaption></figure>`;
    }
    return '';
  }).join('')}</section>`).join('');
  const coverage = report.researchCoverage ? `<section class="research-coverage"><h2>研究範圍</h2><p>${escapeHtml(report.researchCoverage.summary)}</p><p>${coverageScopeNote}</p></section>` : '';
  const limitations = report.limitations.length ? `<section class="limitations"><h2>限制與待確認事項</h2><ul>${report.limitations.map(value => `<li>${escapeHtml(value)}</li>`).join('')}</ul></section>` : '';
  const bibliography = `<section class="bibliography"><h2>資料來源</h2><ul>${report.sources.map(source => `<li><a href="${context.base}/sources/${encodeURIComponent(source.id)}" target="_blank" rel="noopener" title="${escapeHtml(source.path)}">《${escapeHtml(source.title)}》</a>${source.relationship ? ` — ${escapeHtml(source.relationship)}` : ''}</li>`).join('')}</ul></section>`;
  return `<article class="research-report"><h1>${escapeHtml(report.title)}</h1>${report.completeness === 'partial' ? '<p class="status">研究狀態：部分完成；請參閱文末限制。</p>' : ''}<div class="summary">${report.summary.map(item => `<p>${claim(item)}</p>`).join('')}</div>${sections}${coverage}${limitations}${bibliography}<footer>圖表取自所標示的原始文件，權利屬原作者或權利人。</footer></article>`;
}
