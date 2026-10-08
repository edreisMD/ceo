import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { AgentSchema, TeamSchema, validated, validateTeam, type AgentDefinition, type Team } from './contracts.js';

export function git(repo: string, ...args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }).trim();
}
export function safeCatalogPath(path: string): string {
  if (!/^[a-zA-Z0-9_./-]+$/.test(path) || path.split('/').some(x => x === '..' || x.startsWith('.')) || path.startsWith('/')) throw new Error('Invalid catalog path');
  return path;
}
export class Catalog {
  constructor(readonly repo: string, readonly revision: string) {
    if (!/^[a-f0-9]{40}$/.test(revision) || git(repo, 'rev-parse', `${revision}^{commit}`) !== revision) throw new Error('Catalog requires an exact commit');
  }
  file(path: string): string {
    safeCatalogPath(path);
    const entry = git(this.repo, 'ls-tree', this.revision, '--', path);
    if (!entry.startsWith('100644 blob ') && !entry.startsWith('100755 blob ')) throw new Error(`Catalog file is absent or not regular: ${path}`);
    return git(this.repo, 'show', `${this.revision}:${path}`);
  }
  role(path: string): { agent: AgentDefinition; skill: string } {
    const agent = validated<AgentDefinition>(AgentSchema, parse(this.file(`${path}/agent.yaml`)));
    if (agent.id !== path.replaceAll('/', '-')) throw new Error('Role id does not match folder');
    const legacy = parse(this.file(`${path}/temporal.yaml`));
    const normalized = { ...legacy, version: 1, schedule_paused: legacy.paused };
    delete normalized.paused;
    if (JSON.stringify(normalized.trigger) !== JSON.stringify(agent.trigger)
      || ['id', 'workspace', 'timeout_seconds', 'session', 'sandbox', 'schedule_paused'].some(k => normalized[k] !== (agent as Record<string, unknown>)[k])) throw new Error(`Temporal/agent configuration conflict in ${path}`);
    const skill = this.file(`${path}/SKILL.md`);
    const frontmatter = skill.split('---')[1];
    if (!frontmatter || parse(frontmatter)?.name !== path.split('/').at(-1)) throw new Error('Invalid skill frontmatter');
    return { agent, skill };
  }
  team(id: string): Team {
    const team = validateTeam(validated<Team>(TeamSchema, parse(this.file(`teams/${id}/team.yaml`))));
    if (team.id !== id) throw new Error('Team id does not match folder');
    for (const step of team.steps) if (step.role) this.role(step.role);
    return team;
  }
  materialize(home: string): string {
    const path = resolve(home, 'catalogs', this.revision);
    mkdirSync(resolve(home, 'catalogs'), { recursive: true, mode: 0o700 });
    if (existsSync(path) && git(path, 'rev-parse', 'HEAD') === this.revision && !git(path, 'status', '--porcelain')) return path;
    git(this.repo, 'worktree', 'add', '--detach', path, this.revision);
    return path;
  }
}
