import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fixture, team } from './fixture.js';
import type { Decision, Operation } from '../src/store.js';
import { Store } from '../src/store.js';
import { Orca } from '../src/orca.js';
import { CoordinatorLoop } from '../src/loop.js';
import { validateTeam } from '../src/contracts.js';
import { founderDecision, readCommand } from '../src/conversation.js';

test('one conversation: another project progresses while the website waits for approval', async () => {
  const f = fixture(); try {
    const website = f.workflow.createGoal('website', 'Maintain the website'), library = f.workflow.createGoal('library', 'Improve the library');
    await f.workflow.dispatch(website.id, 'plan'); await f.complete(website.id, 'plan');
    assert.equal((await f.workflow.advance(website.id)).waiting, 'approval');
    await f.workflow.dispatch(library.id, 'plan'); await f.complete(library.id, 'plan');
    assert.equal((await f.workflow.advance(library.id)).waiting, 'approval');
    assert.equal(f.store.list<Decision>('decision').filter(d => d.status === 'pending').length, 2);
    const decision = f.store.list<Decision>('decision').find(d => d.goalId === library.id)!;
    founderDecision(f.workflow, `approve ${decision.id}`);
    assert.equal((await f.workflow.advance(library.id)).ready, 'develop');
    assert.equal((await f.workflow.advance(website.id)).waiting, 'approval');
    assert.equal(f.calls.filter(c => c[1] === 'run-create').length, 2);
    assert.equal(f.calls.filter(c => c[1] === 'gate-create').length, 2);
  } finally { f.close(); }
});
test('full flow requires independent evidence and exact revision decisions', async () => {
  const f = fixture(); try {
    const goal = f.workflow.createGoal('website', 'Change a link');
    await f.workflow.dispatch(goal.id, 'plan'); await f.complete(goal.id, 'plan'); await f.workflow.advance(goal.id);
    founderDecision(f.workflow, `approve ${f.store.list<Decision>('decision')[0]!.id}`);
    await f.workflow.dispatch(goal.id, 'develop'); await f.complete(goal.id, 'develop', { worktree: f.source });
    await f.workflow.dispatch(goal.id, 'review'); await f.complete(goal.id, 'review', { findings: [] });
    await f.workflow.dispatch(goal.id, 'qa'); await f.complete(goal.id, 'qa', { tests: [{ name: 'Links', passed: true }], preview_url: 'http://localhost:3000', browser_evidence: 'Screenshot checked' });
    await f.workflow.dispatch(goal.id, 'delivery'); await f.complete(goal.id, 'delivery', { pr_url: 'https://github.com/fixture/website/pull/1', checks: [{ name: 'build', passed: true }] });
    assert.equal((await f.workflow.advance(goal.id)).waiting, 'approval');
    const release = f.store.list<Decision>('decision').find(d => d.kind === 'release')!;
    founderDecision(f.workflow, `approve ${release.id}`); await f.workflow.advance(goal.id);
    const publication = f.store.list<Decision>('decision').find(d => d.kind === 'publication')!;
    assert.throws(() => founderDecision(f.workflow, `approve ${publication.id}`), /published/);
    founderDecision(f.workflow, `published ${publication.id}`);
    await f.workflow.dispatch(goal.id, 'verify'); await f.complete(goal.id, 'verify', { production_url: 'https://website.example.test', deployment_evidence: { revision: f.store.step(goal.id, 'develop').report!.head_sha } });
    assert.equal((await f.workflow.advance(goal.id)).completed, true);
    assert.equal(f.workflow.goal(goal.id).status, 'completed');
  } finally { f.close(); }
});
test('native settlement plus invalid report stays blocked; resource release is verified', async () => {
  const f = fixture(); try {
    const goal = f.workflow.createGoal('website', 'Improve'); await f.workflow.dispatch(goal.id, 'plan');
    await f.complete(goal.id, 'plan', { plan_sha256: 'wrong' });
    assert.equal(f.store.step(goal.id, 'plan').status, 'blocked');
    assert.equal((f.store.step(goal.id, 'plan').settlement as any).terminalResource.releaseState, 'released');
    assert.equal((await f.workflow.advance(goal.id)).waiting, 'blocked');
  } finally { f.close(); }
});
test('disconnected or unfinished worker never becomes successful', async () => {
  const f = fixture(); try {
    const goal = f.workflow.createGoal('website', 'Improve'); await f.workflow.dispatch(goal.id, 'plan');
    const state = f.store.step(goal.id, 'plan'); f.dispatches.get(state.dispatchId!)!.worker.state = 'disconnected';
    await f.workflow.settle(goal, team.steps[0]!);
    assert.equal(f.store.step(goal.id, 'plan').status, 'dispatched');
  } finally { f.close(); }
});
test('artifact change invalidates approval eligibility', async () => {
  const f = fixture(); try {
    const goal = f.workflow.createGoal('website', 'Improve'); await f.workflow.dispatch(goal.id, 'plan'); await f.complete(goal.id, 'plan'); await f.workflow.advance(goal.id);
    const decision = f.store.list<Decision>('decision')[0]!;
    writeFileSync(String(f.store.step(goal.id, 'plan').report!.plan_path), 'Different plan');
    assert.throws(() => founderDecision(f.workflow, `approve ${decision.id}`), /hash|SHA|evidence|changed/i);
  } finally { f.close(); }
});
test('crash after native mutation reconciles with original UUID and no duplicate dispatch', async () => {
  const f = fixture(); try {
    const goal = f.workflow.createGoal('website', 'Improve'); await f.workflow.importTasks(goal);
    let fail = true;
    const orca = new Orca(f.store, async args => { const result = await f.transport(args); if (args[1] === 'worker-start' && fail) { fail = false; throw new Error('Lost receipt'); } return result; }, 'term_ceo');
    const args = ['worker-start', '--task', f.store.step(goal.id, 'plan').taskId!];
    await assert.rejects(orca.mutate('fault-dispatch', goal.runId!, ...args), /Lost receipt/);
    await assert.rejects(orca.mutate('fault-dispatch', goal.runId!, ...args), /Reconcile/);
    const op = f.store.list<Operation>('operation').find(o => o.key === 'fault-dispatch')!;
    await orca.reconcileOperation(op.id);
    await orca.mutate('fault-dispatch', goal.runId!, ...args);
    assert.equal(f.dispatches.size, 1);
  } finally { f.close(); }
});
test('single-owner lease survives a second store connection and releases only its token', () => {
  const f = fixture(), other = new Store(f.home); try {
    const release = f.store.claim('portfolio'); assert.throws(() => other.claim('portfolio'), /already owns/);
    release(); const releaseOther = other.claim('portfolio'); release(); assert.throws(() => f.store.claim('portfolio'), /already owns/); releaseOther();
  } finally { other.close(); f.close(); }
});
test('idle queues have zero model calls and changed evidence wakes once', async () => {
  const f = fixture(); try {
    let turns = 0; const loop = new CoordinatorLoop(f.workflow, { run: async () => { turns++; } });
    await loop.tick(); await loop.tick(); assert.equal(turns, 0);
    f.store.emit('decision_required', { id: 'new' }); await loop.tick(); await loop.tick(); assert.equal(turns, 1);
  } finally { f.close(); }
});
test('graph evolution cannot remove required gates or bypass plan approval', () => {
  const changed = structuredClone(team); changed.steps.find(s => s.id === 'develop')!.needs = ['plan'];
  assert.throws(() => validateTeam(changed), /weakened/);
  const removed = structuredClone(team); removed.steps = removed.steps.filter(s => s.id !== 'release-approval');
  assert.throws(() => validateTeam(removed));
});
test('raw tools cannot mutate native runs or impersonate a caller', () => {
  assert.throws(() => readCommand(['orchestration', 'worker-start']));
  assert.throws(() => readCommand(['orchestration', 'run-current', '--from', 'other']));
  assert.deepEqual(readCommand(['orchestration', 'worker-read', '--dispatch', 'dispatch_1']), ['orchestration', 'worker-read', '--dispatch', 'dispatch_1']);
});
test('disabled project and duplicate task intake cannot start another workflow', () => {
  const f = fixture(); try {
    f.config.projects[0]!.enabled = false; assert.throws(() => f.workflow.createGoal('website', 'Improve'), /disabled/);
    f.workflow.createGoal('library', 'Improve'); assert.throws(() => f.workflow.createGoal('library', 'Again'), /existing/);
    assert.equal(f.store.list('goal').length, 1);
  } finally { f.close(); }
});
