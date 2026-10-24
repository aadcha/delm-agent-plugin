// The live board: a passive observer over the run's records (`delm pi view`),
// rendered as plain text lines for a Pi widget. Rendering never reads files or
// calls the controller; it mirrors the Claude board's content and wording.
import {spawn, execFile, type ChildProcess} from 'node:child_process';

export type View = {
  status: string;
  finished: boolean;
  revision?: number;
  freshness?: {unavailable?: string[]};
  agents: {slot: number; name: string; native_state: string; task_ids?: number[]; task_count?: number;
    reported_state?: string | null; summary?: string | null; dependency?: string | null}[];
  tasks: {items: TaskItem[]; total: number};
  shared: {items: SharedItem[]; total: number};
  checks: {items: CheckItem[]; total: number};
  outcome?: Outcome | null;
};
export type TaskItem = {id: number; task_number?: number; title: string; description?: string; owner?: number | null;
  state: string; kind?: string};
export type SharedItem = {id: number; kind: string; worker: number; title: string; imports?: unknown[]};
export type CheckItem = {id: number; worker: number; summary: string; passed?: boolean | null; inputs_unchanged?: boolean | null;
  reusable?: boolean | null; command?: string};
export type Outcome = {status?: string; delivered?: boolean | null; verification_required?: boolean | null;
  cleanup_complete?: boolean | null; recovery_saved?: boolean | null; recovery_path?: string | null;
  changed_paths_count?: number | null; conflicts_total?: number; reason?: string | null};

export const PHASES: Record<string, string> = {
  preparing: 'Preparing', prepared: 'Starting agents', starting: 'Starting agents', running: 'Working', working: 'Working',
  awaiting_shutdown: 'Finishing', verifying_shutdown: 'Finishing', finishing: 'Finishing', stopping: 'Stopping',
  complete: 'Complete', completed: 'Complete', delivered: 'Changes applied', stopped: 'Stopped', cancelled: 'Stopped',
  delivery_conflict: 'Delivery needs attention', recovery_required: 'Needs attention', interrupted: 'Needs attention',
  failed: 'Needs attention', startup_failed: 'Could not start', preparation_failed: 'Could not prepare',
};

export function phaseLabel(view: View): string {
  const outcome = view.outcome;
  if (outcome?.status === 'delivered' && outcome.verification_required) return 'Changes applied · check needed';
  if (view.status === 'stopped' && outcome?.recovery_saved) return 'Stopped · changes saved';
  return PHASES[view.status] || 'Status unavailable';
}

export function agentState(agent: View['agents'][number], view?: Pick<View, 'agents' | 'finished'>): string {
  const native: Record<string, string> = {starting: 'Starting', ready: 'Ready', working: 'Working', waiting: 'Waiting for a peer',
    blocked: 'Needs attention', stopped: 'Stopped'};
  // A stopped agent's last self-report no longer describes it.
  if (agent.native_state === 'stopped' || view?.finished) return 'Stopped';
  if (agent.reported_state === 'blocked') return 'Needs attention';
  if (agent.reported_state === 'waiting' && agent.dependency) return 'Waiting on ' + dependencyLabel(agent.dependency, view);
  return native[agent.native_state] || (agent.task_ids?.length ? 'Claimed' : 'Status unavailable');
}

/** `worker:2` names a peer; other dependencies name a contribution and are shown as written. */
function dependencyLabel(dependency: string, view?: Pick<View, 'agents'>): string {
  const peer = /^worker:(\d+)$/.exec(dependency);
  if (!peer) return dependency;
  return view?.agents.find(agent => String(agent.slot) === peer[1])?.name || 'Agent ' + peer[1];
}

export function taskLabel(task: TaskItem): string {
  return '#' + (task.task_number ?? task.id);
}

export function taskState(task: TaskItem, view: View): string {
  const owner = view.agents.find(agent => agent.slot === task.owner);
  const label: Record<string, string> = {open: 'Available', available: 'Available', claimed: 'Claimed', done: 'Done', completed: 'Done'};
  const state = label[task.state] || 'State unavailable';
  return owner && task.state === 'claimed' ? state + ' by ' + owner.name : state;
}

export function cleanText(value: unknown, limit = 4000): string {
  return String(value ?? '').replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g, '')
    .replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|[@-_])/g, '')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]/g, '')
    .replace(/[\r\t\n]+/g, ' ').slice(0, limit);
}

export function fit(value: unknown, width: number): string {
  const text = cleanText(value);
  const cells = Math.max(0, Math.floor(width));
  if (!cells) return '';
  const chars = Array.from(text);
  if (chars.length <= cells) return text;
  return chars.slice(0, Math.max(0, cells - 1)).join('') + '…';
}

function agentName(view: View, slot: unknown): string {
  return view.agents.find(agent => agent.slot === slot)?.name || 'Agent';
}

function outcomeLines(view: View): string[] {
  const outcome = view.outcome;
  if (!outcome) return [];
  const lines: string[] = [];
  if (outcome.delivered) lines.push('Changes applied to your project' + (outcome.changed_paths_count != null ? ' · ' + outcome.changed_paths_count + ' files' : '') + '.');
  if (outcome.verification_required) lines.push('A focused check is needed in the original project.');
  if (outcome.conflicts_total) lines.push(outcome.conflicts_total + ' conflicting edits were kept out; see the handoff.');
  if (outcome.recovery_saved && !outcome.delivered) lines.push('Unfinished changes were saved for recovery.');
  if (outcome.reason) lines.push(fit(outcome.reason, 100));
  return lines;
}

/** Pi shows at most this many widget lines and appends "widget truncated" beyond it. */
export const WIDGET_ROWS = 10;

/** The compact board shown above the editor; it never exceeds `rows` lines. */
export function renderBoard(view: View, width: number, rows = WIDGET_ROWS, hint = '/delm:board tasks|shared|checks · /delm:board hide'): string[] {
  const inner = Math.max(20, width - 2);
  const head: string[] = ['DeLM · ' + phaseLabel(view) + (view.revision && view.revision > 1 ? ' · revision ' + view.revision : '')];
  const unavailable = view.freshness?.unavailable || [];
  if (unavailable.includes('board')) head.push('  Some updates are temporarily unavailable');
  if (!view.agents.length) head.push('  Waiting for agents to start');
  for (const agent of view.agents) {
    const task = view.tasks.items.find(item => (agent.task_ids || []).map(String).includes(String(item.id)));
    const label = '  ' + agent.name + ' · ' + agentState(agent, view);
    head.push(fit(label + (task ? ' · ' + taskLabel(task) + ' ' + task.title : ''), inner));
  }
  const shared = view.shared.items[0];
  const sharedLines = ['Shared context · ' + view.shared.total + (view.checks.total ? ' · ' + view.checks.total + ' checks' : '')];
  if (!shared) sharedLines.push('  ' + (unavailable.includes('board') ? 'Shared context temporarily unavailable' : 'No findings or code shared yet'));
  else {
    const imports = (shared.imports || []).map(item => agentName(view, typeof item === 'object' && item ? (item as {worker_id?: unknown}).worker_id : item));
    const tail = ' · ' + agentName(view, shared.worker) + (imports.length ? ' · Imported by ' + imports.join(', ') : '');
    sharedLines.push('  ' + fit(shared.title, Math.max(1, inner - 2 - tail.length)) + tail);
  }
  const outcome = outcomeLines(view).map(line => '  ' + fit(line, inner - 2));
  const hintLines = hint ? [fit(hint, inner)] : [];
  const open = view.tasks.items.filter(task => !['done', 'completed'].includes(task.state));
  const done = view.tasks.items.filter(task => ['done', 'completed'].includes(task.state));
  const ordered = [...open, ...done];
  // The queue takes whatever height the fixed sections leave; the hint goes first when even one task would not fit.
  const fixed = head.length + 1 + sharedLines.length + outcome.length;
  let budget = Math.min(4, rows - fixed - hintLines.length);
  if (budget < 1 && ordered.length && hintLines.length) { hintLines.length = 0; budget = Math.min(4, rows - fixed); }
  const shown = ordered.slice(0, Math.max(0, budget));
  const queue = ['Task queue · ' + view.tasks.total + (view.tasks.total > shown.length ? ' · ' + shown.length + ' shown' : '')];
  if (!shown.length && !ordered.length) queue.push('  ' + (unavailable.includes('board') ? 'Tasks temporarily unavailable' : 'No tasks shared yet'));
  for (const task of shown) {
    const tail = ' · ' + taskState(task, view);
    const prefix = '  ' + taskLabel(task) + ' ';
    queue.push(prefix + fit(task.title, Math.max(1, inner - prefix.length - tail.length)) + tail);
  }
  const lines = [...head, ...queue, ...sharedLines, ...outcome, ...hintLines];
  // Pi appends its own truncation notice beyond `rows`, so the board drops its least important lines instead.
  while (lines.length > rows && hintLines.length) { lines.pop(); hintLines.pop(); }
  return lines.slice(0, rows).map(line => fit(line, width));
}

/** A full collection for the detail overlay. */
export function renderCollection(view: View, kind: 'tasks' | 'shared' | 'checks', width: number): string[] {
  const inner = Math.max(20, width - 4);
  const shownCount = view[kind].items.length;
  const header = {tasks: 'All tasks', shared: 'Shared context', checks: 'Recorded checks'}[kind] + ' · ' + view[kind].total
    + (view[kind].total > shownCount ? ' · first ' + shownCount + ' shown' : '');
  const lines: string[] = [header, ''];
  if (kind === 'tasks') {
    if (!view.tasks.items.length) lines.push('No tasks shared yet');
    for (const task of view.tasks.items) {
      lines.push(taskLabel(task) + ' ' + fit(task.title, inner - 6) + '  · ' + taskState(task, view));
      if (task.description) lines.push('    ' + fit(task.description, inner - 4));
    }
  } else if (kind === 'shared') {
    if (!view.shared.items.length) lines.push('No findings or code shared yet');
    for (const entry of view.shared.items) {
      const imports = (entry.imports || []).map(item => agentName(view, typeof item === 'object' && item ? (item as {worker_id?: unknown}).worker_id : item));
      lines.push(fit(entry.title, inner));
      lines.push('    ' + agentName(view, entry.worker) + ' · ' + (entry.kind === 'publication' ? 'Code shared' : 'Finding shared')
        + (imports.length ? ' · Imported by ' + imports.join(', ') : entry.kind === 'publication' ? ' · No peer import confirmed' : ''));
    }
  } else {
    if (!view.checks.items.length) lines.push('No checks recorded yet');
    for (const check of view.checks.items) {
      lines.push(fit(check.summary || check.command || 'Recorded check', inner));
      lines.push('    ' + agentName(view, check.worker) + ' · ' + (check.passed === true ? 'Recorded pass' : check.passed === false ? 'Recorded failure' : 'Outcome unavailable')
        + (check.reusable === false || check.inputs_unchanged === false ? ' · Not valid for reuse' : ''));
    }
  }
  lines.push('', 'Esc or q to close');
  return lines.map(line => fit(line, width - 2));
}

export class BoardObserver {
  private child: ChildProcess | null = null;
  private buffer = '';
  private readonly executable: string;
  private readonly runId: string;
  private readonly sessionId: string;
  constructor(executable: string, runId: string, sessionId: string) {
    this.executable = executable;
    this.runId = runId;
    this.sessionId = sessionId;
  }

  start(onView: (view: View) => void, onError: (message: string) => void): void {
    if (this.child) return;
    const child = spawn(this.executable, ['pi', 'view', '--run-id', this.runId, '--session-id', this.sessionId, '--watch', '--interval-ms', '500'],
      {stdio: ['ignore', 'pipe', 'pipe'], shell: false});
    this.child = child;
    let stderr = '';
    child.stdout!.setEncoding('utf8');
    child.stderr!.setEncoding('utf8');
    child.stderr!.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-2048); });
    child.stdout!.on('data', chunk => {
      this.buffer += String(chunk);
      const lines = this.buffer.split('\n');
      this.buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try { onView(JSON.parse(line)); } catch { /* A partial record is skipped. */ }
      }
    });
    child.once('exit', code => {
      if (this.child === child) this.child = null;
      if (code && stderr.trim()) onError(stderr.trim());
    });
  }

  get running(): boolean { return this.child !== null; }

  stop(): void {
    const child = this.child;
    this.child = null;
    if (child && !child.killed) child.kill('SIGTERM');
  }
}

/** One complete collection page for the detail overlay. */
// The observer serves at most 32 rows per page.
export const PAGE_LIMIT = 32;

export function fetchCollection(executable: string, runId: string, sessionId: string, collection: 'tasks' | 'shared' | 'checks',
  limit = PAGE_LIMIT): Promise<View> {
  return new Promise((resolve, reject) => {
    execFile(executable, ['pi', 'view', '--run-id', runId, '--session-id', sessionId, '--collection', collection, '--limit', String(limit)],
      {timeout: 15000, maxBuffer: 8 * 1024 * 1024}, (error, stdout, stderr) => {
        if (error) return reject(new Error(String(stderr || error.message).trim()));
        const line = String(stdout).split('\n').filter(item => item.trim()).at(-1);
        try { resolve(JSON.parse(line || '{}')); } catch (parseError) { reject(parseError as Error); }
      });
  });
}
