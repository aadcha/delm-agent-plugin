// Host-neutral helpers shared by the parent extension, the worker extension
// and the tests. Nothing here talks to Pi or to the runtime.

export const TOOL_PREFIX = 'mcp__delm__';
export const MCP_SERVER_NAME = 'delm';

export type Ready = {
  type: 'ready';
  run_id: string;
  session_id: string;
  socket: string;
  token: string;
  executable: string;
  revision: number;
  workers: {slot: number; cwd: string}[];
  [key: string]: unknown;
};

export function decodeLines(buffer: string, chunk: string): {rest: string; events: Record<string, unknown>[]} {
  const combined = buffer + chunk;
  if (combined.length > 2 * 1024 * 1024) throw new Error('DeLM exceeded its event size limit.');
  const lines = combined.split('\n');
  const rest = lines.pop() ?? '';
  return {rest, events: lines.filter(line => line.trim()).map(line => JSON.parse(line.endsWith('\r') ? line.slice(0, -1) : line))};
}

export function validateReady(value: Record<string, unknown>): Ready {
  const workers = value.workers as {slot?: number; cwd?: string}[] | undefined;
  if (!value || value.type !== 'ready' || typeof value.run_id !== 'string'
      || typeof value.socket !== 'string' || !value.socket.startsWith('/')
      || typeof value.token !== 'string' || value.token.length < 16
      || typeof value.executable !== 'string' || !value.executable.startsWith('/')
      || !Array.isArray(workers) || workers.length !== 2
      || workers.some((worker, index) => worker?.slot !== index + 1
        || typeof worker.cwd !== 'string' || !worker.cwd.startsWith('/'))
      || workers[0].cwd === workers[1].cwd
      || !Number.isSafeInteger(value.revision) || (value.revision as number) < 1) {
    throw new Error('DeLM returned an invalid native launch contract.');
  }
  return value as Ready;
}

// Arguments the model supplied, without any transport binding it may have
// tried to forge. The binding is added by the worker extension afterwards.
export function toolArguments(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([key]) => key !== '_delm'));
}

export function coordinationTool(toolName: string): string | null {
  return toolName.startsWith(TOOL_PREFIX) ? toolName.slice(TOOL_PREFIX.length) : null;
}

// Pi's bash tool reports the shell's exit status in structuredContent; a
// thrown abort or timeout produces an error result without one. Only an
// observed exit status becomes native process evidence.
export function commandOutcome(event: {result?: unknown; isError?: boolean}): {
  result_ref: string | null; exit_code: number | null; is_error: boolean; interrupted: boolean; timed_out: boolean;
  background_task_id: null;
} {
  const result = (event.result && typeof event.result === 'object' ? event.result : {}) as Record<string, unknown>;
  const structured = (result.structuredContent && typeof result.structuredContent === 'object'
    ? result.structuredContent : {}) as Record<string, unknown>;
  const exit = structured.exit_code;
  const text = Array.isArray(result.content)
    ? (result.content as {type?: string; text?: string}[]).filter(item => item.type === 'text').map(item => item.text || '').join('\n') : '';
  const aborted = /^Command aborted\.?$/m.test(text);
  const timedOut = /^Command timed out after /m.test(text);
  return {
    result_ref: null,
    exit_code: Number.isSafeInteger(exit) ? exit as number : null,
    is_error: Boolean(event.isError),
    interrupted: aborted,
    timed_out: timedOut,
    background_task_id: null,
  };
}

export function turnReason(settled: {aborted?: boolean}, exited: boolean): 'completed' | 'interrupted' | 'failed' {
  if (exited) return 'failed';
  return settled.aborted ? 'interrupted' : 'completed';
}

// The task text a worker receives as its first prompt. The collaboration
// policy itself is appended to the system prompt, not repeated here.
export function launchPrompt(task: string, slot: number): string {
  return 'DeLM request for peer ' + slot + ' of 2. Follow the DeLM worker policy in your system prompt and begin useful work through the shared board now.\n\nUser request:\n' + task;
}

export function hostNotes(): string {
  return [
    'Pi host instructions for DeLM:',
    '- The shared board tools are named ' + TOOL_PREFIX + '<tool>, for example ' + TOOL_PREFIX + 'delm_publish. The policy refers to them by the short name.',
    '- Run checks through the bash tool. Each bash call\'s tool call id is its native command id; recent_commands in board responses lists the ids the runtime observed.',
    '- Never supply the _delm field on a board tool; the host binds it.',
    '- After calling delm_complete, finish your reply and end the turn. The runtime resumes you when shared work changes or when the user updates the request.',
    '- Work only inside your current working directory, which is your private copy of the project.',
  ].join('\n');
}

export function updateText(text: string, extra: string[] = []): string {
  const context = extra.filter(Boolean);
  const combined = text + (context.length ? '\n\nAdditional context:\n' + context.join('\n\n') : '');
  let bytes = 0;
  for (const character of combined) {
    const point = character.codePointAt(0)!;
    bytes += point < 0x80 ? 1 : point < 0x800 ? 2 : point < 0x10000 ? 3 : 4;
  }
  if (!combined.trim() || bytes > 128 * 1024) {
    throw new Error('DeLM needs a nonempty update of at most 128 KiB. This update was not sent; shorten it and retry.');
  }
  return combined;
}

export function completeState(status: string): boolean {
  return ['completed', 'failed', 'killed', 'finished'].includes(status);
}

// Provider refusals come back as raw API JSON. Name the cause and the fix in
// one sentence; the raw text stays available in the worker log.
export function explainModelError(raw: string): string {
  let message = raw;
  const json = raw.match(/\{[\s\S]*\}/);
  if (json) {
    try {
      const parsed = JSON.parse(json[0]) as {error?: {message?: string; type?: string}; message?: string};
      message = parsed.error?.message || parsed.message || raw;
    } catch { /* not JSON */ }
  }
  const text = message.trim().replace(/\s+/g, ' ');
  const whole = raw.replace(/\s+/g, ' ');
  if (/out of extra usage/i.test(whole)) {
    return 'Your Anthropic subscription login has no extra usage left, and Pi bills third-party harness use against extra usage. '
      + 'Add extra usage at claude.ai/settings/usage, or run /login in Pi and sign in with an API key instead.';
  }
  if (/\b401\b|authentication|invalid[ -_]?(x-)?api[ -_]?key|unauthorized|token expired|not logged in/i.test(whole)) {
    return 'The provider rejected the login (' + text.slice(0, 160) + '). Run /login in Pi to refresh it.';
  }
  if (/\b429\b|rate[ _]limit|overloaded|\b529\b/i.test(whole)) {
    return 'The provider is rate limiting or overloaded (' + text.slice(0, 160) + '). Wait a minute and run /delm:run again.';
  }
  if (/model not found|does not exist|unsupported model|\b404\b/i.test(whole)) {
    return 'The provider does not offer this session\'s model to the workers (' + text.slice(0, 160) + '). Pick another model with /model and run /delm:run again.';
  }
  return 'The provider returned: ' + text.slice(0, 300);
}
