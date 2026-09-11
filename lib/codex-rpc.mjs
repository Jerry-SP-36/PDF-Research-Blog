import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';

/** Version-matched Codex app-server JSONL transport. No shell or copied credentials. */
export class CodexRpc extends EventEmitter {
  constructor({ executable, cwd, args = [], env = process.env, timeoutMs = 30000 }) {
    super();
    this.executable = executable;
    this.cwd = cwd;
    this.args = args;
    this.env = { ...env };
    // The product must work independently of the development task's desktop pipe.
    delete this.env.CODEX_APP_TOOLS_PIPE_PATH;
    delete this.env.CODEX_THREAD_ID;
    this.timeoutMs = timeoutMs;
    this.pending = new Map();
    this.nextId = 1;
    this.closed = false;
    this.stderr = '';
  }

  async start() {
    if (this.child) throw new Error('Codex transport is already started.');
    this.child = spawn(this.executable, ['app-server', '--stdio', ...this.args], {
      cwd: this.cwd, env: this.env, stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.on('error', (error) => this.fail(error));
    this.child.stdin.on('error', (error) => this.fail(error));
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk) => {
      this.stderr = (this.stderr + chunk).slice(-16000);
      this.emit('diagnostic', chunk);
    });
    this.lines = createInterface({ input: this.child.stdout });
    this.lines.on('line', (line) => {
      let message;
      try { message = JSON.parse(line); }
      catch { this.emit('diagnostic', 'Non-JSON app-server output was ignored.'); return; }
      if (message.id !== undefined && !message.method) {
        const waiting = this.pending.get(String(message.id));
        if (!waiting) return;
        clearTimeout(waiting.timer);
        this.pending.delete(String(message.id));
        if (message.error) waiting.reject(new Error(message.error.message || JSON.stringify(message.error)));
        else waiting.resolve(message.result);
      } else if (message.id !== undefined && message.method) {
        this.emit('serverRequest', message);
      } else if (message.method) {
        this.emit('notification', message);
      }
    });
    this.child.on('exit', (code, signal) => {
      this.fail(new Error(`Codex app-server exited (${signal || code}).`));
      this.emit('exit', { code, signal });
    });
    const initialized = await this.request('initialize', {
      clientInfo: { name: 'pdf_research_studio', title: 'PDF Research', version: '0.5.0' },
      capabilities: { experimentalApi: true },
    });
    this.notify('initialized', {});
    return initialized;
  }

  send(value) {
    if (this.closed || !this.child?.stdin.writable) throw new Error('Codex connection is closed.');
    this.child.stdin.write(JSON.stringify(value) + '\n');
  }

  request(method, params = {}, timeoutMs = this.timeoutMs) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(String(id));
        reject(new Error(`Codex request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(String(id), { resolve, reject, timer });
      try { this.send({ id, method, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(String(id)); reject(error); }
    });
  }

  notify(method, params = {}) { this.send({ method, params }); }
  respond(id, result) { this.send({ id, result }); }
  rejectRequest(id, message = 'This operation is not supported by PDF Research.') {
    this.send({ id, error: { code: -32601, message } });
  }

  fail(error) {
    this.closed = true;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); }
    this.pending.clear();
  }

  close() {
    if (!this.child) return;
    this.closed = true;
    this.child.stdin.end();
    this.child.kill('SIGTERM');
    const child = this.child;
    const timer = setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 2000);
    timer.unref();
    this.fail(new Error('Codex connection closed.'));
  }
}
