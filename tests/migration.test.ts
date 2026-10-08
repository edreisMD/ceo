import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fixture } from './fixture.js';
import { Store } from '../src/store.js';
import { Workflow } from '../src/workflow.js';
import { Orca } from '../src/orca.js';
import { stageFrontendPilot } from '../src/migration.js';

test('pilot staging preserves plan hash, native tasks and pending decision without writes to Orca', async () => {
  const f = fixture(); let imported: Store | undefined;
  try {
    const goal = f.workflow.createGoal('website', 'Plan analytics');
    await f.workflow.dispatch(goal.id, 'plan'); await f.complete(goal.id, 'plan', { implementation_ready: false, pending_decisions: ['Provider owner'] });
    const current = f.workflow.goal(goal.id), tasks = Object.fromEntries(f.workflow.team(goal).steps.map(step => [step.id, f.store.step(goal.id, step.id).taskId]));
    const plan = f.store.step(goal.id, 'plan'), decision = randomUUID(), legacy = resolve(f.root, 'legacy');
    mkdirSync(resolve(legacy, goal.id), { recursive: true });
    const binding = resolve(legacy, 'binding.json'), state = resolve(legacy, 'active.json');
    writeFileSync(binding, JSON.stringify({ repository: 'fixture/website', run_id: current.runId, coordinator_handle: 'term_old', catalog_commit: f.revision }));
    writeFileSync(state, JSON.stringify({ issue: { id: goal.id, identifier: 'TASK-1', title: 'Plan analytics', description: 'Actual metrics only', url: 'https://issues.example.test/1', createdAt: goal.createdAt }, tasks,
      dispatches: { plan: { dispatchId: plan.dispatchId } }, notices: { 'plan-approval': { id: decision, sha: plan.report!.plan_sha256, createdAt: goal.createdAt } } }));
    writeFileSync(resolve(legacy, goal.id, 'plan.json'), JSON.stringify(plan.report));
    const config = { ...f.config, stateDir: resolve(f.root, 'imported') }; imported = new Store(config.stateDir);
    const workflow = new Workflow(config, imported, new Orca(imported, f.transport, 'read-only'));
    const before = f.calls.filter(c => ['run-create','task-create','worker-start'].includes(c[1]!)).length;
    const staged = await stageFrontendPilot(workflow, 'website', binding, state);
    assert.equal(staged.status, 'paused'); assert.equal(staged.runId, current.runId);
    assert.equal(imported.step(goal.id, 'plan').taskId, tasks.plan);
    assert.equal(imported.step(goal.id, 'plan').report!.plan_sha256, plan.report!.plan_sha256);
    assert.equal(imported.get<any>('decision', decision).status, 'pending');
    assert.equal(f.calls.filter(c => ['run-create','task-create','worker-start'].includes(c[1]!)).length, before);
    await assert.rejects(stageFrontendPilot(workflow, 'website', binding, state), /already staged/);
  } finally { imported?.close(); f.close(); }
});
