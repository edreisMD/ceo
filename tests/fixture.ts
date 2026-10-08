import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { stringify } from 'yaml';
import type { Config, Team } from '../src/contracts.js';
import { git } from '../src/catalog.js';
import { Store } from '../src/store.js';
import { Orca, type Native } from '../src/orca.js';
import { Workflow } from '../src/workflow.js';
import { sha256, reportPath, reportDirectory } from '../src/reports.js';

export const team: Team = { version: 1, id: 'frontend', description: 'Fixture delivery team', steps: [
  { id: 'plan', kind: 'agent', needs: [], role: 'engineering/planner', placement: 'control', contract: 'plan' },
  { id: 'plan-approval', kind: 'decision', needs: ['plan'], gate: 'plan' },
  { id: 'develop', kind: 'agent', needs: ['plan-approval'], role: 'engineering/developer', placement: 'isolated', contract: 'candidate' },
  { id: 'review', kind: 'agent', needs: ['develop'], role: 'engineering/reviewer', placement: 'candidate', contract: 'review' },
  { id: 'qa', kind: 'agent', needs: ['review'], role: 'engineering/qa', placement: 'candidate', contract: 'qa' },
  { id: 'delivery', kind: 'agent', needs: ['review', 'qa'], role: 'engineering/release', placement: 'candidate', contract: 'delivery' },
  { id: 'release-approval', kind: 'decision', needs: ['delivery'], gate: 'release' },
  { id: 'publication-confirmation', kind: 'decision', needs: ['release-approval'], gate: 'publication' },
  { id: 'verify', kind: 'agent', needs: ['publication-confirmation'], role: 'engineering/release', placement: 'control', contract: 'verification' },
] };
export function fixture() {
  const root = mkdtempSync(resolve(tmpdir(), 'ceo-test-')), repo = resolve(root, 'catalog'), source = resolve(root, 'source');
  mkdirSync(repo); mkdirSync(source);
  for (const path of [repo, source]) {
    execFileSync('git', ['init', '-b', 'main', path], { stdio: 'ignore' });
    git(path, 'config', 'user.name', 'Fixture'); git(path, 'config', 'user.email', 'fixture@example.test');
  }
  writeFileSync(resolve(source, 'index.txt'), 'candidate'); git(source, 'add', '.'); git(source, 'commit', '-m', 'Candidate');
  for (const role of ['planner', 'developer', 'reviewer', 'qa', 'release']) {
    const dir = resolve(repo, 'engineering', role); mkdirSync(dir, { recursive: true });
    const agent = { version: 1, id: `engineering-${role}`, workspace: 'project', trigger: { type: 'event', name: `fixture.${role}` }, schedule_paused: true, timeout_seconds: 900, sandbox: role === 'developer' ? 'workspace-write' : 'read-only', session: 'new' };
    writeFileSync(resolve(dir, 'agent.yaml'), stringify(agent));
    const legacy: any = { ...agent, version: 2, paused: true }; delete legacy.schedule_paused;
    writeFileSync(resolve(dir, 'temporal.yaml'), stringify(legacy));
    writeFileSync(resolve(dir, 'SKILL.md'), `---\nname: ${role}\ndescription: Fixture role\n---\nRead actual evidence.\n`);
  }
  mkdirSync(resolve(repo, 'teams/frontend'), { recursive: true });
  writeFileSync(resolve(repo, 'teams/frontend/team.yaml'), stringify(team));
  writeFileSync(resolve(repo, 'governance.yaml'), stringify({ max_roles_per_department: 12, owners: { 'executive-ceo': { editable_departments: ['engineering', 'operations', 'sales'] } } }));
  git(repo, 'add', '.'); git(repo, 'commit', '-m', 'Fixture catalog');
  const revision = git(repo, 'rev-parse', 'HEAD'), home = resolve(root, 'state');
  const config: Config = { version: 1, instance: 'fixture', orca: '/native/orca', stateDir: home, controlWorkspace: source,
    projects: ['website', 'library'].map(id => ({ id, repository: `fixture/${id}`, defaultBranch: 'main', sourcePath: source, controlWorkspace: source, team: 'frontend', enabled: true, catalogPath: repo, catalogRevision: revision, harnesses: { default: 'codex' }, productionUrl: `https://${id}.example.test` })),
    limits: { workers: 3, implementationsPerProject: 1, workflowsPerProject: 1, turnsPerDay: 10, workerStartsPerProjectPerDay: 10 },
    evolution: { enabled: true, catalogPath: repo, trustedRevision: revision, branch: 'ceo/active', remote: 'https://github.com/fixture/company-os', visibility: 'public', editableDepartments: ['engineering', 'operations', 'sales'], maxRolesPerDepartment: 12, experimentsPerProjectPerWeek: 1 } };
  const store = new Store(home), calls: string[][] = [], receipts = new Map<string, Native>(), dispatches = new Map<string, Native>();
  let sequence = 0, bound: string | undefined;
  const transport = async (args: string[]): Promise<Native> => {
    calls.push(args);
    const cmd = args.slice(0, 2).join(' '), flag = (name: string) => args[args.indexOf(name) + 1];
    if (args[0] === 'agent-context') return { schemaVersion: 1, commands: ['run-create','run-use','task-create','task-update','worker-start','worker-release','gate-create','gate-resolve','check','reply','request-show'].map(c => ({ command: `orchestration ${c}`, flags: ['retry-request', 'from', ...(!c.startsWith('gate') ? ['run'] : [])] })) };
    if (cmd === 'orchestration run-current') return { run: bound ? { id: bound } : null };
    if (cmd === 'orchestration run-use') { bound = flag('--id'); return { run: { id: bound } }; }
    if (cmd === 'orchestration request-show') return { state: receipts.has(flag('--request')!) ? 'completed' : 'pending' };
    const request = args.includes('--retry-request') ? flag('--retry-request') : undefined;
    if (request && receipts.has(request)) return receipts.get(request)!;
    let result: Native = {};
    if (cmd === 'orchestration run-create') result = { run: { id: `run_${++sequence}` } };
    if (cmd === 'orchestration task-create') result = { task: { id: `task_${++sequence}` } };
    if (cmd === 'orchestration gate-create') result = { gate: { id: `gate_${++sequence}` } };
    if (cmd === 'orchestration worker-start') {
      const id = `dispatch_${++sequence}`, dispatch = { id, taskId: flag('--task'), runId: flag('--run'), status: 'running' };
      dispatches.set(id, { dispatch, worker: { state: 'running' }, terminalResource: { releaseState: 'active' } }); result = { dispatch };
    }
    if (cmd === 'orchestration worker-show') result = structuredClone(dispatches.get(flag('--dispatch')!) ?? {});
    if (cmd === 'orchestration worker-release') { const d = dispatches.get(flag('--dispatch')!); if (d) d.terminalResource.releaseState = 'released'; result = { released: true }; }
    if (cmd === 'orchestration check') result = { messages: [] };
    if (request) receipts.set(request, result);
    return result;
  };
  const orca = new Orca(store, transport, 'term_ceo'), workflow = new Workflow(config, store, orca, async args => args[1] === 'list' ? [] as unknown as Native : { headRefOid: git(source, 'rev-parse', 'HEAD'), state: 'OPEN', url: 'https://github.com/fixture/website/pull/1', statusCheckRollup: [{ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' }] });
  const complete = async (goalId: string, stepId: string, extra: Native = {}) => {
    const goal = workflow.goal(goalId), step = workflow.team(goal).steps.find(s => s.id === stepId)!, state = store.step(goalId, stepId);
    const native = dispatches.get(state.dispatchId!)!; native.dispatch.status = 'completed'; native.worker.state = 'succeeded'; native.projection = { outcome: 'succeeded' };
    const data: Native = { task_id: state.taskId, outcome: 'succeeded', ...extra };
    if (step.contract === 'plan') {
      const path = resolve(reportDirectory(home, goalId), 'plan.md'); writeFileSync(path, 'Plan with evidence');
      Object.assign(data, { plan_path: path, plan_sha256: sha256(readFileSync(path)), implementation_ready: true, pending_decisions: [] }, extra);
    }
    if (step.contract !== 'plan') data.head_sha ??= git(source, 'rev-parse', 'HEAD');
    writeFileSync(reportPath(home, goalId, stepId), JSON.stringify(data));
    await workflow.settle(goal, step);
  };
  return { root, repo, source, revision, home, config, store, orca, workflow, calls, receipts, dispatches, transport, complete,
    close: () => { store.close(); rmSync(root, { recursive: true, force: true }); } };
}
