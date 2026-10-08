import type { Config, Project } from './contracts.js';
import type { Goal, Decision } from './store.js';
import { Workflow } from './workflow.js';
import { sha256 } from './reports.js';
import type { Native } from './orca.js';

export function issueFingerprint(issue: Native): string {
  return sha256(JSON.stringify({ title: issue.title ?? '', description: issue.description ?? '' }));
}
function complete(response: Native): void {
  const meta = response.meta ?? {};
  if (meta.partial || meta.includeErrors || meta.sections?.comments?.capReached || meta.sections?.comments?.hasMore || meta.sections?.comments?.mayHaveMore) throw new Error('Linear evidence is incomplete');
}
export class LinearIntake {
  constructor(readonly workflow: Workflow) {}
  async intake(project: Project): Promise<void> {
    const cfg = project.linear;
    if (!cfg) return;
    if (this.workflow.store.list<Goal>('goal').some(g => g.project === project.id && ['active', 'paused'].includes(g.status))) return;
    const issues: Native[] = [];
    let cursor: string | undefined;
    do {
      const response = await this.workflow.orca.read('linear', 'list-issues', '--workspace', cfg.workspace,
        '--team', cfg.team, '--limit', '50', ...(cfg.project ? ['--project', cfg.project] : []), ...(cursor ? ['--cursor', cursor] : []));
      complete(response);
      if (!Array.isArray(response.issues)) throw new Error('Linear response has no issue list');
      issues.push(...response.issues);
      const next = response.meta?.hasMore ? response.meta.nextCursor : undefined;
      if (next && next === cursor) throw new Error('Linear cursor did not advance');
      if (response.meta?.hasMore && !next) throw new Error('Linear pagination is incomplete');
      cursor = next;
    } while (cursor);
    const known = new Set(this.workflow.store.list<Goal>('goal').map(g => g.source?.id));
    const eligible = issues.filter(i => !known.has(i.id) && i.title?.startsWith(cfg.titlePrefix) && cfg.readyStates.includes(i.state?.name)
      && i.team?.id === cfg.team && (!cfg.project || i.project?.id === cfg.project));
    eligible.sort((a, b) => (a.priority || 5) - (b.priority || 5) || String(a.createdAt).localeCompare(String(b.createdAt)));
    const issue = eligible[0];
    if (issue) this.workflow.createGoal(project.id, `${issue.title}\n\n${issue.description ?? ''}`, {
      kind: 'linear', id: issue.id, identifier: issue.identifier, url: issue.url, fingerprint: issueFingerprint(issue),
    });
  }
  async validate(goal: Goal): Promise<Native | undefined> {
    const project = this.workflow.project(goal.project), cfg = project.linear;
    if (!goal.source || !cfg) return undefined;
    const response = await this.workflow.orca.read('linear', 'issue', goal.source.identifier, '--workspace', cfg.workspace, '--comments', '--full');
    complete(response);
    const issue = response.issue;
    if (!issue || issue.team?.id !== cfg.team || (cfg.project && issue.project?.id !== cfg.project) || ['canceled', 'completed'].includes(issue.state?.type)) throw new Error('Issue is outside active intake scope');
    if (issueFingerprint(issue) !== goal.source.fingerprint) {
      this.workflow.feedback(goal.id, 'Linear issue content changed; reconcile and replan');
      throw new Error('Linear issue changed after intake');
    }
    return response;
  }
  async mirror(goal: Goal): Promise<void> {
    const project = this.workflow.project(goal.project), cfg = project.linear;
    if (!cfg || !goal.source) return;
    const response = await this.validate(goal);
    for (const decision of this.workflow.store.list<Decision>('decision').filter(d => d.goalId === goal.id && d.status !== 'invalidated')) {
      const marker = `<!-- ceo:${decision.id}:${decision.status} -->`;
      const key = `linear:${decision.id}:${decision.status}`;
      const op = this.workflow.store.beginOperation(key, { identifier: goal.source.identifier, status: decision.status, artifact: decision.artifact });
      const comment = response?.comments?.find((c: Native) => c.body?.includes(marker));
      if (comment) { this.workflow.store.finishOperation(op, { comment, reconciled: true }); continue; }
      if (op.state === 'done') continue;
      if (op.state === 'unknown') throw new Error(`Linear comment ${op.id} remains uncertain; inspect native write receipt before retrying`);
      // Native Linear's UUIDv4 write id is persisted and its comment is reconciled on subsequent reads.
      const body = `${marker}\nceo ${decision.kind}: ${decision.status}\n\n${decision.summary}\n\nArtifact: ${decision.artifact}\nDecision: ${decision.id}\nRespond in the ceo conversation: ${decision.kind === 'publication' ? 'published' : 'approve'} ${decision.id}, or reject ${decision.id} <feedback>.`;
      this.workflow.store.unknownOperation(op, { reason: 'Linear comment write in progress' });
      const result = await this.workflow.orca.read('linear', 'comment', 'add', goal.source.identifier, '--workspace', cfg.workspace, '--write-id', op.requestId, '--body', body);
      this.workflow.store.finishOperation(op, result);
    }
  }
}
export function enabledProjects(config: Config): Project[] { return config.projects.filter(p => p.enabled); }
