import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Config, Project, Step, Team } from './contracts.js';
import { Catalog } from './catalog.js';
import { Orca, type Native } from './orca.js';
import { Store, type Decision, type Goal, type StepState } from './store.js';
import { candidateHead, readReport, reportDirectory, reportPath, sha256 } from './reports.js';

export class Workflow {
  constructor(readonly config: Config, readonly store: Store, readonly orca: Orca,
    readonly github: (args: string[]) => Promise<Native> = async args => JSON.parse((await promisify(execFile)('gh', args, { timeout: 30000 })).stdout)) {}
  project(id: string): Project {
    const project = this.config.projects.find(p => p.id === id);
    if (!project?.enabled) throw new Error('Project is missing or disabled');
    return project;
  }
  createGoal(projectId: string, objective: string, source?: Goal['source']): Goal {
    const project = this.project(projectId);
    if (!objective.trim() || objective.length > 16384) throw new Error('Goal must be a bounded objective');
    const old = this.store.list<Goal>('goal');
    if (source && old.some(g => g.status !== 'abandoned' && g.source?.id === source.id && g.source.kind === source.kind)) throw new Error('Source task already imported');
    if (old.some(g => g.project === project.id && (g.status === 'active' || g.status === 'paused'))) throw new Error('Reconcile the existing project workflow first');
    const active = this.store.get<{ revision: string }>('catalog', project.id)?.revision ?? project.catalogRevision;
    const catalog = new Catalog(project.catalogPath, active);
    const team = catalog.team(project.team);
    const goal: Goal = { id: randomUUID(), project: project.id, objective, status: 'active', catalogRevision: active, team, source, createdAt: new Date().toISOString() };
    this.store.transaction(() => { this.store.put('goal', goal); this.store.emit('goal_created', { objective, project: project.id }, goal.id); });
    mkdirSync(reportDirectory(this.config.stateDir, goal.id), { recursive: true, mode: 0o700 });
    return goal;
  }
  goal(id: string): Goal { const goal = this.store.get<Goal>('goal', id); if (!goal) throw new Error('Unknown goal'); return goal; }
  team(goal: Goal): Team { return goal.team as Team; }
  async ensureRun(goal: Goal): Promise<string> {
    if (goal.runId) return goal.runId;
    const result = await this.orca.serial(() => this.orca.effect(`run:${goal.id}`, ['orchestration', 'run-create', '--objective', `[${goal.project}] ${goal.objective}`, '--from', this.orca.caller]));
    if (!result.run?.id) throw new Error('Native run creation has no Run id');
    goal.runId = result.run.id;
    this.store.put('goal', goal);
    return goal.runId!;
  }
  spec(goal: Goal, step: Step): string {
    const project = this.project(goal.project);
    const catalog = new Catalog(project.catalogPath, goal.catalogRevision);
    const snapshot = catalog.materialize(this.config.stateDir);
    const predecessors = step.needs.map(id => this.store.step(goal.id, id));
    return JSON.stringify({ protocol: 'ceo/1', goal_id: goal.id, project: project.id, step: step.id,
      target: project.sourcePath, objective: goal.objective, role: step.role,
      skill: step.role ? `${snapshot}/${step.role}/SKILL.md` : undefined, catalog_revision: goal.catalogRevision,
      inputs: predecessors.map(s => ({ step: s.stepId, task: s.taskId, report: s.report })),
      report_path: reportPath(this.config.stateDir, goal.id, step.id), artifact_directory: reportDirectory(this.config.stateDir, goal.id),
      contract: step.contract, constraints: [
        'Read the target repository AGENTS.md and the full pinned role skill; use its local gstack references as instructed.',
        'Do only this assignment. Use your live Orca preamble for messages, heartbeats, questions and exactly one worker_done.',
        'No approval comments, default/prod branch pushes, merges, deployment, credential changes, paid provider calls or training.',
        'Implementation owns only its isolated worktree. Reviewer and QA must not modify candidate files.',
        'Use actual evidence; missing metrics are unknown. Reports and project context stay private.',
        'Write the structured report before worker_done. Include task_id from the live preamble and outcome=succeeded only when proven.',
        `Required report contract: ${step.contract}. Plan: plan_path, plan_sha256, implementation_ready boolean, pending_decisions array. Candidate: worktree, head_sha. Review: head_sha, findings array (empty to pass). QA: head_sha, tests [{name,passed}], preview_url, browser_evidence. Delivery: head_sha, pr_url, checks. Verification: head_sha, production_url, deployment_evidence.`,
      ], acceptance: 'Native successful settlement plus independently validated required report and exact revision evidence.' });
  }
  async importTasks(goal: Goal): Promise<void> {
    const run = await this.ensureRun(goal);
    for (const step of this.team(goal).steps) {
      const state = this.store.step(goal.id, step.id);
      if (state.taskId) continue;
      const deps = step.needs.map(id => this.store.step(goal.id, id).taskId);
      if (deps.some(x => !x)) throw new Error('Dependency import is incomplete');
      const spec = step.kind === 'agent' ? this.spec(goal, step) : JSON.stringify({ protocol: 'ceo/1', goal_id: goal.id, step: step.id, gate: step.gate });
      const result = await this.orca.mutate(`task:${goal.id}:${step.id}`, run, 'task-create', '--spec', spec,
        '--task-title', `[${goal.project}] ${step.id}`, '--deps', JSON.stringify(deps));
      if (!result.task?.id) throw new Error('Native task creation has no task id');
      this.store.saveStep({ ...state, taskId: result.task.id });
    }
  }
  agentReport(goal: Goal, contract: string): StepState {
    const step = this.team(goal).steps.find(s => s.contract === contract);
    if (!step) throw new Error(`Missing contract ${contract}`);
    const state = this.store.step(goal.id, step.id);
    if (state.status !== 'completed' || !state.report || !state.taskId) throw new Error(`Missing completed ${contract}`);
    const report = readReport(this.config.stateDir, goal.id, step, state.taskId);
    if (JSON.stringify(report) !== JSON.stringify(state.report)) throw new Error('Evidence changed after settlement');
    return { ...state, report };
  }
  artifact(goal: Goal, gate: string): { hash: string; summary: string } {
    if (gate === 'plan') {
      const report = this.agentReport(goal, 'plan').report!;
      return { hash: String(report.plan_sha256), summary: readFileSync(String(report.plan_path), 'utf8') };
    }
    const candidate = this.agentReport(goal, 'candidate').report!;
    const head = candidateHead(String(candidate.worktree));
    if (head !== candidate.head_sha) throw new Error('Candidate changed after implementation');
    const delivery = this.agentReport(goal, 'delivery').report!;
    for (const contract of ['review', 'qa', 'delivery']) if (this.agentReport(goal, contract).report!.head_sha !== head) throw new Error('Evidence does not match candidate');
    return { hash: head, summary: JSON.stringify({ revision: head, ...delivery }, null, 2) };
  }
  approved(goal: Goal, gate: string): Decision {
    const artifact = this.artifact(goal, gate);
    const decision = this.store.list<Decision>('decision').find(d => d.goalId === goal.id && d.kind === gate && d.status === 'approved' && d.artifact === artifact.hash);
    if (!decision) throw new Error(`Exact ${gate} approval is required`);
    return decision;
  }
  async decision(goal: Goal, step: Step): Promise<Decision> {
    const artifact = this.artifact(goal, step.gate!);
    const decisions = this.store.list<Decision>('decision').filter(d => d.goalId === goal.id && d.stepId === step.id);
    for (const prior of decisions) if (prior.artifact !== artifact.hash && prior.status !== 'invalidated') this.store.put('decision', { ...prior, status: 'invalidated' as const });
    const existing = decisions.find(d => d.artifact === artifact.hash && d.status !== 'invalidated');
    const value: Decision = existing ?? { id: randomUUID(), goalId: goal.id, stepId: step.id, kind: step.gate!, artifact: artifact.hash,
      summary: artifact.summary, status: 'pending', createdAt: new Date().toISOString() };
    if (!existing) this.store.transaction(() => { this.store.put('decision', value); this.store.emit('decision_required', value, goal.id); });
    if (!value.nativeGate) {
      const result = await this.orca.mutate(`gate:${goal.id}:${value.id}`, goal.runId!, 'gate-create', '--task', this.store.step(goal.id, step.id).taskId!,
        '--question', `ceo decision ${value.id}: ${value.kind}. Artifact ${value.artifact}. Respond in the ceo conversation.`, '--options', JSON.stringify(['approve', 'reject']));
      if (!result.gate?.id) throw new Error('Native gate creation has no gate id');
      value.nativeGate = result.gate.id; this.store.put('decision', value);
    }
    return value;
  }
  async advance(goalId: string): Promise<{ ready?: string; waiting?: string; completed?: boolean }> {
    const goal = this.goal(goalId);
    if (goal.status !== 'active') return { waiting: goal.status };
    this.project(goal.project);
    if (this.store.list<any>('operation').some(op => op.state === 'unknown' && op.key.includes(goal.id))) return { waiting: 'reconciliation' };
    await this.importTasks(goal);
    for (const step of this.team(goal).steps) {
      const state = this.store.step(goal.id, step.id);
      if (state.status === 'completed') continue;
      if (['dispatched', 'failed', 'blocked'].includes(state.status)) return { waiting: state.status };
      if (!step.needs.every(id => this.store.step(goal.id, id).status === 'completed')) continue;
      if (step.kind === 'decision') {
        const decision = await this.decision(goal, step);
        if (decision.status === 'approved' || decision.status === 'rejected') await this.orca.mutate(`gate-resolve:${decision.id}`, goal.runId!, 'gate-resolve', '--id', decision.nativeGate!, '--resolution', JSON.stringify({ status: decision.status, artifact: decision.artifact, response: decision.response }));
        if (step.gate === 'plan' && this.agentReport(goal, 'plan').report!.implementation_ready !== true) return { waiting: 'plan_prerequisites' };
        if (decision.status !== 'approved') return { waiting: decision.status === 'rejected' ? 'changes_requested' : 'approval' };
        await this.orca.mutate(`gate-complete:${decision.id}`, goal.runId!, 'task-update', '--id', state.taskId!, '--status', 'completed', '--result', JSON.stringify({ decision: decision.id, artifact: decision.artifact }));
        this.store.saveStep({ ...state, status: 'completed' });
        return this.advance(goal.id);
      }
      this.store.saveStep({ ...state, status: 'ready' });
      return { ready: step.id };
    }
    this.approved(goal, 'release'); this.approved(goal, 'publication');
    const verified = this.agentReport(goal, 'verification').report!;
    if (verified.head_sha !== this.artifact(goal, 'publication').hash || verified.production_url !== this.project(goal.project).productionUrl) throw new Error('Production verification differs from approved deployment');
    this.store.put('goal', { ...goal, status: 'completed' as const });
    this.store.emit('goal_completed', { objective: goal.objective, evidence: verified }, goal.id);
    return { completed: true };
  }
  async dispatch(goalId: string, stepId: string): Promise<Native> {
    let goal = this.goal(goalId);
    const project = this.project(goal.project);
    if ((await this.advance(goalId)).ready !== stepId) throw new Error('Step is not eligible');
    goal = this.goal(goalId); // Run import may have persisted a new binding.
    const step = this.team(goal).steps.find(s => s.id === stepId)!;
    const state = this.store.step(goalId, stepId);
    if (state.dispatchId) throw new Error('An attempt already exists; reconcile before retry');
    const live = this.store.list<StepState>('step').filter(s => s.status === 'dispatched' || (s.settlement && (s.settlement as Native).terminalResource?.releaseState !== 'released'));
    if (live.length >= this.config.limits.workers) throw new Error('Portfolio worker limit reached');
    const counter = `starts:${goal.project}:${new Date().toISOString().slice(0, 10)}`;
    if (this.store.count(counter) >= this.config.limits.workerStartsPerProjectPerDay) throw new Error('Daily worker-start budget reached');
    const catalog = new Catalog(project.catalogPath, goal.catalogRevision);
    const { agent } = catalog.role(step.role!);
    if (['review', 'qa', 'verification'].includes(step.contract!) && agent.sandbox !== 'read-only') throw new Error('Review/QA roles must be read-only');
    const harness = project.harnesses[step.role!] ?? project.harnesses.default;
    if (!harness) throw new Error('Role has no configured harness');
    let placement = ['--worktree', project.controlWorkspace];
    if (step.placement === 'isolated') {
      this.approved(goal, 'plan');
      if (this.agentReport(goal, 'plan').report!.implementation_ready !== true) throw new Error('Plan prerequisites remain unresolved');
      const prs = await this.github(['pr', 'list', '--repo', project.repository, '--state', 'open', '--json', 'number,headRefName']);
      if ((prs as unknown as Native[]).some(pr => /(?:^|\/)(?:ceo\/|ceo-)/.test(String(pr.headRefName ?? '')))) throw new Error('Project already has a ceo implementation PR');
      placement = ['--worktree', 'new-top-level', '--repo', project.repository, '--base-branch', project.defaultBranch, '--name', `ceo-${goal.id.slice(0, 8)}`, '--setup', 'skip'];
    } else if (step.placement === 'candidate') {
      const candidate = this.agentReport(goal, 'candidate').report!;
      if (candidateHead(String(candidate.worktree)) !== candidate.head_sha) throw new Error('Candidate changed');
      placement = ['--worktree', String(candidate.worktree)];
      if (step.contract === 'delivery') for (const contract of ['review', 'qa']) if (this.agentReport(goal, contract).report!.head_sha !== candidate.head_sha) throw new Error('Review and QA differ from candidate');
    } else if (step.contract === 'verification') this.approved(goal, 'publication');
    const result = await this.orca.mutate(`dispatch:${goal.id}:${step.id}`, goal.runId!, 'worker-start', '--task', state.taskId!, '--agent', harness, '--timeout-ms', '30000', ...placement);
    const dispatchId = result.dispatch?.id ?? result.dispatchId;
    if (!dispatchId) throw new Error('Worker start has no authoritative Dispatch id');
    this.store.saveStep({ ...state, dispatchId, status: 'dispatched' });
    this.store.increment(counter);
    this.store.emit('worker_started', { step: step.id, dispatchId, harness }, goal.id);
    return result;
  }
  async settle(goal: Goal, step: Step): Promise<void> {
    goal = this.goal(goal.id);
    const state = this.store.step(goal.id, step.id);
    if (!state.dispatchId) return;
    const native = await this.orca.read('orchestration', 'worker-show', '--dispatch', state.dispatchId);
    const dispatch = native.dispatch;
    if (!dispatch || dispatch.id !== state.dispatchId || dispatch.taskId !== state.taskId || dispatch.runId !== goal.runId) throw new Error('Worker identity mismatch');
    if (!['completed', 'failed'].includes(dispatch.status)) return;
    if (dispatch.status === 'completed' && native.projection?.outcome !== 'succeeded' && native.worker?.state !== 'succeeded') throw new Error('Native settlement lacks a successful outcome');
    if (dispatch.status === 'failed') {
      this.store.saveStep({ ...state, status: 'failed', settlement: native });
      this.store.emit('worker_failed', { step: step.id, dispatchId: state.dispatchId }, goal.id, `settled:${state.dispatchId}`);
    } else {
      let report: Record<string, any>;
      try {
        report = readReport(this.config.stateDir, goal.id, step, state.taskId!);
        if (step.contract === 'candidate' && candidateHead(report.worktree) !== report.head_sha) throw new Error('Candidate evidence mismatch');
        if (['review', 'qa', 'delivery', 'verification'].includes(step.contract!)) {
          const candidate = this.agentReport(goal, 'candidate').report!;
          if (report.head_sha !== candidate.head_sha || candidateHead(String(candidate.worktree)) !== candidate.head_sha) throw new Error('Worker evidence differs from candidate');
        }
        if (step.contract === 'delivery') {
          const repository = this.project(goal.project).repository;
          const match = String(report.pr_url).match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)$/);
          if (!match || match[1] !== repository) throw new Error('Delivery PR belongs to another repository');
          const pr = await this.github(['pr', 'view', match[2]!, '--repo', repository, '--json', 'headRefOid,statusCheckRollup,state,url']);
          if (pr.headRefOid !== report.head_sha || pr.state !== 'OPEN' || pr.url !== report.pr_url) throw new Error('Native PR differs from candidate');
          const checks = pr.statusCheckRollup;
          if (!Array.isArray(checks) || !checks.length || checks.some(c => c.__typename === 'CheckRun' ? c.status !== 'COMPLETED' || !['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(c.conclusion) : c.state !== 'SUCCESS')) throw new Error('Native PR checks are not complete and passing');
          native.ceo_checks = checks;
        }
      } catch (error) {
        this.store.saveStep({ ...state, status: 'blocked', settlement: native });
        this.store.emit('evidence_failed', { step: step.id, reason: String(error) }, goal.id, `evidence:${state.dispatchId}`);
        await this.releaseWorker(goal, step);
        return;
      }
      this.store.saveStep({ ...state, status: 'completed', report, evidence: sha256(JSON.stringify(report)), settlement: native });
      this.store.emit('worker_completed', { step: step.id, report }, goal.id, `settled:${state.dispatchId}`);
    }
    await this.releaseWorker(goal, step);
  }
  async releaseWorker(goal: Goal, step: Step): Promise<void> {
    const state = this.store.step(goal.id, step.id);
    const native = state.settlement as Native | undefined;
    if (!state.dispatchId || !native || native.terminalResource?.releaseState === 'released') return;
    await this.orca.mutate(`release:${state.dispatchId}`, goal.runId!, 'worker-release', '--dispatch', state.dispatchId);
    const verified = await this.orca.read('orchestration', 'worker-show', '--dispatch', state.dispatchId);
    if (verified.dispatch?.id !== state.dispatchId) throw new Error('Released worker identity mismatch');
    this.store.saveStep({ ...state, settlement: verified });
  }
  resolveDecision(id: string, action: 'approve' | 'reject' | 'published', response: string): Decision {
    const decision = this.store.get<Decision>('decision', id);
    if (!decision || decision.status !== 'pending') throw new Error('Decision is absent or already resolved');
    const goal = this.goal(decision.goalId);
    if (goal.status !== 'active') throw new Error('Goal is not active');
    if (action !== 'reject' && (decision.kind === 'publication') !== (action === 'published')) throw new Error('Use published only after the operator has published the candidate');
    if (this.artifact(goal, decision.kind).hash !== decision.artifact) throw new Error('Decision artifact changed');
    if (decision.kind === 'plan' && action === 'approve' && this.agentReport(goal, 'plan').report!.implementation_ready !== true) throw new Error('Resolve plan prerequisites and replan before approval');
    const result = { ...decision, status: action === 'reject' ? 'rejected' as const : 'approved' as const, response };
    this.store.transaction(() => { this.store.put('decision', result); this.store.emit('decision_resolved', result, goal.id); });
    return result;
  }
  feedback(goalId: string, text: string): void {
    const goal = this.goal(goalId);
    this.store.transaction(() => {
      for (const decision of this.store.list<Decision>('decision').filter(d => d.goalId === goalId && d.status !== 'invalidated')) this.store.put('decision', { ...decision, status: 'invalidated' as const });
      this.store.put('goal', { ...goal, status: 'paused' as const });
      this.store.emit('feedback', { text, next: 'Reconcile existing workers, then explicitly replan' }, goalId);
    });
  }
  async replan(goalId: string, objective: string): Promise<Goal> {
    const goal = this.goal(goalId);
    if (goal.status !== 'paused' || !objective.trim()) throw new Error('Pause with feedback before replanning');
    for (const step of this.team(goal).steps) {
      const state = this.store.step(goal.id, step.id);
      if (!state.dispatchId) continue;
      if (state.status === 'dispatched') await this.settle(goal, step);
      await this.releaseWorker(goal, step);
      const current = this.store.step(goal.id, step.id);
      if (current.status === 'dispatched' || (current.settlement as Native)?.terminalResource?.releaseState !== 'released') throw new Error('Reconcile and drain existing workers before replanning');
    }
    this.store.put('goal', { ...goal, status: 'abandoned' as const });
    try {
      const next = this.createGoal(goal.project, objective, goal.source);
      this.store.put('handoff', { id: goal.id, previous: goal.id, next: next.id, reason: 'Replanned after founder feedback' });
      return next;
    } catch (error) { this.store.put('goal', goal); throw error; }
  }
  async replyWorker(messageId: string, body: string): Promise<void> {
    const event = this.store.get<{ id: string; runId: string; goalId: string }>('question', messageId);
    if (!event) throw new Error('Question does not belong to a managed goal');
    await this.orca.mutate(`reply:${messageId}:${sha256(body)}`, event.runId, 'reply', '--id', messageId, '--body', body);
    this.store.delete('question', messageId);
  }
}
