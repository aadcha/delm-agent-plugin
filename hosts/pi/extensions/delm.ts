// DeLM for Pi: the parent session's extension. It starts the shared runtime,
// forks the conversation into two private Pi workers, relays their native
// events to the controller, applies the controller's actions, forwards the
// user's updates, and reports the delivered result.
import type {ExtensionAPI, ExtensionContext} from '@earendil-works/pi-coding-agent';
import {SessionManager} from '@earendil-works/pi-coding-agent';
import {appendFileSync, mkdtempSync, readFileSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {PiProcess, type RpcEvent} from '../lib/rpc.ts';
import {TicketServer, bridgeRoot, type TicketRequest, type ReleaseRequest} from '../lib/bridge.ts';
import {request, startBridge, type Action, type Bridge} from '../lib/control.ts';
import {commandOutcome, explainModelError, hostNotes, launchPrompt, turnReason, updateText} from '../lib/protocol.ts';
import {BoardObserver, fetchCollection, renderBoard, renderCollection, type View} from '../lib/board.ts';
import {existsSync, readdirSync} from 'node:fs';
import {homedir} from 'node:os';

type Worker = {
  slot: number;
  agentId: string;
  process: PiProcess;
  turn: string | null;
  deliveredRevision: number;
  pendingUpdate: {revision: number; message: string} | null;
  status: 'running' | 'completed' | 'failed' | 'killed';
  stopPromise: Promise<unknown> | null;
  lastError: string | null;
};

type Run = {
  sessionId: string;
  log: (line: string) => void;
  modelErrorReported: boolean;
  observer: BoardObserver | null;
  view: View | null;
  boardHidden: boolean;
  task: string;
  bridge: Bridge;
  revision: number;
  workers: Worker[];
  tickets: TicketServer[];
  finalization: {generation: number; revision: number; intent: string} | null;
  settling: Promise<void> | null;
  finished: boolean;
  final: Action | null;
  lastAction: string | null;
  failure: string | null;
  stopRequested: boolean;
  sessionDir: string;
};

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function runtimeExecutable(): string {
  return process.env.DELM_PI_RUNTIME || join(PACKAGE_ROOT, 'bin', 'delm');
}

function workerPolicy(): string {
  const policy = readFileSync(join(PACKAGE_ROOT, 'worker.md'), 'utf8');
  return policy.trimEnd() + '\n\n' + hostNotes() + '\n';
}

export default function (pi: ExtensionAPI) {
  if (process.env.DELM_PI_WORKER) return;   // A worker never starts a nested run.

  let run: Run | null = null;
  let lastFinished: Run | null = null;
  let ctxRef: ExtensionContext | null = null;

  const notify = (message: string, level: 'info' | 'warning' | 'error' = 'info') => {
    try { ctxRef?.ui.notify(message, level); } catch { /* No UI in print mode. */ }
  };
  const status = (text: string | undefined) => {
    try { ctxRef?.ui.setStatus('delm', text); } catch { /* No UI in print mode. */ }
  };

  async function control(op: string, fields: Record<string, unknown> = {}, timeoutMs?: number) {
    if (!run) throw new Error('No DeLM run is active.');
    return request(run.bridge.ready, op, fields, timeoutMs);
  }

  function worker(agentId: unknown): Worker | undefined {
    return run?.workers.find(w => w.agentId === agentId);
  }

  // ---- actions from the controller ------------------------------------------

  async function applyActions(list: Action[]) {
    const current = run;
    if (!current) return;
    for (const action of list) {
      if (current.finished && action.type !== 'final') return;
      if (action.id && current.lastAction === action.id) continue;
      try {
        await applyAction(action);
      } catch (error) {
        current.failure = String((error as Error).message || error);
        notify('DeLM: ' + current.failure, 'error');
      }
      if (action.id) current.lastAction = action.id;
      if (current.finished) return;
    }
  }

  async function applyAction(action: Action) {
    if (!run) return;
    switch (action.type) {
      case 'candidate':
      case 'stop': {
        const finalization = action.finalization as Run['finalization'];
        if (!finalization) throw new Error('DeLM received an incompatible finalization contract.');
        if (finalization.revision < run.revision) return;
        run.finalization = finalization;
        status(finalization.intent === 'deliver' ? 'DeLM: delivering' : 'DeLM: stopping');
        void settle();
        return;
      }
      case 'resume': {
        const target = worker(action.agent_id);
        if (!target || run.finalization) return;
        if (Number.isSafeInteger(action.revision)) run.revision = Math.max(run.revision, action.revision as number);
        await deliver(target, String(action.message), action.revision as number, true);
        return;
      }
      case 'context': {
        const target = worker(action.agent_id);
        if (!target || run.finalization) return;
        if (Number.isSafeInteger(action.revision)) run.revision = Math.max(run.revision, action.revision as number);
        await deliver(target, String(action.message), action.revision as number, false);
        return;
      }
      case 'completion_intent':
        return;
      case 'final': {
        run.finished = true;
        run.final = action;
        status(undefined);
        const outcome = String(action.status);
        const delivered = outcome === 'complete' || outcome === 'delivered';
        if (delivered) notify('DeLM delivered the result into your project.');
        else if (run.modelErrorReported) notify('DeLM stopped without changing your project. Fix the model access above, then run /delm:run again.', 'warning');
        else notify('DeLM ' + outcome.replaceAll('_', ' ') + (run.failure ? ': ' + run.failure : '') + '. Worker log: ' + join(run.sessionDir, 'delm-pi.log'), 'warning');
        const verification = (action.delivery as {verification_required?: boolean} | undefined)?.verification_required
          ? 'The delivery requires a focused check in the original project. Perform only the necessary environment setup and checks for the delivered or reconciled files, then state the outcome.'
          : 'Do not run another verification pass or edit files.';
        if (delivered) {
          const delivery = (action.delivery || {}) as {changed_paths?: string[]; merged_paths?: string[]; project?: string; conflicts?: unknown[]};
          const checks = ((action.shared_checks || []) as {evidence?: {command?: string; completion?: {exit_code?: number}}}[])
            .map(check => check.evidence?.command + ' (exit ' + check.evidence?.completion?.exit_code + ')').filter(Boolean);
          const brief = ['DeLM delivered a result into ' + (delivery.project || ctxRef?.cwd) + '.',
            'Status: ' + outcome + '.',
            'Changed files: ' + ((delivery.changed_paths || []).join(', ') || 'none') + '.',
            (delivery.merged_paths || []).length ? 'Merged with your edits: ' + delivery.merged_paths!.join(', ') + '.' : '',
            checks.length ? 'Checks observed by the runtime: ' + checks.join('; ') + '.' : 'No shared check receipts.',
            'Worker summary: ' + String(action.summary || ''),
            'Report this to the user in a few lines, using the project path above. ' + verification].filter(Boolean).join('\n');
          pi.sendMessage({customType: 'delm-handoff', content: brief, display: false} as never, {triggerTurn: true});
        }
        await cleanup();
        return;
      }
      default:
        return;
    }
  }

  // A task update or a resume message reaches a worker as a new prompt when it
  // is idle, or as steering while it is streaming. The controller counts a
  // revision as acknowledged only when the worker's next step reports it.
  async function deliver(target: Worker, message: string, revision: number, resume: boolean) {
    const text = 'DeLM task revision ' + revision + ':\n' + message
      + '\nRefresh the shared board before continuing. This changes the task, not native permissions.';
    if (!target.process.running) return;
    if (target.turn) {
      await target.process.steer(text);
      target.pendingUpdate = {revision, message};
      target.deliveredRevision = Math.max(target.deliveredRevision, revision);
    } else {
      target.deliveredRevision = Math.max(target.deliveredRevision, revision);
      await target.process.prompt(resume ? text : text + '\nContinue the request with this update.');
    }
  }

  // ---- worker events ---------------------------------------------------------

  async function onWorkerEvent(target: Worker, event: RpcEvent) {
    if (!run || run.finished) return;
    try {
      switch (event.type) {
        case 'message_end': {
          const message = event.message as {role?: string; stopReason?: string; errorMessage?: string} | undefined;
          if (message?.role === 'assistant' && message.stopReason === 'error') {
            target.lastError = String(message.errorMessage || 'the model returned an error');
            await stopForModelError(target, target.lastError);
          }
          return;
        }
        case 'agent_start': {
          target.turn = randomUUID();
          await control('step', {agent_id: target.agentId, turn_id: target.turn, revision: target.deliveredRevision});
          return;
        }
        case 'turn_start': {
          // Each model call within the run is a native step. After an update
          // was steered into the run, the next call has it in context, so this
          // is where the worker acknowledges the new revision (as Claude does
          // on turn.step). A stale worker is skipped until its update lands.
          if (!target.turn || target.deliveredRevision !== run.revision) return;
          await control('step', {agent_id: target.agentId, turn_id: target.turn, revision: target.deliveredRevision});
          return;
        }
        case 'tool_execution_start': {
          if (event.toolName !== 'bash' || !target.turn) return;
          const args = (event.args || {}) as {command?: string};
          try {
            await control('command_start', {
              agent_id: target.agentId, turn_id: target.turn, call_id: String(event.toolCallId),
              command: String(args.command ?? ''), cwd: run.bridge.ready.workers[target.slot - 1].cwd,
            });
          } catch (error) {
            // Unrecorded evidence only means this command cannot back a check receipt.
            run.log('worker ' + target.slot + ' command_start refused: ' + String((error as Error).message || error));
          }
          return;
        }
        case 'tool_execution_end': {
          if (event.toolName !== 'bash' || !target.turn) return;
          const outcome = commandOutcome(event as {result?: unknown; isError?: boolean});
          try {
            await control('command_end', {
              agent_id: target.agentId, call_id: String(event.toolCallId), result_ref: String(event.toolCallId),
              exit_code: outcome.exit_code, is_error: outcome.is_error, interrupted: outcome.interrupted,
              timed_out: outcome.timed_out, background_task_id: null,
            });
          } catch (error) {
            run.log('worker ' + target.slot + ' command_end refused: ' + String((error as Error).message || error));
          }
          return;
        }
        case 'agent_settled': {
          if (!target.turn) return;
          const turn = target.turn;
          target.turn = null;
          const answer = (await target.process.lastAssistantText().catch(() => null)) || '';
          const reason = target.lastError && !answer ? 'failed' : turnReason(event as {aborted?: boolean}, !target.process.running);
          target.lastError = null;
          const result = await control('turn_end', {agent_id: target.agentId, turn_id: turn, reason, answer});
          await applyActions((result.actions as Action[]) || []);
          if (target.pendingUpdate && reason === 'completed' && !run.finalization && target.process.running) {
            const pending = target.pendingUpdate;
            target.pendingUpdate = null;
            await deliver(target, pending.message, pending.revision, true);
          }
          return;
        }
        default:
          return;
      }
    } catch (error) {
      if (!run.finalization) {
        run.failure = String((error as Error).message || error);
        notify('DeLM: ' + run.failure, 'error');
      }
    }
  }

  // The workers use the same provider login as this session, so a refusal is
  // almost always about the account, not the task. Stop before the controller
  // spends resumes on empty turns, and tell the user what to change.
  async function stopForModelError(target: Worker, error: string) {
    if (!run || run.finished || run.finalization || run.modelErrorReported) return;
    run.modelErrorReported = true;
    run.failure = explainModelError(error);
    notify('DeLM stopped: peer ' + target.slot + '\'s model request was rejected. ' + run.failure
      + ' Nothing in your project was changed.', 'error');
    try {
      const cancelled = await control('cancel', {reason: 'Peer model error'});
      await applyActions((cancelled.actions as Action[]) || []);
    } catch (cancelError) {
      notify('DeLM could not stop cleanly: ' + String((cancelError as Error).message || cancelError), 'error');
    }
  }

  async function onWorkerExit(target: Worker) {
    if (!run || run.finished) return;
    if (target.status === 'running') target.status = run.finalization ? 'killed' : 'failed';
    if (target.turn) {
      const turn = target.turn;
      target.turn = null;
      try {
        const result = await control('turn_end', {agent_id: target.agentId, turn_id: turn, reason: 'failed', answer: ''});
        await applyActions((result.actions as Action[]) || []);
      } catch { /* The controller retires the turn at settlement. */ }
    }
  }

  // ---- launch ----------------------------------------------------------------

  // `pi auth check` refreshes and validates the provider login the workers will
  // inherit. It cannot see usage quotas; those surface on the first request.
  function checkLogin(model: {provider: string; id: string} | null): Promise<void> {
    if (!model) return Promise.reject(new Error('No model is selected in this Pi session. Choose one with /model, then run /delm:run again.'));
    return new Promise((resolve, reject) => {
      execFile(process.env.DELM_PI_COMMAND || 'pi', ['auth', 'check', '--provider', model.provider, '--model', model.id, '--json'],
        {timeout: 30000, env: process.env}, (error, stdout, stderr) => {
          if (!error) return resolve();
          if (process.env.DELM_PI_COMMAND) return resolve();   // a scripted host has no login
          const detail = String(stdout || stderr || error.message).trim().replace(/\s+/g, ' ').slice(0, 300);
          reject(new Error('Pi has no working login for ' + model.provider + '/' + model.id + ' (' + detail + '). Run /login in Pi, then /delm:run again.'));
        });
    });
  }

  async function launch(ctx: ExtensionContext, task: string) {
    if (lastFinished) { stopBoard(lastFinished); lastFinished = null; try { ctx.ui.setWidget('delm-board', undefined); } catch { /* no UI */ } }
    const executable = runtimeExecutable();
    const selected = ctx.model ? {provider: (ctx.model as {provider: string}).provider, id: (ctx.model as {id: string}).id} : null;
    await checkLogin(selected);
    const sessionId = ctx.sessionManager.getSessionId();
    const parentFile = ctx.sessionManager.getSessionFile();
    const bridge = await startBridge(executable, {
      project: ctx.cwd, session_id: sessionId, task, host_version: null, package_root: PACKAGE_ROOT,
    }, actions => { void applyActions(actions); });
    if (bridge.ready.session_id !== sessionId) throw new Error('DeLM returned workspaces for another conversation.');
    const sessionDir = mkdtempSync(join(tmpdir(), 'delm-pi-sessions-'));
    const logFile = join(sessionDir, 'delm-pi.log');
    const log = (line: string) => { try { appendFileSync(logFile, new Date().toISOString() + ' ' + line + '\n'); } catch { /* Diagnostics only. */ } };
    run = {
      sessionId, task, bridge, revision: bridge.ready.revision, workers: [], tickets: [], finalization: null,
      settling: null, finished: false, final: null, lastAction: null, failure: null, stopRequested: false, sessionDir, log,
      modelErrorReported: false, observer: null, view: null, boardHidden: false,
    };
    startBoard(ctx);
    log('run ' + bridge.ready.run_id + ' project ' + ctx.cwd + ' sessions ' + sessionDir);
    void bridge.exited.then(() => { if (run && !run.finished) { run.failure = 'DeLM runtime exited.'; status('DeLM: runtime exited'); } });
    const policyFile = join(sessionDir, 'worker-policy.md');
    writeFileSync(policyFile, workerPolicy(), {mode: 0o600});
    const model = selected ? `${selected.provider}/${selected.id}` : null;
    const thinking = pi.getThinkingLevel();
    const root = bridgeRoot();
    try {
      for (const slot of [1, 2]) {
        const cwd = bridge.ready.workers[slot - 1].cwd;
        const bridgePath = join(root, bridge.ready.run_id + '-' + slot + '.sock');
        const tickets = new TicketServer(bridgePath, message => ticketHandler(slot, message));
        await tickets.listen();
        run.tickets.push(tickets);
        let sessionFile: string | null = null;
        if (parentFile) {
          try {
            const forked = SessionManager.forkFrom(parentFile, cwd, sessionDir);
            sessionFile = forked.getSessionFile() ?? null;
          } catch { sessionFile = null; }
        }
        const args = ['--mode', 'rpc', '--session-dir', sessionDir,
          ...(sessionFile ? ['--session', sessionFile] : []),
          '--append-system-prompt', policyFile,
          '--extension', join(PACKAGE_ROOT, 'extensions', 'delm-worker.ts'),
          ...(model ? ['--model', model] : []), ...(thinking ? ['--thinking', String(thinking)] : [])];
        const child = new PiProcess(process.env.DELM_PI_COMMAND || 'pi', args, {
          cwd, env: {...process.env, DELM_PI_WORKER: String(slot), DELM_PI_BRIDGE: bridgePath, DELM_PI_RUNTIME: executable,
            DELM_PI_RUN: bridge.ready.run_id},
        });
        const target: Worker = {
          slot, agentId: 'pi-' + slot + '-' + child.pid, process: child, turn: null,
          deliveredRevision: bridge.ready.revision, pendingUpdate: null, status: 'running', stopPromise: null, lastError: null,
        };
        run.workers.push(target);
        let deltas = 0;
        child.onEvent(event => {
          if (event.type === 'message_update') {
            // A heartbeat every 200 stream deltas shows a long response is still flowing.
            if (++deltas % 200 === 0) run?.log('worker ' + slot + ' streaming: ' + deltas + ' deltas');
          } else if (event.type !== 'tool_execution_update') {
            run?.log('worker ' + slot + ' ' + JSON.stringify(event).slice(0, 2000));
          }
          void onWorkerEvent(target, event);
        });
        run.log('worker ' + slot + ' pid ' + child.pid + ' args ' + JSON.stringify(args));
        void child.exited.then(() => onWorkerExit(target));
        await control('bind', {slot, agent_id: target.agentId});
        await control('configure_scopes', {agent_id: target.agentId, scopes: [{path: cwd, access: 'write'}]});
      }
      for (const target of run.workers) {
        await target.process.prompt(launchPrompt(task, target.slot));
      }
    } catch (error) {
      try { await control('cancel', {reason: 'Native peer launch failed'}); } catch { /* Recovery retains the workspace. */ }
      await cleanup();
      throw error;
    }
    status('DeLM: 2 peers working');
  }

  async function ticketHandler(slot: number, message: TicketRequest | ReleaseRequest) {
    if (!run || run.finished) return {error: 'DeLM run is not active.'};
    if ('release' in message) {
      try { await control('revoke', {ticket: message.release}); } catch { /* Already consumed. */ }
      return {released: true};
    }
    const target = run.workers[slot - 1];
    if (!target?.turn) return {error: 'The worker has no active native turn.'};
    const reservation = await control('reserve', {
      agent_id: target.agentId, turn_id: target.turn, call_id: message.call_id, tool: message.tool, arguments: message.arguments,
    });
    if (typeof reservation.ticket !== 'string') return {error: 'Missing native invocation ticket.'};
    return {socket: run.bridge.ready.socket, ticket: reservation.ticket};
  }

  // ---- the live board ----------------------------------------------------------

  const BOARD_WIDTH = 100;

  function paintBoard() {
    if (!run || !ctxRef?.hasUI) return;
    if (run.boardHidden || !run.view) { try { ctxRef.ui.setWidget('delm-board', undefined); } catch { /* no UI */ } return; }
    try { ctxRef.ui.setWidget('delm-board', renderBoard(run.view, BOARD_WIDTH)); } catch { /* no UI */ }
  }

  function startBoard(ctx: ExtensionContext) {
    if (!run || !ctx.hasUI) return;
    const current = run;
    const observer = new BoardObserver(runtimeExecutable(), current.bridge.ready.run_id, current.sessionId);
    current.observer = observer;
    observer.start(view => {
      if (run !== current && !(current.finished && run === null)) return;
      current.view = view;
      if (run === current) paintBoard();
    }, message => current.log('board observer: ' + message));
  }

  function stopBoard(target: Run) {
    target.observer?.stop();
    target.observer = null;
  }

  async function showCollection(ctx: ExtensionContext, kind: 'tasks' | 'shared' | 'checks') {
    if (!run) { ctx.ui.notify('No DeLM run in this session.', 'info'); return; }
    let view: View;
    try { view = await fetchCollection(runtimeExecutable(), run.bridge.ready.run_id, run.sessionId, kind); }
    catch (error) { ctx.ui.notify('DeLM board detail unavailable: ' + String((error as Error).message || error), 'warning'); return; }
    const lines = renderCollection(view, kind, BOARD_WIDTH);
    await ctx.ui.custom<void>((tui, _theme, _keys, done) => {
      let offset = 0;
      const component = {
        render(width: number) {
          const height = Math.max(5, Math.min(lines.length, 30));
          const page = lines.slice(offset, offset + height).map(line => ' ' + line.slice(0, Math.max(0, width - 2)));
          while (page.length < height) page.push('');
          return page;
        },
        invalidate() { /* nothing cached */ },
        handleInput(data: string) {
          if (data === '\x1b' || data === 'q' || data === '\r' || data === '\n') { done(); return; }
          if (data === '\x1b[B' || data === 'j') offset = Math.min(Math.max(0, lines.length - 5), offset + 1);
          if (data === '\x1b[A' || data === 'k') offset = Math.max(0, offset - 1);
          tui.requestRender();
        },
      };
      return component as never;
    }, {overlay: true, overlayOptions: {width: '80%', maxHeight: '80%', anchor: 'center' as never}});
  }

  // ---- shutdown and settlement -------------------------------------------------

  async function stopWorkers(): Promise<{id: string; status: string}[]> {
    if (!run) return [];
    await Promise.all(run.workers.map(async target => {
      if (target.stopPromise) return target.stopPromise;
      target.stopPromise = (async () => {
        if (target.process.running) {
          try { await target.process.abort(); } catch { /* The process may already be settling. */ }
          await target.process.stop();
          target.status = 'killed';
        } else if (target.status === 'running') {
          target.status = 'completed';
        }
      })();
      return target.stopPromise;
    }));
    return run.workers.map(target => ({id: target.agentId, status: target.status}));
  }

  async function settle() {
    if (!run || run.finished || !run.finalization) return;
    if (run.settling) return run.settling;
    const current = run;
    const fence = {...current.finalization};
    current.settling = (async () => {
      try {
        const begun = await control('begin_settle', {generation: fence.generation, revision: fence.revision});
        if (current.stopRequested && (begun.finalization as {intent?: string})?.intent !== 'cancel') {
          const cancelled = await control('cancel', {reason: 'User requested /delm-stop'});
          await applyActions((cancelled.actions as Action[]) || []);
          return;
        }
        const agents = await stopWorkers();
        const final = await control('settle', {
          generation: fence.generation, revision: fence.revision, agents, background_tasks_stopped: true,
        });
        await applyActions((final.actions as Action[]) || []);
      } catch (error) {
        if (!current.finished) {
          try { await control('settlement_failed', {generation: fence.generation, revision: fence.revision}); } catch { /* Recovery. */ }
        }
        current.failure = String((error as Error).message || error);
        notify('DeLM: ' + current.failure + (current.finished ? '' : ' Private workspaces are preserved for recovery.'), 'error');
      }
    })();
    try { await current.settling; } finally { current.settling = null; }
  }

  async function cleanup() {
    if (!run) return;
    // The board observer exits by itself once the run record is finished.
    for (const tickets of run.tickets) { try { await tickets.close(); } catch { /* Already closed. */ } }
    for (const target of run.workers) { if (target.process.running) void target.process.stop(1000); }
    status(undefined);
    if (run.finished) { lastFinished = run; run = null; }
  }

  // ---- commands and input ----------------------------------------------------

  pi.registerCommand('delm:run', {
    description: 'Build in parallel with collaborating Pi agents and deliver their changes to this project',
    handler: async (args, ctx) => {
      ctxRef = ctx;
      const task = (args || '').trim();
      if (run && !run.finished) {
        if (!task) { ctx.ui.notify('A DeLM run is already active. Send text to update it, or /delm:stop.', 'warning'); return; }
        await forward(task);
        return;
      }
      if (!task) { ctx.ui.notify('Enter a task after /delm:run.', 'warning'); return; }
      try {
        await launch(ctx, task);
        ctx.ui.notify('DeLM started two peers in private copies of this project. Send text here to update the task; /delm:stop cancels.', 'info');
      } catch (error) {
        ctx.ui.notify('DeLM could not start: ' + String((error as Error).message || error).replace(/^Error:\s*/, ''), 'error');
      }
    },
  });

  pi.registerCommand('delm:stop', {
    description: 'Stop the active DeLM run and save unfinished changes',
    handler: async (_args, ctx) => {
      ctxRef = ctx;
      if (!run || run.finished) { ctx.ui.notify('No DeLM run is active.', 'info'); return; }
      run.stopRequested = true;
      try {
        const cancelled = await control('cancel', {reason: 'User requested /delm-stop'});
        await applyActions((cancelled.actions as Action[]) || []);
      } catch (error) {
        ctx.ui.notify('DeLM could not stop cleanly: ' + String((error as Error).message || error), 'error');
      }
    },
  });

  // /delm:status reopens the board, as in Claude Code; without a run it says so briefly.
  pi.registerCommand('delm:status', {
    description: 'Show the DeLM board for this session',
    handler: async (_args, ctx) => {
      ctxRef = ctx;
      const target = run || lastFinished;
      if (!target) { ctx.ui.notify('No DeLM run in this session.', 'info'); return; }
      target.boardHidden = false;
      if (!ctx.hasUI) {
        ctx.ui.notify('DeLM ' + (target.view ? target.view.status : target.finished ? String(target.final?.status) : 'running')
          + (target.failure ? '. ' + target.failure : ''), 'info');
        return;
      }
      if (target.view) ctx.ui.setWidget('delm-board', renderBoard(target.view, BOARD_WIDTH));
      else ctx.ui.notify('DeLM board is loading.', 'info');
    },
  });

  pi.registerCommand('delm:board', {
    description: 'DeLM board: show, hide, or open tasks, shared or checks',
    handler: async (args, ctx) => {
      ctxRef = ctx;
      const word = (args || '').trim().toLowerCase();
      const target = run || lastFinished;
      if (!target) { ctx.ui.notify('No DeLM run in this session.', 'info'); return; }
      if (word === 'hide') { target.boardHidden = true; try { ctx.ui.setWidget('delm-board', undefined); } catch { /* no UI */ } return; }
      if (word === 'tasks' || word === 'shared' || word === 'checks') { await showCollection(ctx, word); return; }
      target.boardHidden = false;
      if (target.view) ctx.ui.setWidget('delm-board', renderBoard(target.view, BOARD_WIDTH));
      else ctx.ui.notify('DeLM board is loading.', 'info');
    },
  });

  // Recovery of a run whose session ended before it finished: the bridge is
  // gone, so the controller's tokenless path confirms the host exited and
  // saves the unfinished changes, releasing the project for a new run.
  function unfinishedRuns(project: string): {id: string; status: string}[] {
    const root = join(homedir(), 'Library', 'Application Support', 'DeLM', 'runs');
    if (!existsSync(root)) return [];
    const found: {id: string; status: string}[] = [];
    for (const id of readdirSync(root)) {
      try {
        const saved = JSON.parse(readFileSync(join(root, id, 'claude.json'), 'utf8')) as {host?: string; project?: string; finished?: boolean; status?: string};
        if (saved.host === 'pi' && !saved.finished && saved.project && [project, resolve(project)].includes(saved.project)) {
          found.push({id, status: String(saved.status)});
        }
      } catch { /* not a run record */ }
    }
    return found;
  }

  pi.registerCommand('delm:recover', {
    description: 'Save the changes of an unfinished DeLM run that owns this project',
    handler: async (_args, ctx) => {
      ctxRef = ctx;
      if (run && !run.finished) { ctx.ui.notify('A DeLM run is active here; use /delm:stop first.', 'warning'); return; }
      const stale = unfinishedRuns(ctx.cwd);
      if (!stale.length) { ctx.ui.notify('No unfinished DeLM run owns this project.', 'info'); return; }
      for (const item of stale) {
        await new Promise<void>(done => {
          const child = execFile(runtimeExecutable(), ['pi', 'recover', '--run-id', item.id], {timeout: 120000}, (error, stdout, stderr) => {
            if (error) ctx.ui.notify('DeLM could not recover run ' + item.id.slice(0, 8) + ': ' + String(stderr || error.message).trim().slice(0, 300), 'error');
            else {
              let result: {status?: string; recovery?: {recovery?: string}} = {};
              try { result = JSON.parse(String(stdout).trim().split('\n').at(-1) || '{}'); } catch { /* raw */ }
              ctx.ui.notify('DeLM run ' + item.id.slice(0, 8) + ' recovered: ' + String(result.status || 'done')
                + (result.recovery?.recovery ? '. Saved changes: ' + result.recovery.recovery : ''), 'info');
            }
            done();
          });
          child.stdin?.end('{}\n');
        });
      }
    },
  });

  pi.on('session_start', async (_event, ctx) => {
    ctxRef = ctx;
    if (process.env.DELM_PI_COMMAND) return;   // scripted hosts do not look at private storage
    const stale = unfinishedRuns(ctx.cwd);
    if (stale.length) {
      ctx.ui.notify('An unfinished DeLM run owns this project (' + stale.map(item => item.id.slice(0, 8) + ' ' + item.status).join(', ')
        + '). Run /delm:recover to save its changes before starting another.', 'warning');
    }
  });

  async function forward(text: string) {
    if (!run || run.finished) return;
    const update = updateText(text);
    const result = await control('update', {text: update});
    run.revision = Number(result.revision) || run.revision;
    run.finalization = null;
    status('DeLM: revision ' + run.revision);
    await applyActions((result.actions as Action[]) || []);
  }

  // While a run is working, ordinary text goes to the peers, not to the parent model.
  pi.on('input', async event => {
    if (!run || run.finished || run.finalization || event.source === 'extension') return {action: 'continue'};
    if (event.text.startsWith('/')) return {action: 'continue'};
    try {
      await forward(event.text);
      notify('DeLM forwarded your update to both peers.');
    } catch (error) {
      notify('DeLM could not forward this update: ' + String((error as Error).message || error), 'error');
    }
    return {action: 'handled'};
  });

  pi.on('session_shutdown', async () => {
    if (lastFinished) stopBoard(lastFinished);
    if (run) stopBoard(run);
    if (!run || run.finished) return;
    try { await control('interrupt', {reason: 'Conversation ended'}, 2000); } catch { /* Recovery keeps the work. */ }
    await stopWorkers();
    await cleanup();
  });
}
