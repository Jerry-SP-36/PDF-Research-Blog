import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';
import os from 'node:os';
import path from 'node:path';
import { JobManager, cleanRequest, validateModel, readModels } from '../lib/jobs.mjs';
import { CodexRpc } from '../lib/codex-rpc.mjs';

class MockRpc extends EventEmitter {
  constructor(index = 0) { super(); this.index = index; this.requests = []; this.responses = []; this.closed = false; this.started = false; }
  async start() { this.started = true; }
  async request(method, params) {
    this.requests.push({ method, params });
    if (method === 'account/read') return { account: { type: 'chatgpt' } };
    if (method === 'thread/start') return { thread: { id: `thread-${this.index}` }, model: params.model, reasoningEffort: params.config?.model_reasoning_effort ?? 'medium' };
    if (method === 'model/list') return {data:[{model:'gpt-5.6-luna',inputModalities:['text','image'],supportedReasoningEfforts:[{reasoningEffort:'high'}]}],nextCursor:null};
    if (method === 'mcpServerStatus/list') return { data: [{ name: 'cua_repl', tools: { js: {} } }] };
    if (method === 'turn/start') return { turn: { id: `turn-${this.index}` } };
    if (method === 'turn/interrupt') return {};
    throw new Error(`Unexpected mock RPC method: ${method}`);
  }
  respond(id, result) { this.responses.push({ id, result }); }
  rejectRequest(id, error) { this.responses.push({ id, error }); }
  close() { if (!this.closed) { this.closed = true; this.emit('exit', { code: 0 }); } }
  notification(method, params) { this.emit('notification', { method, params }); }
}

async function until(predicate, message = 'condition', timeout = 3000) {
  const end = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= end) throw new Error(`Timed out waiting for ${message}`);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

function png(red) {
  function crc32(buffer) {
    let crc = 0xffffffff;
    for (const byte of buffer) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1; }
    return (crc ^ 0xffffffff) >>> 0;
  }
  function chunk(type, data) {
    const name = Buffer.from(type), size = Buffer.alloc(4), checksum = Buffer.alloc(4);
    size.writeUInt32BE(data.length); checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
    return Buffer.concat([size, name, data, checksum]);
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(1, 0); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.from([0, red, 100, 150]))), chunk('IEND', Buffer.alloc(0))]);
}

async function setup(t, { artifactVerifier = async () => ({ errors: [] }) } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pdf-jobs-test-'));
  const library = path.join(root, 'library'); await mkdir(library);
  const config = { version: 'test', codexPath: process.execPath, codexArgs: [], skillPath: path.join(root, 'SKILL.md'), pdfAppPath: root, pdfToolDir: root, pythonPath: process.execPath, sourceRoots: [library], dataDir: path.join(root, 'data'), appRoot: root, maxJobMinutes: 45 };
  const rpcs = [], manager = new JobManager(config, { rpcFactory: () => { const rpc = new MockRpc(rpcs.length); rpcs.push(rpc); return rpc; }, artifactVerifier });
  manager.readingMemory.pageCounter = async () => 20;
  await manager.init();
  t.after(async () => { await manager.shutdown(); await until(() => !manager.draining, 'manager shutdown'); await Promise.all([...manager.jobs.values()].map(job => job._save)); await rm(root, { recursive: true, force: true }); });
  async function queued(topic = '研究測試', overrides = {}) {
    // Hold the public queue only while adding inputs, then exercise the real drain/run implementation.
    manager.draining = true;
    try { return manager.get((await manager.enqueue({ topic, sourceCount: 3, figureTarget: 4, ...overrides })).id); }
    finally { manager.draining = false; }
  }
  async function report(job, title = 'Research report') {
    const sources = [], figures = [];
    for (let i = 1; i <= 3; i++) {
      const file = path.join(library, `source-${i}.pdf`);
      await writeFile(file, `%PDF-1.7\n% Structural fixture ${i}\n%%EOF\n`);
      sources.push({ id: `S${i}`, title: `Source ${i}`, path: file, pagesRead: [1] });
    }
    for (let i = 1; i <= 4; i++) {
      const file = path.join(job.dir, 'report-assets', `figure-${i}.png`); await writeFile(file, png(i * 20));
      figures.push({ id: `F${i}`, path: file, sourceId: `S${(i % 3) + 1}`, page: 1, caption: `Original figure ${i}` });
    }
    const value = { title, summary: [{ text: 'Core conclusion.', citations: sources.map(source => ({ sourceId: source.id, pages: [1] })) }], sections: [{ heading: 'Engineering implications', blocks: [{ type: 'paragraph', text: 'A source-backed condition.', citations: [{ sourceId: 'S1', pages: [1] }] }, ...figures.map(figure => ({ type: 'figure', figureId: figure.id }))] }], sources, figures, evidence: sources.map(source => ({ sourceId: source.id, page: 1, method: 'pdf-search-screenshot' })), limitations: [], completeness: 'complete' };
    await writeFile(path.join(job.dir, 'report.json'), JSON.stringify(value));
    return value;
  }
  async function screenshots(job, rpc) {
    for (let i = 0; i < 3; i++) rpc.notification('item/completed', { threadId: job.threadId, item: { id: `shot-${i}`, type: 'mcpToolCall', server: 'cua_repl', tool: 'js', arguments: { code: 'await app.getScreenshot()' }, status: 'completed', result: { content: [{ type: 'image', mimeType: 'image/png', data: png(i * 20).toString('base64') }] } } });
    await job._notificationChain;
  }
  return { root, config, manager, rpcs, queued, report, screenshots };
}

test('request validation bounds the task without silently coercing counts', () => {
  assert.deepEqual(cleanRequest({ topic: '  topic  ' }), { topic: 'topic', sourceCount: null, figureTarget: null, model:'gpt-5.6-luna',reasoningEffort:'high',sourceMode:'pdf' });
  assert.equal(cleanRequest({ topic: 'x', sourceMode: 'pdf_web' }).sourceMode, 'pdf_web');
  for (const input of [{ topic: '' }, { topic: 'x', sourceCount: '3' }, { topic: 'x', sourceCount: 9 }, { topic: 'x', figureTarget: 17 }, { topic: 'x', sourceMode: 'internet' }, { topic: 'x\0' }]) assert.throws(() => cleanRequest(input));
});

test('saved feedback is read back and frozen into the next related job instructions', async t => {
  const f = await setup(t), first = await f.queued('224G SerDes via stub');
  first.status = 'completed'; first.report.available = true;
  await f.manager.experiences.capture(first);
  const feedback = await f.manager.saveFeedback(first.id, {
    verdict: 'partial', correct: '保留損耗比較表。', mistakes: '不能把模擬當量測。', preferences: '保留速率、頻率、介質與距離。',
  });
  assert.equal(f.manager.publicJob(first).experience.feedback.preferences, feedback.feedback.preferences);
  const next = await f.queued('224G via 的量測與模擬差異');
  assert.deepEqual(next.experienceApplied, { preferences: 1, related: 1 });
  const workflow = await readFile(path.join(next.dir, 'work', 'workflow.txt'), 'utf8');
  assert.match(workflow, /保留速率、頻率、介質與距離/);
  assert.match(workflow, /不能把模擬當量測/);
  const persisted = JSON.parse(await readFile(path.join(next.dir, 'job.json'), 'utf8'));
  assert.deepEqual(persisted.experienceApplied, { preferences: 1, related: 1 });
});

test('queue runs one RPC at a time, commits verified report, then handles a failed next turn', async t => {
  const f = await setup(t), first = await f.queued('First'), second = await f.queued('Second');
  const draining = f.manager.drain();
  await until(() => first.turnId, 'first turn start');
  assert.equal(f.rpcs.length, 1); assert.equal(second.status, 'queued');
  await f.report(first); await f.screenshots(first, f.rpcs[0]);
  f.rpcs[0].notification('turn/completed', { threadId: first.threadId, turn: { id: first.turnId, status: 'completed' } });
  await until(() => second.turnId, 'second turn start');
  assert.equal(first.status, 'completed'); assert.equal(first.report.available, true); assert.equal(f.rpcs[0].closed, true);
  assert.deepEqual(first.stats, { sources: 3, webSources: 0, figures: 4 });
  const saved = JSON.parse(await readFile(path.join(first.dir, 'job.json'), 'utf8'));
  assert.equal(saved.status, 'completed'); assert.equal(saved.report.available, true);
  assert.match(await readFile(path.join(first.dir, 'report.html'), 'utf8'), /research-report/);
  f.rpcs[1].notification('turn/completed', { threadId: second.threadId, turn: { id: second.turnId, status: 'failed', error: { message: 'Mock worker failure' } } });
  await draining;
  assert.equal(second.status, 'failed'); assert.match(second.error, /Mock worker failure/);
  assert.equal(f.manager.activeJobId, null); assert.equal(f.manager.draining, false);
});

test('a completed Codex turn without a validated report is failed, not success', async t => {
  const f = await setup(t), job = await f.queued(), draining = f.manager.drain();
  await until(() => job.turnId);
  f.rpcs[0].notification('turn/completed', { threadId: job.threadId, turn: { id: job.turnId, status: 'completed' } });
  await draining;
  assert.equal(job.status, 'failed'); assert.equal(job.report.available, false);
  assert.match(job.error, /沒有產生通過驗證/);
});

test('cancel interrupts the current turn, clears approvals, and leaves the job terminal', async t => {
  const f = await setup(t), job = await f.queued(), draining = f.manager.drain();
  await until(() => job.turnId);
  await f.manager.handleServerRequest(job, { id: 7, method: 'item/commandExecution/requestApproval', params: { reason: 'Need explicit authorization', command: 'read test' } });
  assert.equal(job.status, 'needs_input'); assert.equal(job.pendingRequests.length, 1);
  await f.manager.cancel(job.id); await draining;
  assert.equal(job.status, 'cancelled'); assert.deepEqual(job.pendingRequests, []); assert.equal(job._pending.size, 0);
  assert.ok(f.rpcs[0].requests.some(request => request.method === 'turn/interrupt' && request.params.turnId === job.turnId));
  assert.equal(f.rpcs[0].closed, true); assert.equal(job.report.available, false);
  assert.equal(job.events.some(event => event.kind === 'complete'), false);
});

test('restart preserves previous data and marks active or queued jobs interrupted without an automatic rerun', async t => {
  const f = await setup(t), first = await f.queued('was running'), second = await f.queued('was queued');
  first.status = 'running'; first.threadId = 'previous-thread'; await f.manager.persist(first);
  second.readingMemoryApplied = { records: 2, staleCount: 1 }; await f.manager.persist(second);
  const restored = new JobManager(f.config, { rpcFactory: () => { throw new Error('Restart must not run a worker'); } });
  await restored.init();
  for (const id of [first.id, second.id]) {
    assert.equal(restored.get(id).status, 'interrupted');
    assert.match(restored.get(id).error, /沒有自動重跑/);
    assert.equal(JSON.parse(await readFile(path.join(restored.get(id).dir, 'job.json'), 'utf8')).status, 'interrupted');
  }
  assert.deepEqual(restored.publicJob(restored.get(second.id)).readingMemory, { recorded: 0, reused: 2, staleSkipped: 1 });
  assert.equal(restored.activeJobId, null); assert.equal(restored.jobs.size, 2);
  // Keep the first manager's cleanup from overwriting the restarted state.
  first.status = second.status = 'interrupted';
});

test('publish rejects reports without runtime evidence and propagates decoder failures', async t => {
  let calls = 0;
  const f = await setup(t, { artifactVerifier: async () => { calls++; return { errors: ['Source page exceeds actual PDF page count'] }; } }), job = await f.queued();
  await f.report(job);
  let result = await f.manager.publish(job, path.join(job.dir, 'report.json'));
  assert.equal(result.valid, false); assert.equal(calls, 0); assert.equal(job.report.available, false);
  assert.ok(result.errors.some(error => error.includes('沒有觀察到成功的 cua_repl')));
  job.runtimeEvidence = { cuaCalls: 3, screenshotCalls: 3, screenshotsSaved: 3 };
  result = await f.manager.publish(job, path.join(job.dir, 'report.json'));
  assert.equal(result.valid, false); assert.equal(calls, 1);
  assert.ok(result.errors.includes('Source page exceeds actual PDF page count'));
  assert.equal(job.report.available, false);
});

test('multi-question replies wait for all answers and preserve explicit approval boundaries', async t => {
  const f = await setup(t), job = await f.queued(); job._rpc = new MockRpc(); job.status = 'running';
  await f.manager.handleServerRequest(job, { id: 42, method: 'item/tool/requestUserInput', params: { questions: [{ id: 'a', header: 'A', question: 'Question A' }, { id: 'b', header: 'B', question: 'Question B' }] } });
  await f.manager.respond(job.id, { requestId: '42:a', decision: 'accept', answer: 'Answer A' });
  assert.equal(job._rpc.responses.length, 0); assert.equal(job.status, 'needs_input');
  await f.manager.respond(job.id, { requestId: '42:b', decision: 'accept', answer: 'Answer B' });
  assert.deepEqual(job._rpc.responses[0], { id: 42, result: { answers: { a: { answers: ['Answer A'] }, b: { answers: ['Answer B'] } } } });
  assert.equal(job.status, 'running');
  await f.manager.handleServerRequest(job, { id: 43, method: 'item/permissions/requestApproval', params: { permissions: { network: { enabled: true } } } });
  assert.equal(job._rpc.responses.length, 1);
  await f.manager.respond(job.id, { requestId: '43', decision: 'decline' });
  assert.deepEqual(job._rpc.responses[1], { id: 43, result: { permissions: {}, scope: 'turn' } });
});

test('RPC timeouts and close reject pending callers without copying desktop task credentials', async () => {
  const rpc = new CodexRpc({ executable: '/unused', cwd: '/tmp', env: { PATH: '/test', CODEX_APP_TOOLS_PIPE_PATH: 'private', CODEX_THREAD_ID: 'private' }, timeoutMs: 10 });
  assert.equal(rpc.env.CODEX_APP_TOOLS_PIPE_PATH, undefined); assert.equal(rpc.env.CODEX_THREAD_ID, undefined);
  const writes = [];
  rpc.child = { stdin: { writable: true, write: value => writes.push(value), end() {} }, kill() {}, exitCode: 0 };
  await assert.rejects(rpc.request('test/timeout'), /timed out/);
  assert.equal(rpc.pending.size, 0);
  const pending = rpc.request('test/pending', {}, 1000), rejected = assert.rejects(pending, /connection closed/);
  rpc.close(); await rejected;
  assert.equal(rpc.pending.size, 0); assert.equal(rpc.closed, true);
  assert.equal(JSON.parse(writes[0]).method, 'test/timeout');
});

test('regression: an escaped Markdown title remains a publishable report', async t => {
  const f = await setup(t), job = await f.queued(); await f.report(job, 'PCIe [Gen6] via_stub #1');
  job.runtimeEvidence = { cuaCalls: 3, screenshotCalls: 3, screenshotsSaved: 3 };
  const result = await f.manager.publish(job, path.join(job.dir, 'report.json'));
  assert.equal(result.valid, true); assert.equal(job.report.available, true);
});

test('regression: cancellation during artifact validation cannot restore running status', async t => {
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { entered = resolve; });
  const f = await setup(t, { artifactVerifier: async () => { entered(); await gate; return { errors: [] }; } }), job = await f.queued();
  await f.report(job); job.runtimeEvidence = { cuaCalls: 3, screenshotCalls: 3, screenshotsSaved: 3 };
  const publishing = f.manager.publish(job, path.join(job.dir, 'report.json'));
  const stopped = assert.rejects(publishing, /研究已停止/);
  await started; await f.manager.cancel(job.id); release(); await stopped;
  assert.equal(job.status, 'cancelled');
});

test('regression: code text alone cannot count as screenshot evidence when no image was returned', async t => {
  const f = await setup(t), job = await f.queued();
  await f.manager.handleNotification(job, { method: 'item/completed', params: { item: { id: 'no-image', type: 'mcpToolCall', server: 'cua_repl', tool: 'js', arguments: { code: 'nodeRepl.write("app.getScreenshot() was not executed")' }, status: 'completed', result: { content: [{ type: 'text', text: 'app.getScreenshot() was not executed' }] } } } });
  assert.equal(job.runtimeEvidence.screenshotCalls, 0);
  assert.equal(job.runtimeEvidence.screenshotsSaved, 0);
});

test('regression: a late publisher cannot revive a failed job after RPC transport exit', async t => {
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { entered = resolve; });
  const f = await setup(t, { artifactVerifier: async () => { entered(); await gate; return { errors: [] }; } }), job = await f.queued();
  const draining = f.manager.drain();
  await until(() => job.turnId);
  await f.report(job); await f.screenshots(job, f.rpcs[0]);
  const publishing = f.manager.handleServerRequest(job, { id: 91, method: 'item/tool/call', params: { tool: 'research_publish', arguments: { reportPath: path.join(job.dir, 'report.json') } } });
  await started;
  f.rpcs[0].close();
  await draining;
  assert.equal(job.status, 'failed');
  release(); await publishing;
  assert.equal(job.status, 'failed');
  assert.equal(job.report.available, false);
});

test('regression: an asynchronous stdin EPIPE is a transport failure, not an uncaught app exception', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pdf-rpc-test-'));
  // CodexRpc invokes executable app-server --stdio; Node instead executes this tiny mock file.
  // This process has no Codex account, UI or network behavior.
  await writeFile(path.join(root, 'app-server'), "const r = require('node:readline').createInterface({input:process.stdin}); r.on('line', line => { const m = JSON.parse(line); if (m.method === 'initialize') process.stdout.write(JSON.stringify({id:m.id,result:{}}) + '\\n'); });\n");
  const rpc = new CodexRpc({ executable: process.execPath, cwd: root, timeoutMs: 1000 });
  t.after(async () => {
    const exited = rpc.child && rpc.child.exitCode === null && rpc.child.signalCode === null ? once(rpc.child, 'exit') : Promise.resolve();
    rpc.close(); await exited; await rm(root, { recursive: true, force: true });
  });
  await rpc.start();
  assert.doesNotThrow(() => rpc.child.stdin.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })));
  assert.equal(rpc.closed, true);
});

function pdfSearchConsent(job, id, params = {}) {
  return { id, method: 'mcpServer/elicitation/request', params: { threadId: job.threadId, serverName: 'cua_repl', message: 'Allow Computer Use to use "PDF Search"?', requestedSchema: { type: 'object', properties: {}, required: [] }, ...params } };
}

test('exact PDF Search consent is permanently auto-accepted without entering needs_input', async t => {
  const f = await setup(t), job = await f.queued(); job._rpc = new MockRpc(); job.threadId = 'consent-thread'; job.status = 'running';
  await f.manager.handleServerRequest(job, pdfSearchConsent(job, 100));
  assert.deepEqual(job._rpc.responses[0], { id: 100, result: { action: 'accept', content: {} } });
  assert.equal(job.status, 'running'); assert.equal(job.pendingRequests.length, 0); assert.equal(job._pending.size, 0);
  assert.match(job.events.at(-1).message, /永久設定允許/);
  await f.manager.handleServerRequest(job, pdfSearchConsent(job, 101));
  assert.deepEqual(job._rpc.responses[1], { id: 101, result: { action: 'accept', content: {} } });
  assert.equal(job.status, 'running'); assert.equal(job.pendingRequests.length, 0);
  await f.manager.persist(job);
  const saved = JSON.parse(await readFile(path.join(job.dir, 'job.json'), 'utf8'));
  assert.equal(Object.hasOwn(saved, '_pdfSearchConsent'), false);
  assert.equal(Object.hasOwn(saved, 'pdfSearchConsent'), false);
});

test('permanent PDF Search permission does not cover different apps, servers, threads, methods, or schemas', async t => {
  const f = await setup(t), job = await f.queued(); job._rpc = new MockRpc(); job.threadId = 'scoped-thread'; job.status = 'running';
  const cases = [
    ['other app', { message: 'Allow Computer Use to use "Safari"?' }],
    ['other server', { serverName: 'another_server' }],
    ['other thread', { threadId: 'another-thread' }],
    ['missing request thread', { threadId: undefined }],
    ['nonexact message', { message: 'Allow Computer Use to use "PDF Search"? Extra permission.' }],
    ['changed punctuation', { message: 'Allow Computer Use to use "PDF Search"?\n' }],
    ['schema with properties', { requestedSchema: { type: 'object', properties: { token: { type: 'string' } } } }],
    ['schema with required data', { requestedSchema: { type: 'object', properties: {}, required: ['token'] } }],
    ['wrong schema type', { requestedSchema: { type: 'string', properties: {} } }],
    ['properties is array', { requestedSchema: { type: 'object', properties: [] } }],
    ['required is object', { requestedSchema: { type: 'object', properties: {}, required: {} } }],
    ['missing schema', { requestedSchema: undefined }],
  ];
  let id = 120;
  for (const [label, params] of cases) {
    const count = job._rpc.responses.length;
    await f.manager.handleServerRequest(job, pdfSearchConsent(job, id, params));
    assert.equal(job._rpc.responses.length, count, label);
    assert.equal(job.pendingRequests.at(-1).id, String(id), label);
    assert.equal(job.status, 'needs_input', label);
    await f.manager.respond(job.id, { requestId: String(id++), decision: 'decline' });
  }
  const otherMethod = pdfSearchConsent(job, id); otherMethod.method = 'item/permissions/requestApproval';
  const count = job._rpc.responses.length;
  await f.manager.handleServerRequest(job, otherMethod);
  assert.equal(job._rpc.responses.length, count); assert.equal(job.pendingRequests.at(-1).id, String(id));
  await f.manager.respond(job.id, { requestId: String(id++), decision: 'decline' });
  // An unknown current thread must not match a likewise missing request thread.
  job.threadId = undefined;
  const beforeUnknownThread = job._rpc.responses.length;
  await f.manager.handleServerRequest(job, pdfSearchConsent(job, id));
  assert.equal(job._rpc.responses.length, beforeUnknownThread); assert.equal(job.pendingRequests.at(-1).id, String(id));
});

test('permanent PDF Search permission applies independently to every active job without saved grant state', async t => {
  const f = await setup(t), first = await f.queued('First research'); first._rpc = new MockRpc(); first.threadId = 'first-thread'; first.status = 'running';
  await f.manager.handleServerRequest(first, pdfSearchConsent(first, 150));
  const second = await f.queued('Second research'); second._rpc = new MockRpc(); second.threadId = 'second-thread'; second.status = 'running';
  await f.manager.handleServerRequest(second, pdfSearchConsent(second, 151));
  assert.deepEqual(first._rpc.responses[0], { id: 150, result: { action: 'accept', content: {} } });
  assert.deepEqual(second._rpc.responses[0], { id: 151, result: { action: 'accept', content: {} } });
  assert.equal(first.pendingRequests.length, 0); assert.equal(second.pendingRequests.length, 0);
  await f.manager.persist(first); await f.manager.persist(second);
  for (const current of [first, second]) {
    const saved = JSON.parse(await readFile(path.join(current.dir, 'job.json'), 'utf8'));
    assert.equal(Object.hasOwn(saved, '_pdfSearchConsent'), false);
  }
  const restored = new JobManager(f.config, { rpcFactory: () => { throw new Error('No automatic worker'); } });
  await restored.init();
  assert.equal(restored.get(first.id).status, 'interrupted'); assert.equal(restored.get(second.id).status, 'interrupted');
});

test('expired or closed jobs cannot auto-accept a late PDF Search request', async t => {
  const f = await setup(t), job = await f.queued(); job.threadId = 'expired-thread';
  const scenarios = [
    { _cancelRequested: true }, { _runEnded: true }, { _transportFailed: true }, { closed: true }, { noRpc: true },
  ];
  for (const [index, flags] of scenarios.entries()) {
    const rpc = new MockRpc(); rpc.closed = Boolean(flags.closed); job._rpc = flags.noRpc ? null : rpc;
    job._cancelRequested = Boolean(flags._cancelRequested); job._runEnded = Boolean(flags._runEnded); job._transportFailed = Boolean(flags._transportFailed);
    job.status = 'interrupted';
    await f.manager.handleServerRequest(job, pdfSearchConsent(job, 160 + index));
    assert.equal(rpc.responses.length, 0); assert.equal(job.pendingRequests.length, 0); assert.equal(job.status, 'interrupted');
  }
});

test('a late generic approval click during turn interruption cannot revive a cancelled job', async t => {
  const f = await setup(t), job = await f.queued(); job._rpc = new MockRpc(); job.threadId = 'cancel-consent'; job.turnId = 'cancel-turn'; job.status = 'running';
  await f.manager.handleServerRequest(job, pdfSearchConsent(job, 170, { message: 'Allow Computer Use to use "Safari"?' }));
  let release;
  const interruptGate = new Promise(resolve => { release = resolve; });
  job._rpc.request = async () => { await interruptGate; return {}; };
  const cancelling = f.manager.cancel(job.id);
  try {
    assert.equal(job.status, 'cancelled');
    await assert.rejects(f.manager.respond(job.id, { requestId: '170', decision: 'accept' }), error => error.statusCode === 409);
  } finally { release(); await cancelling; }
  assert.equal(job.status, 'cancelled'); assert.equal(job._pending.size, 0); assert.equal(job.pendingRequests.length, 0);
});

test('model selection rejects missing models and unsupported effort without substitution', () => {
  const models=[{model:'gpt-5.6-luna',supportedReasoningEfforts:[{reasoningEffort:'high'}]}];
  assert.equal(validateModel(cleanRequest({topic:'x'}),models).model,'gpt-5.6-luna');
  assert.throws(()=>validateModel({model:'gpt-other',reasoningEffort:'high'},models),/無法選用/);
  assert.throws(()=>validateModel({model:'gpt-5.6-luna',reasoningEffort:'ultra'},models),/不支援/);
  assert.doesNotThrow(()=>validateModel({model:'gpt-5.6-luna',reasoningEffort:null},models));
  assert.deepEqual(cleanRequest({topic:'x',sourceCount:null,figureTarget:8,reasoningEffort:null}),{topic:'x',sourceCount:null,figureTarget:8,model:'gpt-5.6-luna',reasoningEffort:null,sourceMode:'pdf'});
});
test('live model catalog is paged and excludes models without vision', async()=>{
  let count=0;
  const models=await readModels({request:async()=>++count===1?{data:[{model:'text',inputModalities:['text']}],nextCursor:'next'}:{data:[{model:'vision',inputModalities:['text','image']}],nextCursor:null}});
  assert.equal(count,2);assert.deepEqual(models.map(m=>m.model),['vision']);
});
test('selected model and effort are sent, read back and persisted',async t=>{
  const f=await setup(t),job=await f.queued(),draining=f.manager.drain();await until(()=>job.turnId);
  const calls=f.rpcs[0].requests;
  assert.equal(calls.find(c=>c.method==='thread/start').params.model,'gpt-5.6-luna');
  assert.equal(calls.find(c=>c.method==='turn/start').params.effort,'high');
  assert.equal(job.actualModel,'gpt-5.6-luna');assert.equal(job.actualReasoningEffort,'high');
  await f.manager.cancel(job.id);await draining;
  assert.equal(JSON.parse(await readFile(path.join(job.dir,'job.json'),'utf8')).actualModel,'gpt-5.6-luna');
});
test('unexpected model readback stops before a model turn',async t=>{
  const f=await setup(t),job=await f.queued();
  const old=f.manager.rpcFactory;f.manager.rpcFactory=()=>{const r=old(),request=r.request.bind(r);r.request=async(m,p)=>{const v=await request(m,p);if(m==='thread/start')v.model='gpt-6-astra';return v;};return r;};
  await f.manager.drain();assert.equal(job.status,'failed');assert.match(job.error,/沒有偷偷替換/);assert.equal(f.rpcs[0].requests.some(r=>r.method==='turn/start'),false);
});
test('runtime model reroute cannot be reported as selected-model success',async t=>{
  const f=await setup(t),job=await f.queued(),draining=f.manager.drain();await until(()=>job.turnId);
  f.rpcs[0].notification('model/rerouted',{threadId:job.threadId,fromModel:'gpt-5.6-luna',toModel:'gpt-6-astra'});await draining;
  assert.equal(job.status,'failed');assert.equal(job.report.available,false);assert.match(job.error,/切換模型/);
});

test('three UI failures stop research; an inventory response cannot fake recovery',async t=>{
  const f=await setup(t),job=await f.queued(),draining=f.manager.drain();await until(()=>job.turnId);
  const rpc=f.rpcs[0];
  for(let i=0;i<3;i++){
    rpc.notification('item/completed',{threadId:job.threadId,item:{id:`fail-${i}`,type:'mcpToolCall',server:'cua_repl',tool:'js',arguments:{code:'await app.getAXState()'},status:'failed',result:{content:[{type:'text',text:'Accessibility read timed out'}]}}});
    if(i<2)rpc.notification('item/completed',{threadId:job.threadId,item:{id:`inventory-${i}`,type:'mcpToolCall',server:'cua_repl',tool:'js',arguments:{code:'const state=await cua.getState()'},status:'completed',result:{content:[]}}});
  }
  await draining;assert.equal(job.status,'failed');assert.match(job.error,/連續三次/);assert.equal(job.report.available,false);
  const trace=await readFile(path.join(job.dir,'work/cua-trace.jsonl'),'utf8');assert.match(trace,/Accessibility read timed out/);
});
test('stalled UI tool ends the job after the bounded deadline',async t=>{
  const f=await setup(t),job=await f.queued();let result;job._settle=value=>{result=value;};
  t.mock.timers.enable({apis:['setTimeout']});
  await f.manager.handleNotification(job,{method:'item/started',params:{item:{id:'stalled',type:'mcpToolCall',server:'cua_repl'}}});
  t.mock.timers.tick(180001);assert.equal(result.status,'failed');assert.match(result.error.message,/3 分鐘/);assert.equal(job._transportFailed,true);
  t.mock.timers.reset();
});
test('waiting for user permission pauses the UI watchdog until the answer arrives',async t=>{
  const f=await setup(t),job=await f.queued();job._rpc=new MockRpc();job.threadId='thread-permission';let settled=false;job._settle=()=>{settled=true;};
  t.mock.timers.enable({apis:['setTimeout']});
  await f.manager.handleNotification(job,{method:'item/started',params:{item:{id:'permission-tool',type:'mcpToolCall',server:'cua_repl'}}});
  await f.manager.handleServerRequest(job,{id:21,method:'mcpServer/elicitation/request',params:{threadId:job.threadId,serverName:'cua_repl',message:'Allow Computer Use to use "Safari"?',requestedSchema:{type:'object',properties:{}}}});
  t.mock.timers.tick(180001);assert.equal(settled,false);assert.equal(job.status,'needs_input');
  await f.manager.respond(job.id,{requestId:'21',decision:'accept'});t.mock.timers.tick(180001);assert.equal(settled,true);
  t.mock.timers.reset();
});

test('PDF-only and PDF-plus-web jobs set per-thread search mode while keeping shell network closed', async t => {
  const f = await setup(t);
  const pdf = await f.queued('PDF only', { sourceMode: 'pdf' }), firstDrain = f.manager.drain();
  await until(() => pdf.turnId);
  let start = f.rpcs[0].requests.find(call => call.method === 'thread/start');
  let turn = f.rpcs[0].requests.find(call => call.method === 'turn/start');
  assert.equal(start.params.config.web_search, 'disabled');
  assert.equal(turn.params.sandboxPolicy.networkAccess, false);
  await f.manager.cancel(pdf.id); await firstDrain;

  const web = await f.queued('PDF with current standards status', { sourceMode: 'pdf_web' }), secondDrain = f.manager.drain();
  await until(() => web.turnId);
  start = f.rpcs[1].requests.find(call => call.method === 'thread/start');
  turn = f.rpcs[1].requests.find(call => call.method === 'turn/start');
  assert.equal(start.params.config.web_search, 'live');
  assert.equal(turn.params.sandboxPolicy.networkAccess, false);
  assert.match(start.params.developerInstructions, /研究開始時至少執行一次即時 Web Search/);
  await f.manager.cancel(web.id); await secondDrain;
});

test('dynamic reading records are persisted by page and injected only as navigation context for a related job', async t => {
  const f = await setup(t), job = await f.queued('224G FEC latency');
  const pdf = path.join(f.config.sourceRoots[0], 'fec-latency.pdf');
  await writeFile(pdf, '%PDF-1.7\n% FEC latency fixture\n%%EOF\n');
  job._rpc = new MockRpc(); job.status = 'running'; job.threadId = 'reading-thread';
  await f.manager.handleServerRequest(job, { id: 601, method: 'item/tool/call', params: { tool: 'research_record_reading', arguments: {
    sourcePath: pdf, sourceTitle: 'FEC Latency', pages: [7, 8], topics: ['latency', 'codeword'],
    query: '224G FEC latency', summary: 'Pages 7–8 explain codeword latency.',
    findings: [{ text: 'Latency varies with codeword structure.', pages: [8], conditions: '224G link' }],
  } } });
  assert.equal(job._rpc.responses[0].result.success, true);
  assert.equal(f.manager.publicJob(job).readingMemory.recorded, 1);
  const next = await f.queued('224G FEC codeword latency tradeoff');
  assert.equal(next.readingMemoryApplied.records, 1);
  await f.manager.readingMemory.record({ id: 'later-job', topic: '224G FEC codeword latency tradeoff' }, {
    sourcePath: pdf, sourceTitle: 'FEC Latency', pages: [9], topics: ['post-FEC BER'],
    query: 'post-FEC BER', summary: 'Page 9 adds a later reading while the next task is queued.', findings: [],
  }, [f.config.sourceRoots[0]]);
  await f.manager.refreshReadingContext(next);
  assert.equal(next.readingMemoryApplied.records, 2);
  const workflow = await readFile(path.join(next.dir, 'work/workflow.txt'), 'utf8');
  assert.match(workflow, /Pages 7–8 explain codeword latency/);
  assert.match(workflow, /Page 9 adds a later reading/);
  assert.match(workflow, /不代表整份文件已讀完/);
  assert.match(workflow, /仍須本次重新在 PDF Search 翻頁/);
});

test('web report publication requires an observed live search and every cited page URL to be opened', async t => {
  const f = await setup(t), url = 'https://standards.example.org/status';
  const job = await f.queued('Current standard status', { sourceMode: 'pdf_web' });
  const report = await f.report(job);
  report.sources.push({ id: 'W1', kind: 'web', title: 'Official status', url, accessedAt: '2026-09-11T00:00:00Z' });
  report.summary.push({ text: 'Current official status.', citations: [{ sourceId: 'W1' }] });
  await writeFile(path.join(job.dir, 'report.json'), JSON.stringify(report));
  job.runtimeEvidence = { cuaCalls: 3, screenshotCalls: 3, screenshotsSaved: 3, webSearchCalls: 0, webUrls: [] };
  await f.manager.handleNotification(job, { method: 'item/completed', params: { item: { type: 'webSearch', status: 'completed', action: { type: 'search' }, query: 'current standard status' } } });
  await f.manager.handleNotification(job, { method: 'item/completed', params: { item: { type: 'webSearch', status: 'completed', action: { type: 'openPage', url } } } });
  let result = await f.manager.publish(job, path.join(job.dir, 'report.json'));
  assert.equal(result.valid, true, result.errors?.join('\n'));
  assert.deepEqual(result.stats, { sources: 3, webSources: 1, figures: 4 });

  const unobserved = await f.queued('Unobserved web source', { sourceMode: 'pdf_web' });
  const other = await f.report(unobserved);
  other.sources.push({ id: 'W1', kind: 'web', title: 'Other page', url: 'https://example.org/other', accessedAt: '2026-09-11' });
  other.summary.push({ text: 'Other claim.', citations: [{ sourceId: 'W1' }] });
  await writeFile(path.join(unobserved.dir, 'report.json'), JSON.stringify(other));
  unobserved.runtimeEvidence = { cuaCalls: 3, screenshotCalls: 3, screenshotsSaved: 3, webSearchCalls: 1, webUrls: [url] };
  result = await f.manager.publish(unobserved, path.join(unobserved.dir, 'report.json'));
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(error => error.includes('沒有對應到本次 Web Search 實際開啟的 URL')));
});

test('completed web-search notifications retain only canonical HTTPS URLs', async t => {
  const f = await setup(t), job = await f.queued('Web evidence', { sourceMode: 'pdf_web' });
  await f.manager.handleNotification(job, { method: 'item/completed', params: { item: { type: 'webSearch', status: 'completed', action: { type: 'openPage', url: 'https://example.org/reference' } } } });
  await f.manager.handleNotification(job, { method: 'item/completed', params: { item: { type: 'web_search_call', status: 'completed', action: { type: 'openPage', url: 'http://unsafe.example' } } } });
  await f.manager.handleNotification(job, { method: 'item/completed', params: { item: { type: 'web_search_call', status: 'completed', action: { type: 'findInPage', url: 'https://example.org/second' } } } });
  await f.manager.handleNotification(job, { method: 'item/completed', params: { item: { type: 'webSearch', status: 'failed', error: { message: 'offline' }, action: { type: 'openPage', url: 'https://example.org/failed' } } } });
  assert.equal(job.runtimeEvidence.webSearchCalls, 3);
  assert.deepEqual(job.runtimeEvidence.webUrls, ['https://example.org/reference']);
  assert.equal((await readFile(path.join(job.dir, 'work/web-trace.jsonl'), 'utf8')).trim().split('\n').length, 4);
});
