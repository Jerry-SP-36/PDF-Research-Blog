import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, copyFile, symlink, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { validateReport, renderMarkdown, renderHtml } from '../lib/report.mjs';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const citation = (sourceId = 'paper-a', pages = [1]) => [{ sourceId, pages }];

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pdf-report-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sources = path.join(root, 'source-library'), jobDir = path.join(root, 'job'), assets = path.join(jobDir, 'report-assets');
  await mkdir(sources, { recursive: true }); await mkdir(assets, { recursive: true });
  const pdf = path.join(sources, 'paper a.pdf'), image = path.join(assets, 'figure.png');
  await writeFile(pdf, '%PDF-1.7\n% Structural fixture A; not a full parser fixture.\n%%EOF\n');
  await writeFile(image, png);
  return { root, sources, jobDir, assets, pdf, image, options: { jobDir, allowedSourceRoots: [sources], sourceTarget: 1, figureTarget: 1 }, report: {
    title: '本地主題研究',
    summary: [{ text: '來源支持的核心結論。', citations: citation('paper-a', [1, 2]) }],
    sections: [{ heading: '機制與工程影響', blocks: [
      { type: 'paragraph', text: '段落包含來源條件。', citations: citation() },
      { type: 'figure', figureId: 'figure-a' },
      { type: 'table', columns: ['條件', '觀察'], rows: [['已知条件', '來源觀察']], citations: citation() },
      { type: 'bullets', items: [{ text: '保留適用條件。', citations: citation() }] },
    ] }],
    sources: [{ id: 'paper-a', title: 'Article A', path: pdf, pagesRead: [1, 2], relationship: '原始研究' }],
    figures: [{ id: 'figure-a', path: image, sourceId: 'paper-a', page: 1, caption: '來源原圖與解讀。', alt: '原始圖表' }],
    evidence: [{ sourceId: 'paper-a', page: 1, method: 'pdf-search-screenshot', note: 'PRIVATE_COLLECTION_TRACE' }, { sourceId: 'paper-a', page: 2, method: 'pdf-search-screenshot' }],
    limitations: [], completeness: 'complete',
  } };
}

test('valid report normalizes real paths, leaves input intact, and cites next to claims', async t => {
  const f = await fixture(t), original = structuredClone(f.report);
  f.report.figures[0].path = 'report-assets/figure.png';
  const result = await validateReport(f.report, f.options);
  assert.equal(result.valid, true, result.errors.join('\n'));
  assert.deepEqual(result.stats, { sources: 1, webSources: 0, figures: 1 });
  assert.equal(result.report.completeness, 'complete');
  assert.equal(result.report.figures[0].path, f.image.replace(/^\/var\//, '/private/var/'));
  assert.equal(f.report.figures[0].path, 'report-assets/figure.png');
  f.report.figures[0].path = original.figures[0].path;
  assert.deepEqual(f.report, original);
  const markdown = renderMarkdown(result.report), html = renderHtml(result.report, { jobId: 'test-job' });
  assert.match(markdown, /來源支持的核心結論。 \[《Article A》，PDF pp\.1、2\]/);
  assert.match(markdown, /paper%20a\.pdf/);
  assert.match(html, /class="source-citation" href="\/api\/jobs\/test-job\/sources\/paper-a#page=1"/);
  assert.match(html, /《Article A》，PDF pp\.1、2/);
  assert.match(html, /src="\/api\/jobs\/test-job\/figures\/figure-a"/);
  assert.match(html, /^<article class="research-report">/);
  for (const output of [markdown, html]) {
    assert.doesNotMatch(output, /PRIVATE_COLLECTION_TRACE|pagesRead|pdf-search-screenshot|逐頁收集|操作紀錄/);
    assert.match(output, /圖表取自所標示/);
  }
});

test('rejects symlink escapes for both source PDFs and figure assets', async t => {
  const f = await fixture(t), externalPdf = path.join(f.root, 'external.pdf'), externalImage = path.join(f.root, 'external.png');
  await copyFile(f.pdf, externalPdf); await writeFile(externalImage, png);
  await symlink(externalPdf, path.join(f.sources, 'escaped.pdf'));
  await symlink(externalImage, path.join(f.assets, 'escaped.png'));
  f.report.sources[0].path = path.join(f.sources, 'escaped.pdf');
  f.report.figures[0].path = path.join(f.assets, 'escaped.png');
  const result = await validateReport(f.report, f.options);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(error => error.includes('source escapes allowedSourceRoots')));
  assert.ok(result.errors.some(error => error.includes('figure escapes jobDir/report-assets')));
});

test('rejects traversal and a report-assets root symlink that points outside the job', async t => {
  const f = await fixture(t);
  await copyFile(f.image, path.join(f.root, 'outside.png'));
  f.report.figures[0].path = '../outside.png';
  const traversal = await validateReport(f.report, f.options);
  assert.equal(traversal.valid, false);
  assert.ok(traversal.errors.some(error => error.includes('figure escapes')));
  await rm(f.assets, { recursive: true });
  await symlink(f.root, f.assets);
  f.report.figures[0].path = 'report-assets/outside.png';
  const rootSymlink = await validateReport(f.report, f.options);
  assert.equal(rootSymlink.valid, false);
  assert.ok(rootSymlink.errors.some(error => error.includes('figure escapes')));
});

test('unknown source, unread pages, empty page list, duplicate IDs and inconsistent tables are errors', async t => {
  const f = await fixture(t);
  f.report.summary[0].citations = citation('unknown', [1]);
  f.report.sections[0].blocks[0].citations = citation('paper-a', [3]);
  f.report.sections[0].blocks[2].rows = [['too', 'many', 'cells']];
  f.report.sections[0].blocks[3].items[0].citations = citation('paper-a', []);
  f.report.sources.push(structuredClone(f.report.sources[0]));
  f.report.figures.push(structuredClone(f.report.figures[0]));
  const result = await validateReport(f.report, f.options);
  assert.equal(result.valid, false);
  for (const fragment of ['unknown source unknown', 'page 3 is not within', 'cell count', 'at least 1', 'duplicate source ID', 'duplicate figure ID']) assert.ok(result.errors.some(error => error.includes(fragment)), fragment);
});

test('requires screenshot evidence for every used page and accepts explicit opt-out', async t => {
  const f = await fixture(t);
  f.report.evidence = [];
  const required = await validateReport(f.report, f.options);
  assert.equal(required.valid, false);
  assert.ok(required.errors.some(error => error.endsWith('paper-a:1')));
  assert.ok(required.errors.some(error => error.endsWith('paper-a:2')));
  const optional = await validateReport(f.report, { ...f.options, requireEvidence: false });
  assert.equal(optional.valid, true, optional.errors.join('\n'));
  f.report.evidence = [{ sourceId: 'paper-a', page: 1, method: 'text-extraction' }];
  const incorrect = await validateReport(f.report, { ...f.options, requireEvidence: false });
  assert.equal(incorrect.valid, false);
  assert.ok(incorrect.errors.some(error => error.includes('expected pdf-search-screenshot')));
});

test('rejects missing files and spoofed PDF/image headers including SVG disguised as PNG', async t => {
  const f = await fixture(t);
  f.report.figures[0].path = path.join(f.assets, 'missing.png');
  const missing = await validateReport(f.report, f.options);
  assert.equal(missing.valid, false);
  assert.ok(missing.errors.some(error => error.includes('ENOENT')));
  await writeFile(f.image, '<svg onload="alert(1)"></svg>');
  await writeFile(f.pdf, 'this is not a PDF');
  f.report.figures[0].path = f.image;
  const invalid = await validateReport(f.report, f.options);
  assert.equal(invalid.valid, false);
  assert.ok(invalid.errors.some(error => error.includes('invalid PDF header')));
  assert.ok(invalid.errors.some(error => error.includes('invalid image header')));
});

test('same PDF under another filename fails SHA-256 deduplication', async t => {
  const f = await fixture(t), copy = path.join(f.sources, 'renamed.pdf');
  await copyFile(f.pdf, copy);
  f.report.sources.push({ ...structuredClone(f.report.sources[0]), id: 'paper-b', path: copy });
  f.report.summary[0].citations.push({ sourceId: 'paper-b', pages: [1] });
  f.report.evidence.push({ sourceId: 'paper-b', page: 1, method: 'pdf-search-screenshot' });
  const result = await validateReport(f.report, f.options);
  assert.equal(result.valid, false);
  assert.equal(result.stats.sources, 1);
  assert.ok(result.errors.some(error => error.includes('duplicate PDF content')));
});

test('duplicate figures count once; uncited documents and unused images do not inflate targets', async t => {
  const f = await fixture(t), secondPdf = path.join(f.sources, 'new.pdf'), secondImage = path.join(f.assets, 'renamed.png');
  await writeFile(secondPdf, '%PDF-1.7\n% Genuine distinct content B\n%%EOF\n');
  await copyFile(f.image, secondImage);
  f.report.sources.push({ ...structuredClone(f.report.sources[0]), id: 'paper-b', path: secondPdf });
  f.report.figures.push({ ...structuredClone(f.report.figures[0]), id: 'figure-b', path: secondImage });
  f.report.sections[0].blocks.push({ type: 'figure', figureId: 'figure-b' });
  const result = await validateReport(f.report, { ...f.options, sourceTarget: 2, figureTarget: 2 });
  assert.equal(result.valid, true, result.errors.join('\n'));
  assert.deepEqual(result.stats, { sources: 1, webSources: 0, figures: 1 });
  assert.equal(result.report.completeness, 'partial');
  assert.ok(result.warnings.some(warning => warning.includes('duplicate image content')));
  assert.ok(result.warnings.some(warning => warning.includes('source is not cited')));
  f.report.sections[0].blocks.pop();
  const unused = await validateReport(f.report, f.options);
  assert.ok(unused.warnings.some(warning => warning.includes('unreferenced image')));
});

test('missing claim citations and unmet targets produce honest partial reports, not fabricated data', async t => {
  const f = await fixture(t);
  f.report.summary[0].citations = [];
  f.report.figures = [];
  f.report.sections[0].blocks = f.report.sections[0].blocks.filter(block => block.type !== 'figure');
  f.report.limitations = ['資料不足，尚無可用原圖。'];
  const result = await validateReport(f.report, { ...f.options, sourceTarget: 3, figureTarget: 8 });
  assert.equal(result.valid, true, result.errors.join('\n'));
  assert.deepEqual(result.stats, { sources: 1, webSources: 0, figures: 0 });
  assert.equal(result.report.completeness, 'partial');
  assert.ok(result.warnings.some(warning => warning.includes('claim has no citation')));
  assert.equal(result.report.figures.length, 0);
  assert.match(renderHtml(result.report, { jobId: 'x' }), /部分完成/);
});

test('HTML escapes all report fields and routes; Markdown cannot inject HTML or links through text', async t => {
  const f = await fixture(t), injection = '<script>alert("x")</script><img src=x onerror="boom"> [click](javascript:bad)';
  f.report.title = injection;
  f.report.summary[0].text = injection;
  f.report.sections[0].heading = injection;
  f.report.sections[0].blocks[0].text = injection;
  f.report.sections[0].blocks[2].columns[0] = injection;
  f.report.sections[0].blocks[2].rows[0][0] = injection;
  f.report.sections[0].blocks[3].items[0].text = injection;
  f.report.sources[0].title = injection;
  f.report.sources[0].relationship = injection;
  f.report.figures[0].caption = injection;
  f.report.figures[0].alt = injection;
  f.report.limitations = [injection];
  const result = await validateReport(f.report, f.options);
  assert.equal(result.valid, true, result.errors.join('\n'));
  const html = renderHtml(result.report, { jobId: '"><script>evil</script>' });
  assert.doesNotMatch(html, /<script>|<img src=x|alt="<|href="javascript:|<style|<html/);
  assert.match(html, /&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt;/);
  assert.equal((html.match(/<img /g) || []).length, 1);
  assert.match(html, /jobs\/%22%3E%3Cscript%3Eevil%3C%2Fscript%3E/);
  const markdown = renderMarkdown(result.report);
  assert.match(markdown, /\\<script\\>/);
  assert.match(markdown, /\\\[click\\\]\(javascript:bad\)/);
});

test('invalid report and structural empty arrays return validation errors without throwing', async t => {
  const f = await fixture(t);
  const invalid = await validateReport(null, f.options);
  assert.equal(invalid.valid, false);
  f.report.summary = []; f.report.sections[0].blocks = []; f.report.sources[0].pagesRead = [0, -1, 1.2];
  const empty = await validateReport(f.report, f.options);
  assert.equal(empty.valid, false);
  assert.ok(empty.errors.some(error => error.includes('summary: must contain')));
  assert.ok(empty.errors.some(error => error.includes('blocks: must contain')));
  assert.ok(empty.errors.some(error => error.includes('positive integer PDF page')));
});

function researchCoverage(stopReason = 'saturated', answerStatus = 'supported') {
  return {
    questions: [{ question: 'PRIVATE_COVERAGE_QUESTION: Which source conditions support the conclusion?', answerStatus, sourceIds: answerStatus === 'supported' ? ['paper-a'] : [] }],
    stopReason,
    summary: '本次核對本地 PDF 的主要結構與來源條件，已取得可回答研究問題的資料。',
  };
}

test('null targets validate automatic coverage without inheriting fixed 3-source or 8-figure quotas', async t => {
  const f = await fixture(t); f.report.researchCoverage = researchCoverage();
  const original = structuredClone(f.report);
  for (const targets of [{ sourceTarget: null, figureTarget: null }, { sourceTarget: null, figureTarget: 1 }, { sourceTarget: 1, figureTarget: null }]) {
    const result = await validateReport(f.report, { ...f.options, ...targets });
    assert.equal(result.valid, true, result.errors.join('\n'));
    assert.deepEqual(result.stats, { sources: 1, webSources: 0, figures: 1 });
    assert.deepEqual(result.warnings, []);
    assert.equal(result.report.completeness, 'complete');
    assert.deepEqual(result.report.researchCoverage, f.report.researchCoverage);
  }
  assert.deepEqual(f.report, original);
});

test('omitted targets retain defaults and a fixed target is still enforced beside an automatic target', async t => {
  const f = await fixture(t);
  const legacy = await validateReport(f.report, { jobDir: f.jobDir, allowedSourceRoots: [f.sources] });
  assert.equal(legacy.valid, true, legacy.errors.join('\n')); assert.equal(legacy.report.completeness, 'partial');
  assert.ok(legacy.warnings.some(warning => warning.includes('target is 3')));
  assert.ok(legacy.warnings.some(warning => warning.includes('target is 8')));
  assert.equal(Object.hasOwn(legacy.report, 'researchCoverage'), false);
  f.report.researchCoverage = researchCoverage();
  const fixedFigures = await validateReport(f.report, { ...f.options, sourceTarget: null, figureTarget: 2 });
  assert.equal(fixedFigures.valid, true); assert.equal(fixedFigures.report.completeness, 'partial');
  assert.ok(fixedFigures.warnings.some(warning => warning.includes('displayed figure(s); target is 2')));
  assert.equal(fixedFigures.warnings.some(warning => warning.includes('cited PDF source(s); target')), false);
  const fixedSources = await validateReport(f.report, { ...f.options, sourceTarget: 2, figureTarget: null });
  assert.equal(fixedSources.valid, true); assert.equal(fixedSources.report.completeness, 'partial');
  assert.ok(fixedSources.warnings.some(warning => warning.includes('cited PDF source(s); target is 2')));
});

test('automatic targets require researchCoverage with nonempty questions and summary', async t => {
  const f = await fixture(t), options = { ...f.options, sourceTarget: null, figureTarget: null };
  const missing = await validateReport(f.report, options);
  assert.equal(missing.valid, false); assert.ok(missing.errors.some(error => error.includes('researchCoverage: expected object')));
  f.report.researchCoverage = { questions: [], stopReason: 'saturated', summary: '   ' };
  const empty = await validateReport(f.report, options);
  assert.equal(empty.valid, false);
  assert.ok(empty.errors.some(error => error.includes('researchCoverage.questions: must contain at least 1')));
  assert.ok(empty.errors.some(error => error.includes('researchCoverage.summary: expected nonempty string')));
});

test('coverage rejects unknown/malformed/duplicate source IDs and unsupported question contracts', async t => {
  const f = await fixture(t), options = { ...f.options, sourceTarget: null, figureTarget: null };
  const cases = [
    [{ sourceIds: ['missing'] }, 'unknown source missing'],
    [{ sourceIds: ['../outside'] }, 'letters, numbers, underscores or hyphens'],
    [{ sourceIds: ['paper-a', 'paper-a'] }, 'duplicate source IDs'],
    [{ sourceIds: [] }, 'sourceIds: must contain at least 1'],
    [{ sourceIds: null }, 'sourceIds: expected array'],
    [{ question: '' }, 'question: expected nonempty string'],
    [{ answerStatus: 'complete' }, 'answerStatus: expected supported, uncertain or not_found'],
  ];
  for (const [change, errorFragment] of cases) {
    f.report.researchCoverage = researchCoverage(); Object.assign(f.report.researchCoverage.questions[0], change);
    const result = await validateReport(f.report, options);
    assert.equal(result.valid, false, JSON.stringify(change));
    assert.ok(result.errors.some(error => error.includes(errorFragment)), result.errors.join('\n'));
  }
  f.report.researchCoverage = researchCoverage('all_world_sources_covered');
  const reason = await validateReport(f.report, options);
  assert.equal(reason.valid, false); assert.ok(reason.errors.some(error => error.includes('researchCoverage.stopReason: expected')));
});

test('automatic coverage needs at least one genuine cited source and one displayed figure', async t => {
  const f = await fixture(t), options = { ...f.options, sourceTarget: null, figureTarget: null };
  f.report.researchCoverage = researchCoverage();
  f.report.figures = []; f.report.sections[0].blocks = f.report.sections[0].blocks.filter(block => block.type !== 'figure');
  const noFigure = await validateReport(f.report, options);
  assert.equal(noFigure.valid, false); assert.deepEqual(noFigure.stats, { sources: 1, webSources: 0, figures: 0 });
  assert.ok(noFigure.errors.some(error => error.includes('at least one valid unique displayed figure')));
  f.report.summary[0].citations = [];
  for (const block of f.report.sections[0].blocks) {
    if (block.type === 'bullets') for (const item of block.items) item.citations = [];
    else block.citations = [];
  }
  const noCitation = await validateReport(f.report, options);
  assert.equal(noCitation.valid, false); assert.equal(noCitation.stats.sources, 0);
  assert.ok(noCitation.errors.some(error => error.includes('at least one valid unique cited PDF source')));
});

test('time limits and unresolved questions make coverage partial while a bounded exhausted library can be complete', async t => {
  const f = await fixture(t), options = { ...f.options, sourceTarget: null, figureTarget: null };
  for (const [reason, answer, fragment] of [['time_limit', 'supported', 'time limit'], ['saturated', 'uncertain', 'question remains uncertain'], ['source_exhausted', 'not_found', 'question remains not_found']]) {
    f.report.researchCoverage = researchCoverage(reason, answer);
    const result = await validateReport(f.report, options);
    assert.equal(result.valid, true, result.errors.join('\n')); assert.equal(result.report.completeness, 'partial');
    assert.ok(result.warnings.some(warning => warning.includes(fragment)));
  }
  f.report.researchCoverage = researchCoverage('source_exhausted');
  f.report.researchCoverage.summary = '已整理本次本地 PDF 庫可取得的相關內容，未找到進一步補充來源。';
  const exhausted = await validateReport(f.report, options);
  assert.equal(exhausted.valid, true); assert.equal(exhausted.report.completeness, 'complete'); assert.deepEqual(exhausted.warnings, []);
  for (const output of [renderMarkdown(exhausted.report), renderHtml(exhausted.report, { jobId: 'auto' })]) {
    assert.match(output, /研究範圍/); assert.ok(output.includes(f.report.researchCoverage.summary));
    assert.match(output, /僅限本次可用的本地 PDF 來源/); assert.match(output, /不代表所有已出版資料均已涵蓋/);
    assert.doesNotMatch(output, /PRIVATE_COVERAGE_QUESTION|PRIVATE_COLLECTION_TRACE|source_exhausted|pdf-search-screenshot/);
  }
});

test('coverage summary is escaped and automatic mode preserves citation/evidence validation', async t => {
  const f = await fixture(t), options = { ...f.options, sourceTarget: null, figureTarget: null };
  f.report.researchCoverage = researchCoverage(); f.report.researchCoverage.summary = '<script>unsafe()</script> [bad](javascript:bad)';
  let result = await validateReport(f.report, options);
  assert.equal(result.valid, true);
  const html = renderHtml(result.report, { jobId: 'auto' }), markdown = renderMarkdown(result.report);
  assert.match(html, /&lt;script&gt;unsafe\(\)&lt;\/script&gt;/); assert.doesNotMatch(html, /<script>|href="javascript:/);
  assert.match(markdown, /\\<script\\>/); assert.match(markdown, /\\\[bad\\\]/);
  f.report.evidence = [];
  result = await validateReport(f.report, options);
  assert.equal(result.valid, false); assert.ok(result.errors.some(error => error.includes('missing PDF Search screenshot evidence')));
});

test('mixed PDF and web reports keep source types, direct HTTPS links and separate counts', async t => {
  const f = await fixture(t);
  f.report.sources.push({
    id: 'web-a', kind: 'web', title: 'Official <Status>',
    url: 'https://standards.example.org/status?q=224G&view=full',
    accessedAt: '2026-09-11T08:00:00+08:00', publishedAt: '2026-09-10', relationship: '近期狀態',
  });
  f.report.summary.push({ text: '官方頁面補充近期狀態。', citations: [{ sourceId: 'web-a' }] });
  const result = await validateReport(f.report, { ...f.options, allowWebSources: true });
  assert.equal(result.valid, true, result.errors.join('\n'));
  assert.deepEqual(result.stats, { sources: 1, webSources: 1, figures: 1 });
  assert.equal(result.report.sources[0].kind, 'pdf');
  assert.equal(result.report.sources[1].accessedAt, '2026-09-11T00:00:00.000Z');
  const markdown = renderMarkdown(result.report), html = renderHtml(result.report, { jobId: 'web-job' });
  assert.match(markdown, /\[《Official \\<Status\\>》\]\(<https:\/\/standards\.example\.org\/status\?q=224G&view=full>\)/);
  assert.match(markdown, /網頁，存取於 2026-09-11/);
  assert.match(html, /href="https:\/\/standards\.example\.org\/status\?q=224G&amp;view=full"/);
  assert.match(html, /rel="noopener noreferrer"/);
  assert.doesNotMatch(html, /sources\/web-a/);
});

test('web sources are opt-in HTTPS evidence without PDF pages or figure authority', async t => {
  const f = await fixture(t);
  f.report.sources.push({ id: 'web-a', kind: 'web', title: 'Official status', url: 'https://example.org/status', accessedAt: '2026-09-11' });
  f.report.summary.push({ text: 'Current status.', citations: [{ sourceId: 'web-a' }] });
  const disabled = await validateReport(f.report, f.options);
  assert.equal(disabled.valid, false);
  assert.ok(disabled.errors.some(error => error.includes('web sources are not allowed')));

  f.report.summary.at(-1).citations[0].pages = [1];
  const fakePages = await validateReport(f.report, { ...f.options, allowWebSources: true });
  assert.equal(fakePages.valid, false);
  assert.ok(fakePages.errors.some(error => error.includes('web citations must not include PDF pages')));

  delete f.report.summary.at(-1).citations[0].pages;
  f.report.sources.at(-1).url = 'http://example.org/status';
  const insecure = await validateReport(f.report, { ...f.options, allowWebSources: true });
  assert.equal(insecure.valid, false);
  assert.ok(insecure.errors.some(error => error.includes('must be an HTTPS URL')));

  f.report.sources.at(-1).url = 'https://example.org/status';
  f.report.figures[0].sourceId = 'web-a';
  const webFigure = await validateReport(f.report, { ...f.options, allowWebSources: true });
  assert.equal(webFigure.valid, false);
  assert.ok(webFigure.errors.some(error => error.includes('cannot have PDF pages')));
});
