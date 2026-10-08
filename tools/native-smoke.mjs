#!/usr/bin/env node
// Run ONLY in a dedicated Orca terminal. This checks native launch/lifecycle
// support with configured harnesses, never product work or publication.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const [executable, directory, ...harnesses] = process.argv.slice(2);
const caller = process.env.ORCA_TERMINAL_HANDLE || process.env.ORCA_AGENT_SESSION_ID;
if (!caller || !executable || !directory || harnesses.length !== 2) throw new Error('Run in its own Orca terminal: native-smoke.mjs /path/to/orca /private/evidence-dir codex claude');
mkdirSync(directory, { recursive: true, mode: 0o700 });
const execute = promisify(execFile), evidence = { caller, requests: [], workers: [], startedAt: new Date().toISOString(), status: 'running' };
const save = () => writeFileSync(resolve(directory, 'receipt.json'), JSON.stringify(evidence, null, 2), { mode: 0o600 });
const call = async (...args) => {
  const { stdout } = await execute(executable, [...args, '--json'], { timeout: 45000, maxBuffer: 8 * 1024 * 1024 });
  const receipt = JSON.parse(stdout); if (receipt.ok === false) throw new Error(JSON.stringify(receipt.error));
  return receipt.result ?? receipt;
};
const mutation = async (...args) => {
  const request = { args, requestId: randomUUID(), state: 'unknown' }; evidence.requests.push(request); save();
  const result = await call(...args, '--retry-request', request.requestId);
  Object.assign(request, { state: 'done', receipt: result }); save(); return result;
};
save();
try {
  const run = await mutation('orchestration', 'run-create', '--objective', 'ceo bounded native lifecycle compatibility smoke; no product changes', '--from', caller);
  evidence.run = run.run.id;
  await call('orchestration', 'run-use', '--id', evidence.run, '--from', caller);
  for (const harness of harnesses) {
    const report = resolve(directory, `${harness}.json`);
    const task = await mutation('orchestration', 'task-create', '--run', evidence.run, '--from', caller, '--task-title', `ceo ${harness} compatibility smoke`, '--spec',
      `Bounded compatibility smoke. Do not edit product files, install anything, merge, deploy, change credentials or call paid training/providers. Read your live Orca worker preamble. Write ${report} as JSON with your assigned task_id, outcome="succeeded", evidence="Native lifecycle smoke; no product edits". Send one heartbeat using the native preamble. Then send worker_done exactly once using that preamble after the report exists and end the turn. This is the entire assignment.`);
    const started = await mutation('orchestration', 'worker-start', '--task', task.task.id, '--worktree', 'current', '--agent', harness, '--run', evidence.run, '--from', caller, '--timeout-ms', '30000');
    evidence.workers.push({ harness, task: task.task.id, dispatch: started.dispatch?.id ?? started.dispatchId, report }); save();
  }
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    let complete = true;
    for (const worker of evidence.workers) {
      const native = await call('orchestration', 'worker-show', '--dispatch', worker.dispatch);
      worker.native = native; save();
      if (native.dispatch?.status === 'failed') throw new Error(`${worker.harness} failed; retain native evidence`);
      if (native.dispatch?.status !== 'completed') { complete = false; continue; }
      if (native.projection?.outcome !== 'succeeded' || native.dispatch.taskId !== worker.task) throw new Error('Native evidence mismatch');
      const report = JSON.parse(readFileSync(worker.report, 'utf8'));
      if (report.task_id !== worker.task || report.outcome !== 'succeeded') throw new Error('Worker report mismatch');
      if (native.terminalResource?.releaseState !== 'released') {
        await mutation('orchestration', 'worker-release', '--dispatch', worker.dispatch, '--run', evidence.run, '--from', caller);
        worker.native = await call('orchestration', 'worker-show', '--dispatch', worker.dispatch); save();
        if (worker.native.terminalResource?.releaseState !== 'released') { complete = false; continue; }
      }
    }
    if (complete) {
      evidence.messages = await call('orchestration', 'check', '--terminal', caller, '--run', evidence.run);
      if (evidence.messages.deliveryId) await mutation('orchestration', 'check', '--terminal', caller, '--run', evidence.run, '--ack', evidence.messages.deliveryId);
      evidence.status = 'passed'; save(); console.log('Two-harness native smoke passed. Private receipt:', resolve(directory, 'receipt.json')); process.exit(0);
    }
    await new Promise(done => setTimeout(done, 5000));
  }
  throw new Error('Bounded smoke timed out; unfinished workers remain unresolved, not successful');
} catch (error) { evidence.status = 'blocked'; evidence.error = String(error); save(); console.error(evidence.error); process.exitCode = 1; }
