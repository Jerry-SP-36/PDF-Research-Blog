import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ReadingMemoryStore } from '../lib/reading-memory.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pdf-reading-memory-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataDir = path.join(root, 'data'), library = path.join(root, 'library');
  await mkdir(library, { recursive: true });
  const pdf = path.join(library, 'fec-guide.pdf');
  await writeFile(pdf, '%PDF-1.7\n% FEC fixture A\n%%EOF\n');
  const store = new ReadingMemoryStore(dataDir, { pageCounter: async () => 12 }); await store.init();
  return { root, dataDir, library, pdf, store, job: { id: 'job-a', topic: '224G FEC latency and coding gain' } };
}

test('reading memory persists exact PDF fingerprint, pages, topics, conditions and findings', async t => {
  const f = await fixture(t);
  const entry = await f.store.record(f.job, {
    sourcePath: f.pdf, sourceTitle: 'FEC Guide', pages: [9, 8, 9],
    topics: ['FEC latency', 'coding gain'], query: '224G FEC latency',
    summary: 'Pages 8–9 compare latency and coding gain under a stated BER.',
    findings: [{ text: 'Latency depends on the selected code.', pages: [8], conditions: 'Pre-FEC BER 1e-4' }],
  }, [f.library]);
  assert.deepEqual(entry.pages, [8, 9]);
  assert.equal(entry.source.sha256.length, 64);
  assert.equal(entry.source.pageCount, 12);
  assert.equal(f.store.countForJob(f.job.id), 1);
  const persisted = JSON.parse(await readFile(path.join(f.dataDir, 'reading-memory.json'), 'utf8'));
  assert.equal(persisted.entries[0].topics[0], 'FEC latency');
  assert.equal(persisted.entries[0].findings[0].conditions, 'Pre-FEC BER 1e-4');
  assert.equal(Object.hasOwn(persisted.entries[0], 'wholeDocumentRead'), false);
});

test('repeated observations consolidate the same PDF page group while retaining topics and job provenance', async t => {
  const f = await fixture(t);
  await f.store.record(f.job, {
    sourcePath: f.pdf, sourceTitle: 'FEC Guide', pages: [8, 9], topics: ['FEC latency'],
    summary: 'Initial latency reading.', findings: [],
  }, [f.library]);
  await f.store.record({ id: 'job-b', topic: '224G coding gain' }, {
    sourcePath: f.pdf, sourceTitle: 'FEC Guide', pages: [9, 8], topics: ['coding gain'],
    summary: 'Later coding-gain reading.', findings: [],
  }, [f.library]);
  assert.equal(f.store.count(), 1);
  assert.equal(f.store.countForJob('job-a'), 1);
  assert.equal(f.store.countForJob('job-b'), 1);
  const entry = [...f.store.entries.values()][0];
  assert.deepEqual(entry.topics, ['coding gain', 'FEC latency']);
  assert.deepEqual(entry.jobIds, ['job-a', 'job-b']);
});

test('validated reports remember only pages with PDF Search screenshot evidence', async t => {
  const f = await fixture(t);
  const saved = await f.store.captureReport(f.job, {
    sources: [
      { id: 'S1', kind: 'pdf', title: 'FEC Guide', path: f.pdf, pagesRead: [1, 12] },
      { id: 'S2', kind: 'web', title: 'Web', url: 'https://example.org' },
    ],
    summary: [{ text: 'Supported page.', citations: [{ sourceId: 'S1', pages: [1] }] }],
    sections: [],
    evidence: [{ sourceId: 'S1', page: 1, method: 'pdf-search-screenshot', note: 'Visible page' }],
  }, [f.library]);
  assert.equal(saved.length, 1);
  assert.deepEqual(saved[0].pages, [1]);
  assert.doesNotMatch(saved[0].summary, /p\.12/);
});

test('related topics reuse unchanged page records while changed PDFs are skipped as stale', async t => {
  const f = await fixture(t);
  await f.store.record(f.job, {
    sourcePath: f.pdf, sourceTitle: 'FEC Guide', pages: [8, 9], topics: ['FEC latency', 'coding gain'],
    summary: 'Coding gain and latency comparison.', findings: [],
  }, [f.library]);
  const related = await f.store.contextFor('224G FEC latency tradeoff', [f.library]);
  assert.equal(related.records.length, 1);
  assert.deepEqual(related.records[0].pages, [8, 9]);
  assert.match(related.records[0].summary, /Coding gain/);
  await writeFile(f.pdf, '%PDF-1.7\n% FEC fixture changed\n%%EOF\n');
  const stale = await f.store.contextFor('224G FEC latency tradeoff', [f.library]);
  assert.equal(stale.records.length, 0);
  assert.equal(stale.staleCount, 1);
});

test('stale high-scoring records do not hide a lower-ranked valid record', async t => {
  const f = await fixture(t);
  const valid = await f.store.record(f.job, {
    sourcePath: f.pdf, sourceTitle: 'FEC Guide', pages: [8, 9], topics: ['coding gain'],
    summary: 'A usable related record.', findings: [],
  }, [f.library]);
  for (let index = 0; index < 17; index++) f.store.entries.set(`stale-${index}`, {
    ...valid, id: `stale-${index}`, source: { ...valid.source, sha256: '0'.repeat(64) }, pages: [index + 1],
    topics: ['224G FEC latency tradeoff'], summary: '224G FEC latency tradeoff exact match', updatedAt: `2026-09-12T00:00:${String(index).padStart(2, '0')}Z`,
  });
  const result = await f.store.contextFor('224G FEC latency tradeoff', [f.library]);
  assert.equal(result.records.length, 1);
  assert.deepEqual(result.records[0].pages, [8, 9]);
  assert.equal(result.staleCount, 17);
});

test('recording rejects unscoped files, non-PDFs and findings outside observed pages', async t => {
  const f = await fixture(t), outside = path.join(f.root, 'outside.pdf'), text = path.join(f.library, 'fake.pdf');
  await writeFile(outside, '%PDF-1.7\n%%EOF\n');
  await writeFile(text, 'not a PDF');
  const body = { sourceTitle: 'Bad', pages: [1], topics: ['FEC'], summary: 'Bad source.' };
  await assert.rejects(f.store.record(f.job, { ...body, sourcePath: outside }, [f.library]), /超出允許/);
  await assert.rejects(f.store.record(f.job, { ...body, sourcePath: text }, [f.library]), /有效 PDF/);
  await assert.rejects(f.store.record(f.job, { ...body, sourcePath: f.pdf, findings: [{ text: 'Unseen page', pages: [2] }] }, [f.library]), /不在本次閱讀頁碼/);
  await assert.rejects(f.store.record(f.job, { ...body, sourcePath: f.pdf, pages: [13] }, [f.library]), /超出 PDF 的 12 頁範圍/);
});
