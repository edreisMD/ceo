import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { inside } from './config.js';
import { git } from './catalog.js';
import type { Step } from './contracts.js';

export const sha256 = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');
export function reportDirectory(home: string, goalId: string): string { return resolve(home, 'reports', goalId); }
export function reportPath(home: string, goalId: string, stepId: string): string { return resolve(reportDirectory(home, goalId), `${stepId}.json`); }
export function readReport(home: string, goalId: string, step: Step, taskId: string): Record<string, any> {
  const root = reportDirectory(home, goalId), path = inside(root, reportPath(home, goalId, step.id));
  if (statSync(path).size > 262144) throw new Error('Report exceeds 256 KiB');
  const report = JSON.parse(readFileSync(path, 'utf8'));
  if (report.task_id !== taskId || report.outcome !== 'succeeded') throw new Error('Report is not a success for the assigned native task');
  const fields: Record<string, string[]> = {
    plan: ['plan_path', 'plan_sha256', 'implementation_ready', 'pending_decisions'],
    candidate: ['worktree', 'head_sha'], review: ['head_sha', 'findings'],
    qa: ['head_sha', 'tests', 'preview_url', 'browser_evidence'],
    delivery: ['head_sha', 'pr_url', 'checks'],
    verification: ['head_sha', 'production_url', 'deployment_evidence'], generic: ['evidence'],
  };
  if (!step.contract || fields[step.contract]!.some(k => report[k] === undefined)) throw new Error('Report lacks required evidence');
  if (step.contract === 'plan') {
    if (typeof report.implementation_ready !== 'boolean' || !Array.isArray(report.pending_decisions)) throw new Error('Invalid plan readiness');
    if (report.implementation_ready === (report.pending_decisions.length > 0)) throw new Error('Plan readiness must match unresolved prerequisites');
    const artifact = inside(root, report.plan_path);
    if (statSync(artifact).size > 262144 || sha256(readFileSync(artifact)) !== report.plan_sha256) throw new Error('Plan hash mismatch');
  }
  if (report.head_sha && !/^[a-f0-9]{40}$/.test(report.head_sha)) throw new Error('Candidate must be an exact Git commit');
  if (step.contract === 'review' && (!Array.isArray(report.findings) || report.findings.length)) throw new Error('Review has unresolved findings');
  if (step.contract === 'qa' && (!Array.isArray(report.tests) || !report.tests.length || !report.browser_evidence || report.tests.some((t: any) => t.passed !== true))) throw new Error('QA evidence does not pass');
  if (step.contract === 'delivery' && (!Array.isArray(report.checks) || !report.checks.length || report.checks.some((c: any) => c.passed !== true) || !report.pr_url)) throw new Error('Delivery evidence missing or failing');
  if (step.contract === 'verification' && !report.deployment_evidence) throw new Error('Production verification missing deployment evidence');
  return report;
}
export function candidateHead(worktree: string): string {
  if (git(worktree, 'status', '--porcelain', '--untracked-files=normal')) throw new Error('Candidate worktree has uncommitted work');
  return git(worktree, 'rev-parse', 'HEAD');
}
