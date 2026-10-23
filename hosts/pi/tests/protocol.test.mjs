import assert from 'node:assert/strict';
import test from 'node:test';
import {commandOutcome, coordinationTool, decodeLines, explainModelError, launchPrompt, toolArguments, turnReason, updateText, validateReady}
  from '../lib/protocol.ts';

const ready = {
  type: 'ready', run_id: 'run', session_id: 'session', socket: '/tmp/delm-1/x.sock', token: 'a'.repeat(32),
  executable: '/usr/local/bin/delm', revision: 1, workers: [{slot: 1, cwd: '/w/1'}, {slot: 2, cwd: '/w/2'}],
};

test('ready contract requires two distinct absolute worker directories', () => {
  assert.equal(validateReady(ready).run_id, 'run');
  assert.throws(() => validateReady({...ready, workers: [ready.workers[0], ready.workers[0]]}));
  assert.throws(() => validateReady({...ready, token: 'short'}));
  assert.throws(() => validateReady({...ready, revision: 0}));
  assert.throws(() => validateReady({...ready, type: 'action'}));
});

test('lines decode across chunks and tolerate CRLF', () => {
  const first = decodeLines('', '{"a":1}\r\n{"b":');
  assert.deepEqual(first.events, [{a: 1}]);
  const second = decodeLines(first.rest, '2}\n');
  assert.deepEqual(second.events, [{b: 2}]);
  assert.equal(second.rest, '');
});

test('a forged transport binding is dropped from model arguments', () => {
  assert.deepEqual(toolArguments({summary: 'x', _delm: {socket: '/evil', ticket: 't'}}), {summary: 'x'});
  assert.equal(coordinationTool('mcp__delm__delm_publish'), 'delm_publish');
  assert.equal(coordinationTool('bash'), null);
});

test('bash evidence takes the exit code from structured content only', () => {
  const ok = commandOutcome({result: {content: [{type: 'text', text: 'done'}], structuredContent: {exit_code: 0}}, isError: false});
  assert.equal(ok.exit_code, 0);
  assert.equal(ok.is_error, false);
  const failed = commandOutcome({result: {content: [{type: 'text', text: 'boom\nCommand exited with code 2'}],
    structuredContent: {exit_code: 2}}, isError: true});
  assert.equal(failed.exit_code, 2);
  assert.equal(failed.is_error, true);
  const aborted = commandOutcome({result: {content: [{type: 'text', text: 'Command aborted.'}]}, isError: true});
  assert.equal(aborted.exit_code, null);
  assert.equal(aborted.interrupted, true);
  const timedOut = commandOutcome({result: {content: [{type: 'text', text: 'Command timed out after 30 seconds'}]}, isError: true});
  assert.equal(timedOut.timed_out, true);
});

test('turn reasons distinguish completion, abort and process loss', () => {
  assert.equal(turnReason({aborted: false}, false), 'completed');
  assert.equal(turnReason({aborted: true}, false), 'interrupted');
  assert.equal(turnReason({aborted: false}, true), 'failed');
});

test('updates are bounded and the launch prompt carries the request', () => {
  assert.throws(() => updateText('   '));
  assert.throws(() => updateText('x'.repeat(128 * 1024 + 1)));
  assert.match(updateText('fix it', ['see README']), /Additional context:\nsee README$/);
  assert.match(launchPrompt('Build a thing', 2), /peer 2 of 2[\s\S]*User request:\nBuild a thing$/);
});

test('model refusals are explained with the fix, not the raw API body', () => {
  const quota = explainModelError('400 {"type":"error","error":{"type":"invalid_request_error","message":"You\'re out of extra usage. Add more at claude.ai/settings/usage and keep going."},"request_id":"req_1"}');
  assert.match(quota, /no extra usage left/);
  assert.match(quota, /API key/);
  assert.match(explainModelError('401 {"error":{"message":"invalid x-api-key"}}'), /rejected the login/);
  assert.match(explainModelError('429 rate_limit_error: too many requests'), /rate limiting/);
  assert.match(explainModelError('something odd happened'), /provider returned: something odd happened/);
});
