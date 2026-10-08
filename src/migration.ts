import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { Catalog } from './catalog.js';
import { Workflow } from './workflow.js';
import { reportDirectory, reportPath, sha256 } from './reports.js';
import { issueFingerprint } from './intake.js';
import type { Decision, Goal } from './store.js';

/** Stage the existing frontend pilot without changing its schedule or ownership.
 * Activation is deliberately a separate verified handoff, never an import effect.
 */
export async function stageFrontendPilot(workflow: Workflow, projectId: string, bindingPath: string, statePath: string): Promise<Goal> {
  const project = workflow.config.projects.find(p => p.id === projectId);
  if (!project) throw new Error('Unknown project');
  const binding = JSON.parse(readFileSync(bindingPath, 'utf8')), old = JSON.parse(readFileSync(statePath, 'utf8'));
  const team = new Catalog(project.catalogPath, project.catalogRevision).team(project.team);
  const id = old.issue?.id;
  if (!/^[a-f0-9-]{36}$/.test(id ?? '') || !binding.run_id || !binding.coordinator_handle) throw new Error('Pilot lacks durable identity');
  if (binding.repository !== project.repository) throw new Error('Pilot repository does not match installation');
  if (workflow.store.get('goal', id)) throw new Error('Pilot already staged; preserve its existing records');
  if (workflow.store.list<Goal>('goal').some(g => g.project === projectId && ['active', 'paused'].includes(g.status))) throw new Error('Project already has a workflow');
  for (const step of team.steps) if (!old.tasks?.[step.id]) throw new Error('Pilot task graph differs; do not recreate missing tasks');
  const planAttempt = old.dispatches?.plan;
  if (!planAttempt?.dispatchId) throw new Error('Pilot lacks planner attempt');
  const native = await workflow.orca.read('orchestration', 'worker-show', '--dispatch', planAttempt.dispatchId);
  if (native.dispatch?.status !== 'completed' || native.projection?.outcome !== 'succeeded'
      || native.dispatch.taskId !== old.tasks.plan || native.dispatch.runId !== binding.run_id || native.terminalResource?.releaseState !== 'released') throw new Error('Verify and drain pilot planner before staging');
  if (Object.entries(old.dispatches).some(([key]) => key !== 'plan')) throw new Error('Additional pilot workers require individual handoff reconciliation');
  const originalReport = JSON.parse(readFileSync(resolve(dirname(statePath), id, 'plan.json'), 'utf8'));
  const plan = readFileSync(originalReport.plan_path);
  if (sha256(plan) !== originalReport.plan_sha256 || originalReport.task_id !== old.tasks.plan) throw new Error('Pilot plan identity or hash differs');
  const folder = reportDirectory(workflow.config.stateDir, id), archive = resolve(folder, 'legacy'); mkdirSync(archive, { recursive: true, mode: 0o700 });
  copyFileSync(bindingPath, resolve(archive, 'binding.json')); copyFileSync(statePath, resolve(archive, 'active.json'));
  copyFileSync(resolve(dirname(statePath), id, 'plan.json'), resolve(archive, 'plan.json'));
  const planPath = resolve(folder, 'plan.md'); writeFileSync(planPath, plan, { mode: 0o600 });
  const report = { ...originalReport, plan_path: planPath };
  writeFileSync(reportPath(workflow.config.stateDir, id, 'plan'), JSON.stringify(report, null, 2), { mode: 0o600 });
  const goal: Goal = { id, project: projectId, objective: `${old.issue.title}\n\n${old.issue.description ?? ''}`, status: 'paused',
    runId: binding.run_id, catalogRevision: project.catalogRevision, team, createdAt: old.issue.createdAt,
    source: { kind: 'linear', id, identifier: old.issue.identifier, url: old.issue.url, fingerprint: issueFingerprint(old.issue) } };
  const notice = old.notices?.['plan-approval'];
  if (!notice?.id || notice.sha !== report.plan_sha256) throw new Error('Pending pilot decision differs from plan');
  const decision: Decision = { id: notice.id, goalId: id, stepId: 'plan-approval', kind: 'plan', artifact: notice.sha,
    summary: plan.toString('utf8'), status: 'pending', createdAt: notice.createdAt };
  workflow.store.transaction(() => {
    workflow.store.put('goal', goal);
    for (const step of team.steps) workflow.store.saveStep({ goalId: id, stepId: step.id, taskId: old.tasks[step.id], status: step.id === 'plan' ? 'completed' : 'pending',
      ...(step.id === 'plan' ? { dispatchId: planAttempt.dispatchId, report, settlement: native, evidence: sha256(JSON.stringify(report)) } : {}) });
    workflow.store.put('decision', decision);
    workflow.store.put('pilot_handoff', { id, status: 'staged', originalCoordinator: binding.coordinator_handle,
      originalCatalogRevision: binding.catalog_commit, originalWorkflowHash: old.workflow_sha256,
      archive, pendingDecisions: report.pending_decisions, required: ['Pi provider login', 'Coordinator native hooks/session visibility', 'Two-harness validation', 'Previous schedule pause receipt', 'Run ownership and inbox reconciliation'] });
  });
  return goal;
}
