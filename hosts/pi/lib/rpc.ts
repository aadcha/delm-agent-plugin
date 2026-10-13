// A Pi worker as a child process in RPC mode: newline-delimited JSON commands
// on stdin, responses and session events on stdout. Framing follows Pi's RPC
// contract: split stdout on LF only, correlate responses by id, and treat every
// other record as an event. Diagnostics stay on stderr.
import {spawn, type ChildProcess} from 'node:child_process';

export type RpcEvent = {type: string; [key: string]: unknown};
export type RpcResponse = {id?: string; type: 'response'; command: string; success: boolean; data?: unknown; error?: string};

const LIMIT = 8 * 1024 * 1024;

export class PiProcess {
  readonly child: ChildProcess;
  readonly pid: number;
  private sequence = 0;
  private buffer = '';
  private stderrTail = '';
  private readonly pending = new Map<string, {resolve: (value: unknown) => void; reject: (error: Error) => void}>();
  private readonly listeners = new Set<(event: RpcEvent) => void>();
  private exitCode: number | null = null;
  private exitSignal: NodeJS.Signals | null = null;
  readonly exited: Promise<{code: number | null; signal: NodeJS.Signals | null}>;

  constructor(command: string, args: string[], options: {cwd: string; env: NodeJS.ProcessEnv}) {
    this.child = spawn(command, args, {
      cwd: options.cwd, env: options.env, stdio: ['pipe', 'pipe', 'pipe'], shell: false,
    });
    if (!this.child.pid) throw new Error('Pi worker did not start.');
    this.pid = this.child.pid;
    this.child.stdout!.setEncoding('utf8');
    this.child.stdout!.on('data', chunk => this.receive(String(chunk)));
    this.child.stderr!.setEncoding('utf8');
    this.child.stderr!.on('data', chunk => { this.stderrTail = (this.stderrTail + String(chunk)).slice(-8192); });
    this.exited = new Promise(resolve => {
      this.child.once('exit', (code, signal) => {
        this.exitCode = code; this.exitSignal = signal;
        const error = new Error('Pi worker exited' + (this.stderrTail.trim() ? ': ' + this.stderrTail.trim() : '.'));
        for (const waiter of this.pending.values()) waiter.reject(error);
        this.pending.clear();
        resolve({code, signal});
      });
      this.child.once('error', error => {
        for (const waiter of this.pending.values()) waiter.reject(error);
        this.pending.clear();
      });
    });
  }

  get running(): boolean { return this.exitCode === null && this.exitSignal === null && !this.child.killed; }
  get stderr(): string { return this.stderrTail; }

  onEvent(listener: (event: RpcEvent) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private receive(chunk: string): void {
    this.buffer += chunk;
    if (this.buffer.length > LIMIT) {
      this.buffer = '';
      this.fail(new Error('Pi worker exceeded the event size limit.'));
      return;
    }
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? '';
    for (let line of lines) {
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (!line.trim()) continue;
      let record: RpcResponse | RpcEvent;
      try { record = JSON.parse(line); } catch { continue; }
      if (record.type === 'response') {
        const response = record as RpcResponse;
        const waiter = response.id === undefined ? undefined : this.pending.get(response.id);
        if (!waiter) continue;
        this.pending.delete(response.id!);
        if (response.success) waiter.resolve(response.data);
        else waiter.reject(new Error(response.error || 'Pi rejected the ' + response.command + ' command.'));
        continue;
      }
      for (const listener of [...this.listeners]) {
        try { listener(record as RpcEvent); } catch { /* A listener failure must not stop event delivery. */ }
      }
    }
  }

  private fail(error: Error): void {
    for (const waiter of this.pending.values()) waiter.reject(error);
    this.pending.clear();
    this.child.kill('SIGTERM');
  }

  send<T = unknown>(command: Record<string, unknown>, timeoutMs = 30000): Promise<T> {
    if (!this.running || !this.child.stdin?.writable) return Promise.reject(new Error('Pi worker is not running.'));
    const id = 'delm-' + (++this.sequence);
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('Pi worker did not answer ' + String(command.type) + ' within ' + timeoutMs + ' ms.'));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: value => { clearTimeout(timer); resolve(value as T); },
        reject: error => { clearTimeout(timer); reject(error); },
      });
      this.child.stdin!.write(JSON.stringify({id, ...command}) + '\n', error => {
        if (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
      });
    });
  }

  prompt(message: string, streamingBehavior?: 'steer' | 'followUp'): Promise<{disposition: string}> {
    return this.send({type: 'prompt', message, ...(streamingBehavior ? {streamingBehavior} : {})});
  }

  steer(message: string): Promise<{disposition: string}> { return this.send({type: 'steer', message}); }
  followUp(message: string): Promise<{disposition: string}> { return this.send({type: 'follow_up', message}); }
  abort(): Promise<void> { return this.send({type: 'abort'}, 10000).then(() => undefined); }
  state(): Promise<Record<string, unknown>> { return this.send({type: 'get_state'}); }
  lastAssistantText(): Promise<string | null> {
    return this.send<{text: string | null}>({type: 'get_last_assistant_text'}).then(data => data?.text ?? null);
  }

  // Orderly shutdown: close stdin so Pi disposes its runtime, then escalate.
  async stop(graceMs = 5000): Promise<{code: number | null; signal: NodeJS.Signals | null}> {
    if (!this.running) return this.exited;
    try { this.child.stdin?.end(); } catch { /* Already closed. */ }
    const result = await Promise.race([this.exited, delay(graceMs).then(() => null)]);
    if (result) return result;
    this.child.kill('SIGTERM');
    const terminated = await Promise.race([this.exited, delay(graceMs).then(() => null)]);
    if (terminated) return terminated;
    this.child.kill('SIGKILL');
    return this.exited;
  }
}

function delay(ms: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, ms)); }
