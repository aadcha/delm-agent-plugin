import assert from 'node:assert/strict';
import test from 'node:test';
import {agentState, phaseLabel, renderBoard, renderCollection, taskState} from '../lib/board.ts';

const view = {
  status: 'running', finished: false, revision: 2, freshness: {unavailable: []},
  agents: [
    {slot: 1, name: 'Agent 1', native_state: 'working', task_ids: [3], task_count: 1, reported_state: 'working', summary: 'Implementing', dependency: null},
    {slot: 2, name: 'Agent 2', native_state: 'waiting', task_ids: [], task_count: 0, reported_state: 'waiting', summary: null, dependency: 'worker:1'},
  ],
  tasks: {items: [
    {id: 3, task_number: 1, title: 'Implement the parser with a very long title that must be truncated to fit the board width', owner: 1, state: 'claimed', description: 'Parse selected files'},
    {id: 4, task_number: 2, title: 'Write tests', owner: null, state: 'open'},
    {id: 5, task_number: 3, title: 'Old work', owner: 2, state: 'done'},
  ], total: 3},
  shared: {items: [{id: 6, kind: 'publication', worker: 1, title: 'Parser module', imports: [{worker_id: 2}]}], total: 1},
  checks: {items: [{id: 5, worker: 1, summary: 'pytest on parser', passed: true, inputs_unchanged: true, reusable: true}], total: 1},
  outcome: null,
};

test('the compact board mirrors the Claude board: phase, agents, queue, shared context', () => {
  const lines = renderBoard(view, 80);
  assert.equal(lines[0], 'DeLM · Working · revision 2');
  assert.match(lines[1], /^  Agent 1 · Working · #1 Implement the parser/);
  assert.match(lines[2], /^  Agent 2 · Waiting on worker:1$/);
  assert.equal(lines[3], 'Task queue · 3');
  assert.match(lines[4], /^  #1 .*… · Claimed by Agent 1$/);
  assert.match(lines[5], /^  #2 Write tests · Available$/);
  assert.match(lines[6], /^  #3 Old work · Done$/);
  assert.equal(lines[7], 'Shared context · 1 · 1 checks');
  assert.equal(lines[8], '  Parser module · Agent 1 · Imported by Agent 2');
  assert.match(lines.at(-1), /\/delm:board/);
  for (const line of lines) assert.ok(Array.from(line).length <= 80, line);
});

test('phases and outcomes use the Claude labels', () => {
  assert.equal(phaseLabel({...view, status: 'awaiting_shutdown'}), 'Finishing');
  assert.equal(phaseLabel({...view, status: 'delivered', outcome: {status: 'delivered', verification_required: true}}), 'Changes applied · check needed');
  assert.equal(phaseLabel({...view, status: 'stopped', outcome: {recovery_saved: true}}), 'Stopped · changes saved');
  assert.equal(phaseLabel({...view, status: 'what'}), 'Status unavailable');
  const done = renderBoard({...view, status: 'complete', finished: true, outcome: {status: 'complete', delivered: true, changed_paths_count: 2}}, 80);
  assert.ok(done.some(line => line.includes('Changes applied to your project · 2 files.')));
});

test('agent and task states read like the Claude board', () => {
  assert.equal(agentState({slot: 1, name: 'Agent 1', native_state: 'ready'}), 'Ready');
  assert.equal(agentState({slot: 1, name: 'Agent 1', native_state: 'working', reported_state: 'blocked'}), 'Needs attention');
  assert.equal(taskState(view.tasks.items[0], view), 'Claimed by Agent 1');
  assert.equal(taskState(view.tasks.items[2], view), 'Done');
});

test('detail views list whole collections with provenance', () => {
  const tasks = renderCollection(view, 'tasks', 80);
  assert.equal(tasks[0], 'All tasks · 3');
  assert.ok(tasks.some(line => line.includes('Parse selected files')));
  const shared = renderCollection(view, 'shared', 80);
  assert.ok(shared.some(line => line.includes('Code shared · Imported by Agent 2')));
  const checks = renderCollection(view, 'checks', 80);
  assert.ok(checks.some(line => line.includes('Agent 1 · Recorded pass')));
  assert.equal(checks.at(-1), 'Esc or q to close');
});
