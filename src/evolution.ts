import { mkdirSync, readFileSync, writeFileSync, lstatSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parse } from 'yaml';
import type { Config } from './contracts.js';
import { AgentSchema, validated, type AgentDefinition } from './contracts.js';
import { Catalog, git, safeCatalogPath } from './catalog.js';
import { Store, type Goal } from './store.js';

export type OrganizationPatch = { project: string; bottleneck: string; expectedResult: string; files: { path: string; content: string | null }[] };
export class Evolution {
  constructor(readonly config: Config, readonly store: Store, readonly push = (repo: string, remote: string, sha: string) => git(repo, 'push', remote, `${sha}:refs/heads/ceo/active`)) {}
  apply(patch: OrganizationPatch): { revision: string; previous: string; checkout: string } {
    const policy = this.config.evolution;
    if (!policy.enabled) throw new Error('Organization evolution is disabled');
    const project = this.config.projects.find(p => p.id === patch.project && p.enabled);
    if (!project || resolve(project.catalogPath) !== resolve(policy.catalogPath)) throw new Error('Project is outside the configured organization catalog');
    if (!patch.bottleneck.trim() || !patch.expectedResult.trim() || !patch.files.length) throw new Error('Organization experiment requires evidence and an expected result');
    const old = this.store.list<any>('experiment').filter(e => e.project === patch.project && e.appliedAt > 0).at(-1);
    if (old && Date.now() - old.appliedAt < 604800000) throw new Error('Weekly organization experiment limit reached');
    if (this.store.list<any>('experiment').some(e => e.state === 'publishing')) throw new Error('Reconcile an unfinished catalog publication first');
    const base = this.store.get<{ revision: string }>('catalog', project.id)?.revision ?? project.catalogRevision;
    const trusted = new Catalog(policy.catalogPath, policy.trustedRevision);
    const baseCatalog = new Catalog(policy.catalogPath, base);
    const governance = parse(trusted.file('governance.yaml'));
    const allowed = governance.owners['executive-ceo'].editable_departments as string[];
    const id = randomUUID(), checkout = resolve(this.config.stateDir, 'organization', id);
    const seen = new Set<string>();
    for (const file of patch.files) {
      safeCatalogPath(file.path);
      if (seen.has(file.path)) throw new Error('Duplicate organization patch path');
      seen.add(file.path);
      const pieces = file.path.split('/');
      const team = /^teams\/[a-z][a-z0-9-]*\/team\.yaml$/.test(file.path);
      const role = pieces.length === 3 && policy.editableDepartments.includes(pieces[0]!) && allowed.includes(pieces[0]!) && ['SKILL.md', 'agent.yaml', 'temporal.yaml'].includes(pieces[2]!);
      if (!team && !role) throw new Error(`Outside organization scope: ${file.path}`);
      if (file.content !== null && Buffer.byteLength(file.content) > 65536) throw new Error('Organization file exceeds 64 KiB');
      if (file.content && policy.visibility === 'public' && /(?:\/Users\/|\/home\/|company-private|\.ceo\/|linear\.app\/|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}|sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|-----BEGIN .*PRIVATE KEY)/i.test(file.content)) throw new Error('Public organization change contains private context or credential markers');
    }
    mkdirSync(resolve(this.config.stateDir, 'organization'), { recursive: true, mode: 0o700 });
    git(policy.catalogPath, 'worktree', 'add', '--detach', checkout, base);
    for (const file of patch.files) {
      const path = resolve(checkout, file.path);
      try { if (lstatSync(path).isSymbolicLink()) throw new Error('Catalog symlink refused'); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
      if (file.content === null) git(checkout, 'rm', '--', file.path);
      else {
        const parent = resolve(checkout, ...file.path.split('/').slice(0, -1));
        mkdirSync(parent, { recursive: true });
        writeFileSync(path, file.content);
        git(checkout, 'add', '--', file.path);
      }
    }
    // Validate candidate data and execution invariants before committing or publishing.
    const roles = git(checkout, 'ls-files').split('\n').filter(p => p.endsWith('/agent.yaml'));
    for (const path of roles) {
      const agent = validated<AgentDefinition>(AgentSchema, parse(readFileSync(resolve(checkout, path), 'utf8')));
      const role = path.slice(0, -'/agent.yaml'.length);
      const legacy = parse(readFileSync(resolve(checkout, role, 'temporal.yaml'), 'utf8'));
      if (agent.id !== role.replaceAll('/', '-') || ['id', 'workspace', 'timeout_seconds', 'session', 'sandbox'].some(k => (agent as any)[k] !== legacy[k]) || JSON.stringify(agent.trigger) !== JSON.stringify(legacy.trigger) || agent.schedule_paused !== legacy.paused) throw new Error('Conflicting role definitions');
      let before: AgentDefinition | undefined;
      try { before = baseCatalog.role(role).agent; } catch { /* new role */ }
      if (before && ['sandbox', 'workspace', 'timeout_seconds', 'session', 'schedule_paused'].some(k => (before as any)[k] !== (agent as any)[k])) throw new Error('Organization patch changes execution authority');
      if (!before && (agent.sandbox !== 'read-only' || !agent.schedule_paused || agent.session !== 'new' || agent.timeout_seconds > 900)) throw new Error('New roles require conservative execution defaults');
      const skill = readFileSync(resolve(checkout, role, 'SKILL.md'), 'utf8');
      if (parse(skill.split('---')[1] ?? '')?.name !== role.split('/').at(-1)) throw new Error('Invalid role skill');
    }
    for (const department of policy.editableDepartments) if (roles.filter(p => p.startsWith(department + '/')).length > Math.min(policy.maxRolesPerDepartment, governance.max_roles_per_department)) throw new Error('Department role limit exceeded');
    const removed = git(checkout, 'diff', '--cached', '--diff-filter=D', '--name-only').split('\n').filter(Boolean);
    if (removed.some(path => path.endsWith('/agent.yaml'))) {
      for (const path of removed.filter(p => p.endsWith('/agent.yaml'))) {
        const role = path.slice(0, -'/agent.yaml'.length);
        if (!baseCatalog.role(role).agent.schedule_paused) throw new Error('Pause role schedules before retirement');
        if (this.store.list<Goal>('goal').some(g => ['active', 'paused'].includes(g.status) && (g.team as any).steps.some((s: any) => s.role === role))) throw new Error('Drain pinned workflows before retiring a role');
      }
    }
    git(checkout, 'commit', '-m', `Improve ${project.team} team organization`);
    const revision = git(checkout, 'rev-parse', 'HEAD'), candidate = new Catalog(checkout, revision);
    for (const path of roles) candidate.role(path.slice(0, -'/agent.yaml'.length));
    for (const path of git(checkout, 'ls-files').split('\n').filter(p => /^teams\/[^/]+\/team\.yaml$/.test(p))) candidate.team(path.split('/')[1]!);
    for (const managed of this.config.projects.filter(p => p.catalogPath === project.catalogPath)) candidate.team(managed.team);
    const experiment = { id, project: project.id, bottleneck: patch.bottleneck, expectedResult: patch.expectedResult,
      previous: base, revision, checkout, state: 'publishing', appliedAt: 0 };
    this.store.put('experiment', experiment);
    this.push(checkout, policy.remote, revision);
    // Catalog activation is private state; existing goal pins are never rewritten.
    this.store.transaction(() => {
      this.store.put('catalog', { id: project.id, revision });
      this.store.put('experiment', { ...experiment, state: 'applied', appliedAt: Date.now() });
      this.store.emit('organization_changed', { project: project.id, previous: base, revision });
    });
    return { revision, previous: base, checkout };
  }
  reconcilePublication(id: string): void {
    const row = this.store.get<any>('experiment', id);
    if (!row || row.state !== 'publishing') throw new Error('No uncertain publication');
    const remote = git(row.checkout, 'ls-remote', this.config.evolution.remote, 'refs/heads/ceo/active').split(/\s+/)[0];
    if (remote !== row.revision) throw new Error('Remote does not prove the catalog publication');
    this.store.transaction(() => { this.store.put('catalog', { id: row.project, revision: row.revision }); this.store.put('experiment', { ...row, state: 'applied', appliedAt: Date.now() }); });
  }
  rollback(id: string): void {
    const row = this.store.get<any>('experiment', id);
    if (!row || row.state !== 'applied') throw new Error('Experiment is not applied');
    if (this.store.get<any>('catalog', row.project)?.revision !== row.revision) throw new Error('A newer activation superseded this experiment');
    new Catalog(this.config.evolution.catalogPath, row.previous).team(this.config.projects.find(p => p.id === row.project)!.team);
    this.store.transaction(() => { this.store.put('catalog', { id: row.project, revision: row.previous }); this.store.put('experiment', { ...row, state: 'rolled_back' }); this.store.emit('organization_rolled_back', { project: row.project, revision: row.previous }); });
  }
}
