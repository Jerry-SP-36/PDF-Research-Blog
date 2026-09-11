import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../server.mjs';

const TOKEN = 'test-bootstrap-capability-0123456789abcdef';
const SESSION = `pdf_research_session=${TOKEN}`;

// Use HTTP rather than a browser so Host, Origin and the exact unnormalized request path are testable.
function request(origin, target, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(origin, { path: target, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => {
        const bytes = Buffer.concat(chunks);
        resolve({ status: res.statusCode, headers: res.headers, bytes, text: bytes.toString('utf8') });
      });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('Local test request timed out')));
    if (body !== undefined) req.write(body);
    req.end();
  });
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pdf-research-server-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const appRoot = path.join(root, 'app');
  const sourceRoot = path.join(root, 'sources');
  const jobDir = path.join(root, 'job');
  const assets = path.join(jobDir, 'report-assets');
  await Promise.all([mkdir(path.join(appRoot, 'web'), { recursive: true }), mkdir(sourceRoot), mkdir(assets, { recursive: true })]);
  const sourceFile = path.join(sourceRoot, 'confirmed.pdf');
  const outsideFile = path.join(root, 'private.pdf');
  const sourceText = path.join(sourceRoot, 'not-a-pdf.txt');
  const sourceSymlink = path.join(sourceRoot, 'escaped.pdf');
  const figureFile = path.join(assets, 'figure.png');
  const figureSymlink = path.join(assets, 'escaped.png');
  const sourceBytes = Buffer.from('%PDF-1.7\nVerified source bytes 0123456789\n%%EOF\n');
  const figureBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
  const privateBytes = 'PRIVATE_FIXTURE_MUST_NOT_LEAK';
  const html = '<article class="research-report"><h1>Verified research</h1></article>';
  const markdown = '# Verified research\n\nA cited conclusion.\n';
  await Promise.all([
    writeFile(path.join(appRoot, 'web', 'index.html'), '<!doctype html><title>Test workbench</title>'),
    writeFile(path.join(appRoot, 'web', 'app.js'), '"use strict";'),
    writeFile(path.join(appRoot, 'web', 'styles.css'), 'body { color: #24392f; }'),
    writeFile(sourceFile, sourceBytes), writeFile(outsideFile, privateBytes), writeFile(sourceText, privateBytes),
    writeFile(figureFile, figureBytes), writeFile(path.join(jobDir, 'report.html'), html),
    writeFile(path.join(jobDir, 'report.md'), markdown)
  ]);
  await Promise.all([symlink(outsideFile, sourceSymlink), symlink(outsideFile, figureSymlink)]);
  const reportJob = {
    id: 'report-job', topic: 'Verified research', status: 'completed', dir: jobDir,
    report: { available: true, htmlUrl: '/api/jobs/report-job/report', markdownUrl: '/api/jobs/report-job/report.md' },
    _report: {
      sources: [
        { id: 'confirmed', path: sourceFile }, { id: 'outside', path: outsideFile },
        { id: 'symlink', path: sourceSymlink }, { id: 'wrong-format', path: sourceText }
      ],
      figures: [{ id: 'figure-1', path: figureFile }, { id: 'outside', path: outsideFile }, { id: 'symlink', path: figureSymlink }]
    }
  };
  const pendingJob = { id: 'pending-job', topic: 'Pending research', status: 'running', dir: jobDir, report: { available: false } };
  const jobs = new Map([[reportJob.id, reportJob], [pendingJob.id, pendingJob]]);
  const calls = { init: 0, shutdown: 0, enqueue: [], preflight: 0 };
  const publicJob = (job) => ({ id: job.id, topic: job.topic, status: job.status, report: job.report });
  const status = { ready: true, checks: [], activeJobId: 'pending-job', version: 'test' };
  const manager = {
    async init() { calls.init += 1; },
    async shutdown() { calls.shutdown += 1; },
    getStatus() { return status; },
    async preflight() { calls.preflight += 1; return status; },
    list() { return [...jobs.values()].map(publicJob); },
    get(id) {
      const job = jobs.get(id);
      if (!job) throw Object.assign(new Error('Unknown job'), { statusCode: 404 });
      return job;
    },
    publicJob,
    async enqueue(body) {
      calls.enqueue.push(body);
      const job = { id: `queued-${calls.enqueue.length}`, topic: body.topic, status: 'queued', report: { available: false } };
      jobs.set(job.id, job);
      return publicJob(job);
    }
  };
  const service = await createServer({ appRoot, sourceRoots: [sourceRoot], port: 0 }, { manager, token: TOKEN });
  t.after(async () => { await service.close(); assert.equal(calls.shutdown, 1); });
  const origin = new URL(service.url).origin;
  const authorized = (target, options = {}) => request(origin, target, { ...options, headers: { Cookie: SESSION, ...options.headers } });
  const post = (target, body, headers = {}) => authorized(target, {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body)
  });
  return { root, service, origin, authorized, post, calls, sourceBytes, figureBytes, privateBytes, html, markdown, reportJob };
}

test('local research HTTP server protects sessions, mutations and report file access', async (t) => {
  const f = await fixture(t);

  await t.test('binds only to loopback and exchanges bootstrap capability for a guarded session cookie', async () => {
    assert.equal(f.service.server.address().address, '127.0.0.1');
    assert.equal(f.calls.init, 1);
    const anonymous = await request(f.origin, '/api/status');
    assert.equal(anonymous.status, 401);
    const staticAnonymous = await request(f.origin, '/app.js');
    assert.equal(staticAnonymous.status, 401);
    const invalid = await request(f.origin, '/?bootstrap=incorrect');
    assert.equal(invalid.status, 401);
    assert.equal(invalid.headers['set-cookie'], undefined);
    const bootstrap = await request(f.origin, `/?bootstrap=${TOKEN}`);
    assert.equal(bootstrap.status, 303);
    assert.equal(bootstrap.headers.location, '/');
    const cookie = bootstrap.headers['set-cookie'][0];
    assert.match(cookie, new RegExp(`^${SESSION};`));
    assert.match(cookie, /; HttpOnly(?:;|$)/);
    assert.match(cookie, /; SameSite=Strict(?:;|$)/);
    assert.match(cookie, /; Path=\/(?:;|$)/);
    assert.equal(bootstrap.headers['cache-control'], 'no-store');
    const status = await f.authorized('/api/status');
    assert.equal(status.status, 200);
    assert.equal(JSON.parse(status.text).ready, true);
    const wrongCookie = await request(f.origin, '/api/status', { headers: { Cookie: 'pdf_research_session=incorrect' } });
    assert.equal(wrongCookie.status, 401);
  });

  await t.test('returns authenticated static assets with browser protection headers', async () => {
    const page = await f.authorized('/');
    assert.equal(page.status, 200);
    assert.match(page.text, /Test workbench/);
    assert.match(page.headers['content-type'], /^text\/html/);
    assert.equal(page.headers['x-content-type-options'], 'nosniff');
    assert.equal(page.headers['referrer-policy'], 'no-referrer');
    assert.match(page.headers['content-security-policy'], /frame-ancestors 'none'/);
    assert.equal((await f.authorized('/app.js')).status, 200);
    assert.equal((await f.authorized('/styles.css')).status, 200);
  });

  await t.test('rejects mismatched Host and cross-origin or missing-Origin writes before calling the manager', async () => {
    const foreignHost = await f.authorized('/api/status', { headers: { Host: 'untrusted.example' } });
    assert.equal(foreignHost.status, 403);
    const bootstrapHost = await request(f.origin, `/?bootstrap=${TOKEN}`, { headers: { Host: 'untrusted.example' } });
    assert.equal(bootstrapHost.status, 403);
    assert.equal(bootstrapHost.headers['set-cookie'], undefined);
    const body = { topic: 'Must never be enqueued', sourceCount: 3, figureTarget: 8 };
    for (const origin of ['https://untrusted.example', 'null', 'http://localhost:12345']) {
      assert.equal((await f.post('/api/jobs', body, { Origin: origin })).status, 403);
    }
    const missingOrigin = await f.authorized('/api/jobs', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    assert.equal(missingOrigin.status, 403);
    assert.equal(f.calls.enqueue.length, 0);
  });

  await t.test('accepts same-origin JSON job creation and exposes the resulting queued job', async () => {
    const body = { topic: '224G via stub 的影響', sourceCount: 3, figureTarget: 8 };
    const result = await f.post('/api/jobs', body);
    assert.equal(result.status, 201);
    const job = JSON.parse(result.text).job;
    assert.equal(job.status, 'queued');
    assert.equal(job.topic, body.topic);
    assert.deepEqual(f.calls.enqueue, [body]);
    const detail = await f.authorized(`/api/jobs/${job.id}`);
    assert.equal(detail.status, 200);
    assert.deepEqual(JSON.parse(detail.text).job, job);
    const listing = await f.authorized('/api/jobs');
    assert.ok(JSON.parse(listing.text).jobs.some((item) => item.id === job.id));
    const preflight = await f.post('/api/preflight', {});
    assert.equal(preflight.status, 200);
    assert.equal(f.calls.preflight, 1);
  });

  await t.test('rejects non-JSON, invalid JSON and oversized job bodies without enqueueing', async () => {
    const before = f.calls.enqueue.length;
    assert.equal((await f.post('/api/jobs', 'topic=test', { 'Content-Type': 'text/plain' })).status, 415);
    assert.equal((await f.post('/api/jobs', '{"topic":')).status, 400);
    assert.equal((await f.post('/api/jobs', { topic: 'x'.repeat(17000) })).status, 413);
    assert.equal(f.calls.enqueue.length, before);
  });

  await t.test('serves published HTML and downloadable Markdown while withholding an unavailable report', async () => {
    const report = await f.authorized('/api/jobs/report-job/report');
    assert.equal(report.status, 200);
    assert.equal(report.text, f.html);
    assert.match(report.headers['content-type'], /^text\/html/);
    const markdown = await f.authorized('/api/jobs/report-job/report.md');
    assert.equal(markdown.status, 200);
    assert.equal(markdown.text, f.markdown);
    assert.match(markdown.headers['content-type'], /^text\/markdown/);
    assert.match(markdown.headers['content-disposition'], /^attachment; filename="pdf-research-report-job\.md"$/);
    const head = await f.authorized('/api/jobs/report-job/report.md', { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.bytes.length, 0);
    assert.equal(Number(head.headers['content-length']), Buffer.byteLength(f.markdown));
    assert.equal((await f.authorized('/api/jobs/pending-job/report')).status, 404);
    assert.equal((await f.authorized('/api/jobs/pending-job/sources/confirmed')).status, 404);
    assert.equal((await f.authorized('/api/jobs/missing-job/report')).status, 404);
  });

  await t.test('serves verified source PDFs and exact bounded, open-ended and suffix byte ranges', async () => {
    const target = '/api/jobs/report-job/sources/confirmed';
    const source = await f.authorized(target);
    assert.equal(source.status, 200);
    assert.equal(source.headers['content-type'], 'application/pdf');
    assert.equal(source.headers['accept-ranges'], 'bytes');
    assert.deepEqual(source.bytes, f.sourceBytes);
    const cases = [
      ['bytes=0-7', 0, 7], ['bytes=8-', 8, f.sourceBytes.length - 1],
      ['bytes=-6', f.sourceBytes.length - 6, f.sourceBytes.length - 1],
      ['bytes=4-99999', 4, f.sourceBytes.length - 1]
    ];
    for (const [range, start, end] of cases) {
      const result = await f.authorized(target, { headers: { Range: range } });
      assert.equal(result.status, 206, range);
      assert.equal(result.headers['content-range'], `bytes ${start}-${end}/${f.sourceBytes.length}`);
      assert.equal(Number(result.headers['content-length']), end - start + 1);
      assert.deepEqual(result.bytes, f.sourceBytes.subarray(start, end + 1));
    }
    const head = await f.authorized(target, { method: 'HEAD', headers: { Range: 'bytes=0-7' } });
    assert.equal(head.status, 206);
    assert.equal(head.bytes.length, 0);
    assert.equal(Number(head.headers['content-length']), 8);
  });

  await t.test('rejects malformed or unsatisfiable source ranges without returning file bytes', async () => {
    for (const range of ['bytes=99999-', 'bytes=8-2', 'bytes=-', 'bytes=0-1,4-5', 'bytes=-0', 'items=0-4']) {
      const result = await f.authorized('/api/jobs/report-job/sources/confirmed', { headers: { Range: range } });
      assert.equal(result.status, 416, range);
      assert.equal(result.headers['content-range'], `bytes */${f.sourceBytes.length}`);
      assert.equal(result.bytes.length, 0);
    }
  });

  await t.test('refuses unlisted source IDs, traversal, out-of-root files, escaped symlinks and non-PDF sources', async () => {
    const cases = [
      ['/api/jobs/report-job/sources/unknown', 404],
      ['/api/jobs/report-job/sources/outside', 403],
      ['/api/jobs/report-job/sources/symlink', 403],
      ['/api/jobs/report-job/sources/wrong-format', 403],
      ['/api/jobs/report-job/sources/../../private.pdf', 404],
      ['/api/jobs/report-job/sources/%2e%2e%2fprivate.pdf', 404],
      ['/api/jobs/report-job/sources/%2Fetc%2Fpasswd', 404],
      [`/api/jobs/report-job/sources?path=${encodeURIComponent(path.join(f.root, 'private.pdf'))}`, 404]
    ];
    for (const [target, expected] of cases) {
      const result = await f.authorized(target);
      assert.equal(result.status, expected, target);
      assert.equal(result.text.includes(f.privateBytes), false, target);
      assert.equal(result.text.includes(f.root), false, target);
    }
    const cannotOverride = await f.authorized(`/api/jobs/report-job/sources/confirmed?path=${encodeURIComponent(path.join(f.root, 'private.pdf'))}`);
    assert.equal(cannotOverride.status, 200);
    assert.deepEqual(cannotOverride.bytes, f.sourceBytes);
  });

  await t.test('serves only figures contained in the published report assets directory', async () => {
    const figure = await f.authorized('/api/jobs/report-job/figures/figure-1');
    assert.equal(figure.status, 200);
    assert.equal(figure.headers['content-type'], 'image/png');
    assert.deepEqual(figure.bytes, f.figureBytes);
    for (const [id, status] of [['unknown', 404], ['outside', 403], ['symlink', 403]]) {
      const result = await f.authorized(`/api/jobs/report-job/figures/${id}`);
      assert.equal(result.status, status);
      assert.equal(result.text.includes(f.privateBytes), false);
    }
  });
});
