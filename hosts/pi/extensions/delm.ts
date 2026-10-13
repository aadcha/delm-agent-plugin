// DeLM for Pi: the parent session's extension. It starts the shared runtime,
// forks the conversation into two private Pi workers, relays their native
// events to the controller, applies the controller's actions, forwards the
// user's updates, and reports the delivered result.
import type {ExtensionAPI, ExtensionContext} from '@earendil-works/pi-coding-agent';
import {SessionManager} from '@earendil-works/pi-coding-agent';
import {mkdirSync, mkdtempSync, readFileSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {PiProcess, type RpcEvent} from '../lib/rpc.ts';
import {TicketServer, bridgeRoot, type TicketRequest, type ReleaseRequest} from '../lib/bridge.ts';
import {request, startBridge, type Action, type Bridge} from '../lib/control.ts';
import {commandOutcome, hostNotes, launchPrompt, turnReason, updateText} from '../lib/protocol.ts';

type Worker = {
  slot: number;
  agentId: string;
  process: PiProcess;
  turn: string | null;
  deliveredRevision: number;
  pendingUpdate: {revision: number; message: string} | null;
  status: 'running' | 'completed' | 'failed' | 'killed';
  stopPromise: Promise<unknown> | null;
};

type Run = {
  sessionId: string;
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
    for (const action of list) {
      if (!run || run.finished) return;
      if (action.id && run.lastAction === action.id) continue;
      try {
        await applyAction(action);
      } catch (error) {
        run.failure = String((error as Error).message || error);
        notify('DeLM: ' + run.failure, 'error');
      }
      if (action.id) run.lastAction = action.id;
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
        notify(delivered ? 'DeLM delivered the result into your project.' : 'DeLM: ' + outcome.replaceAll('_', ' '),
          delivered ? 'info' : 'warning');
        const verification = (action.delivery as {verification_required?: boolean} | undefined)?.verification_required
          ? 'The delivery requires a focused check in the original project. Perform only the necessary environment setup and checks for the delivered or reconciled files, then state the outcome.'
          : 'Do not run another verification pass or edit files.';
        pi.sendUserMessage('DeLM completed its handoff. Report this result concisely, using the original project path. '
          + verification + '\nNative runtime result:\n' + JSON.stringify(action));
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
        case 'agent_start': {
          target.turn = randomUUID();
          await control('step', {agent_id: target.agentId, turn_id: target.turn, revision: target.deliveredRevision});
          return;
        }
        case 'tool_execution_start': {
          if (event.toolName !== 'bash' || !target.turn) return;
          const args = (event.args || {}) as {command?: string};
          await control('command_start', {
            agent_id: target.agentId, turn_id: target.turn, call_id: String(event.toolCallId),
            command: String(args.command ?? ''), cwd: run.bridge.ready.workers[target.slot - 1].cwd,
          });
          return;
        }
        case 'tool_execution_end': {
          if (event.toolName !== 'bash' || !target.turn) return;
          const outcome = commandOutcome(event as {result?: unknown; isError?: boolean});
          await control('command_end', {
            agent_id: target.agentId, call_id: String(event.toolCallId), result_ref: String(event.toolCallId),
            exit_code: outcome.exit_code, is_error: outcome.is_error, interrupted: outcome.interrupted,
            timed_out: outcome.timed_out, background_task_id: null,
          });
          return;
        }
        case 'agent_settled': {
          if (!target.turn) return;
          const turn = target.turn;
          target.turn = null;
          const answer = (await target.process.lastAssistantText().catch(() => null)) || '';
          const reason = turnReason(event as {aborted?: boolean}, !target.process.running);
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

  async function launch(ctx: ExtensionContext, task: string) {
    const executable = runtimeExecutable();
    const sessionId = ctx.sessionManager.getSessionId();
    const parentFile = ctx.sessionManager.getSessionFile();
    const bridge = await startBridge(executable, {
      project: ctx.cwd, session_id: sessionId, task, host_version: null, package_root: PACKAGE_ROOT,
    }, actions => { void applyActions(actions); });
    if (bridge.ready.session_id !== sessionId) throw new Error('DeLM returned workspaces for another conversation.');
    const sessionDir = mkdtempSync(join(tmpdir(), 'delm-pi-sessions-'));
    run = {
      sessionId, task, bridge, revision: bridge.ready.revision, workers: [], tickets: [], finalization: null,
      settling: null, finished: false, final: null, lastAction: null, failure: null, stopRequested: false, sessionDir,
    };
    void bridge.exited.then(() => { if (run && !run.finished) { run.failure = 'DeLM runtime exited.'; status('DeLM: runtime exited'); } });
    const policyFile = join(sessionDir, 'worker-policy.md');
    writeFileSync(policyFile, workerPolicy(), {mode: 0o600});
    const model = ctx.model ? `${(ctx.model as {provider: string}).provider}/${(ctx.model as {id: string}).id}` : null;
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
          deliveredRevision: bridge.ready.revision, pendingUpdate: null, status: 'running', stopPromise: null,
        };
        run.workers.push(target);
        child.onEvent(event => { void onWorkerEvent(target, event); });
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
    const fence = {...run.finalization};
    run.settling = (async () => {
      try {
        const begun = await control('begin_settle', {generation: fence.generation, revision: fence.revision});
        if (run!.stopRequested && (begun.finalization as {intent?: string})?.intent !== 'cancel') {
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
        try { await control('settlement_failed', {generation: fence.generation, revision: fence.revision}); } catch { /* Recovery. */ }
        run!.failure = String((error as Error).message || error);
        notify('DeLM: ' + run!.failure + ' Private workspaces are preserved for recovery.', 'error');
      }
    })();
    try { await run.settling; } finally { if (run) run.settling = null; }
  }

  async function cleanup() {
    if (!run) return;
    for (const tickets of run.tickets) { try { await tickets.close(); } catch { /* Already closed. */ } }
    for (const target of run.workers) { if (target.process.running) void target.process.stop(1000); }
    status(undefined);
    if (run.finished) run = null;
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
        ctx.ui.notify('DeLM could not start: ' + String((error as Error).message || error), 'error');
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

  pi.registerCommand('delm:status', {
    description: 'Show the active DeLM run',
    handler: async (_args, ctx) => {
      ctxRef = ctx;
      if (!run) { ctx.ui.notify('No DeLM run in this session.', 'info'); return; }
      if (run.finished) { ctx.ui.notify('DeLM finished: ' + String(run.final?.status), 'info'); return; }
      try {
        const live = await control('status', {}, 5000);
        const board = live.board as {tasks?: unknown[]} | undefined;
        ctx.ui.notify('DeLM ' + String((live.run as {status?: string})?.status) + ', revision ' + run.revision
          + ', ' + run.workers.filter(w => w.turn).length + ' peers active, '
          + ((board?.tasks as unknown[] | undefined)?.length ?? 0) + ' tasks' + (run.failure ? '. Last error: ' + run.failure : ''), 'info');
      } catch (error) {
        ctx.ui.notify('DeLM status unavailable: ' + String((error as Error).message || error), 'warning');
      }
    },
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
    if (!run || run.finished || run.finalization || event.source !== 'interactive') return {action: 'continue'};
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
    if (!run || run.finished) return;
    try { await control('interrupt', {reason: 'Conversation ended'}, 2000); } catch { /* Recovery keeps the work. */ }
    await stopWorkers();
    await cleanup();
  });
}
