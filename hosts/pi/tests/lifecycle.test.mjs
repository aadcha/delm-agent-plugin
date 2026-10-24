// Model-free end-to-end lifecycle: the real parent extension under the real Pi
// CLI in RPC mode, the real DeLM controller and sidecar, and two fake workers.
// Requires `pi` on PATH and a built runtime (target/debug/delm or DELM_PI_RUNTIME).
import assert from 'node:assert/strict';
import test from 'node:test';
import {spawn, execFileSync} from 'node:child_process';
import {existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE = resolve(HERE, '..');
const RUNTIME = process.env.DELM_PI_RUNTIME || resolve(PACKAGE, '../../target/debug/delm');
const FAKE = join(HERE, 'fixtures', 'fake-pi.mjs');

function which(name) {
  try { return execFileSync('/bin/sh', ['-c', 'command -v ' + name], {encoding: 'utf8'}).trim(); } catch { return ''; }
}

const PI = process.env.DELM_TEST_PI || which('pi');
const skip = !PI ? 'pi is not installed' : !existsSync(RUNTIME) ? 'runtime is not built: ' + RUNTIME : false;

function project() {
  const dir = mkdtempSync(join(tmpdir(), 'delm-pi-project-'));
  writeFileSync(join(dir, 'README.md'), '# fixture\n');
  const git = args => execFileSync('git', args, {cwd: dir, stdio: 'pipe'});
  git(['init', '-q']);
  git(['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'add', '.']);
  git(['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'init']);
  return dir;
}

test('two fake Pi workers deliver a result into the original project', {skip, timeout: 180000}, async () => {
  const dir = project();
  // Run records, worker session dirs and the marker all land in one scratch root, not in the user's store.
  const scratch = mkdtempSync(join(tmpdir(), 'delm-pi-scratch-'));
  const mark = join(scratch, 'duplicate.txt');
  const parent = spawn(PI, ['--mode', 'rpc', '--no-session', '--no-extensions',
    '-e', join(PACKAGE, 'extensions', 'delm.ts')], {
    cwd: dir, stdio: ['pipe', 'pipe', 'pipe'],
    env: {...process.env, HOME: scratch, TMPDIR: scratch, DELM_PI_COMMAND: FAKE, DELM_PI_RUNTIME: RUNTIME, DELM_PI_WORKER: '',
      FAKE_PI_SCENARIO: 'deliver', FAKE_PI_MARK: mark},
  });
  let stderr = '';
  parent.stderr.setEncoding('utf8');
  parent.stderr.on('data', chunk => { stderr += chunk; });
  const notices = [];
  let buffer = '';
  const finished = new Promise(resolveDone => {
    parent.stdout.setEncoding('utf8');
    parent.stdout.on('data', chunk => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        let record;
        try { record = JSON.parse(line); } catch { continue; }
        if (record.type === 'extension_ui_request' && record.method === 'notify') {
          notices.push(record.message);
          if (/delivered the result|DeLM: /.test(record.message) && !/forwarded|started two peers/.test(record.message)) resolveDone(record.message);
        }
      }
    });
    parent.once('exit', () => resolveDone('parent exited: ' + stderr.slice(-2000)));
  });
  parent.stdin.write(JSON.stringify({id: 'run', type: 'prompt', message: '/delm:run Create hello.txt containing a greeting.'}) + '\n');
  let timer;
  const outcome = await Promise.race([finished, new Promise(resolveTimeout => { timer = setTimeout(() => resolveTimeout('timeout'), 150000); })]);
  clearTimeout(timer);
  try {
    assert.match(String(outcome), /delivered the result/, 'outcome: ' + outcome + '\nnotices: ' + notices.join(' | ') + '\nstderr: ' + stderr.slice(-3000));
    assert.equal(readFileSync(join(dir, 'hello.txt'), 'utf8'), 'hello from delm\n');
    assert.equal(readFileSync(join(dir, 'README.md'), 'utf8'), '# fixture\n');
    assert.ok(existsSync(mark), 'peer 2 never recorded its launch view; notices: ' + notices.join(' | '));
    const recorded = readFileSync(mark, 'utf8');
    assert.match(recorded, /^tasks_at_start=1\n/, 'peer 2 was prompted only after the first shared task: ' + recorded);
    assert.match(recorded, /already lists your peer's initial task breakdown/, 'peer 2 launch wording');
    assert.match(recorded, /already exists: #1 "Write hello.txt" \((claimed by Agent 1|available)/, 'duplicate task refusal: ' + recorded);
    assert.match(recorded, /continued_turn=ok/, 'a second agent_start within one run must not break the turn: ' + recorded);
  } finally {
    parent.stdin.end();
    await new Promise(resolveExit => { parent.once('exit', resolveExit); setTimeout(() => { parent.kill('SIGKILL'); resolveExit(); }, 10000); });
    rmSync(dir, {recursive: true, force: true});
    rmSync(scratch, {recursive: true, force: true});
  }
});
