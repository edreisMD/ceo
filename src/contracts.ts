import { Type, type Static, type TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

const Id = Type.String({ pattern: '^[a-z][a-z0-9-]{0,63}$' });
const Text = Type.String({ minLength: 1 });
const ObjectOptions = { additionalProperties: false };
export const TriggerSchema = Type.Union([
  Type.Object({ type: Type.Literal('manual') }, ObjectOptions),
  Type.Object({ type: Type.Literal('event'), name: Text }, ObjectOptions),
  Type.Object({ type: Type.Literal('interval'), seconds: Type.Integer({ minimum: 60, maximum: 604800 }) }, ObjectOptions),
  Type.Object({ type: Type.Literal('cron'), expression: Text, timezone: Text }, ObjectOptions),
]);
export const AgentSchema = Type.Object({
  version: Type.Literal(1), id: Id, workspace: Text, trigger: TriggerSchema,
  schedule_paused: Type.Boolean(), timeout_seconds: Type.Integer({ minimum: 10, maximum: 2700 }),
  sandbox: Type.Union([Type.Literal('read-only'), Type.Literal('workspace-write')]),
  session: Type.Union([Type.Literal('new'), Type.Literal('resume')]),
}, ObjectOptions);
export const StepSchema = Type.Object({
  id: Id, kind: Type.Union([Type.Literal('agent'), Type.Literal('decision')]), needs: Type.Array(Id, { uniqueItems: true }),
  role: Type.Optional(Type.String({ pattern: '^(engineering|operations|sales|executive)/[a-z][a-z0-9-/]*$' })),
  placement: Type.Optional(Type.Union([Type.Literal('control'), Type.Literal('isolated'), Type.Literal('candidate')])),
  contract: Type.Optional(Type.Union(['plan', 'candidate', 'review', 'qa', 'delivery', 'verification', 'generic'].map(x => Type.Literal(x)))),
  gate: Type.Optional(Type.Union(['plan', 'release', 'publication'].map(x => Type.Literal(x)))),
}, ObjectOptions);
export const TeamSchema = Type.Object({
  version: Type.Literal(1), id: Id, description: Text, steps: Type.Array(StepSchema, { minItems: 1, maxItems: 24 }),
}, ObjectOptions);
export type AgentDefinition = Static<typeof AgentSchema>;
export type Step = Static<typeof StepSchema>;
export type Team = Static<typeof TeamSchema>;
export const LinearSchema = Type.Object({
  workspace: Text, team: Text, project: Type.Optional(Text), titlePrefix: Text,
  readyStates: Type.Array(Text, { minItems: 1 }), doneState: Text, founderIds: Type.Array(Text, { minItems: 1 }),
}, ObjectOptions);
export const ProjectSchema = Type.Object({
  id: Id, repository: Type.String({ pattern: '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' }),
  defaultBranch: Text, sourcePath: Text, controlWorkspace: Text, team: Id, enabled: Type.Boolean(),
  catalogPath: Text, catalogRevision: Type.String({ pattern: '^[a-f0-9]{40}$' }),
  harnesses: Type.Record(Type.String(), Text), linear: Type.Optional(LinearSchema),
  productionUrl: Type.Optional(Type.String({ pattern: '^https://' })),
}, ObjectOptions);
export const ConfigSchema = Type.Object({
  version: Type.Literal(1), instance: Id, orca: Text,
  controlWorkspace: Text, stateDir: Text, projects: Type.Array(ProjectSchema, { minItems: 1 }),
  limits: Type.Object({ workers: Type.Integer({ minimum: 1, maximum: 16 }),
    implementationsPerProject: Type.Literal(1), workflowsPerProject: Type.Literal(1),
    turnsPerDay: Type.Integer({ minimum: 1, maximum: 500 }),
    workerStartsPerProjectPerDay: Type.Integer({ minimum: 1, maximum: 100 }),
  }, ObjectOptions),
  evolution: Type.Object({ enabled: Type.Boolean(), catalogPath: Text,
    trustedRevision: Type.String({ pattern: '^[a-f0-9]{40}$' }),
    branch: Type.Literal('ceo/active'), remote: Type.String({ pattern: '^https://github.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+(?:\\.git)?$' }),
    visibility: Type.Union([Type.Literal('public'), Type.Literal('private')]),
    editableDepartments: Type.Array(Type.Union(['engineering', 'operations', 'sales'].map(x => Type.Literal(x))), { uniqueItems: true }),
    maxRolesPerDepartment: Type.Integer({ minimum: 1, maximum: 12 }),
    experimentsPerProjectPerWeek: Type.Literal(1),
  }, ObjectOptions),
}, ObjectOptions);
export type Config = Static<typeof ConfigSchema>;
export type Project = Static<typeof ProjectSchema>;
export function validated<T>(schema: TSchema, value: unknown): T {
  if (!Value.Check(schema, value)) {
    throw new Error([...Value.Errors(schema, value)].map(x => `${x.path}: ${x.message}`).join('; '));
  }
  return value as T;
}

export function validateTeam(team: Team): Team {
  const seen = new Set<string>();
  for (const step of team.steps) {
    if (seen.has(step.id) || step.needs.some(id => !seen.has(id))) throw new Error('Team must be a unique topologically ordered graph');
    if (step.kind === 'agent' && (!step.role || !step.placement || !step.contract || step.gate)) throw new Error(`Incomplete agent step ${step.id}`);
    if (step.kind === 'decision' && (!step.gate || step.role || step.contract || step.placement)) throw new Error(`Incomplete decision step ${step.id}`);
    seen.add(step.id);
  }
  // Engineering release invariants are owned by the runtime, not editable skills.
  const find = (contract: string) => team.steps.find(s => s.contract === contract);
  const depends = (step: Step, target: Step): boolean => step.needs.some(id => id === target.id || depends(team.steps.find(s => s.id === id)!, target));
  const plan = find('plan'), candidate = find('candidate'), review = find('review'), qa = find('qa'), delivery = find('delivery'), verify = find('verification');
  if (!plan || !candidate || !review || !qa || !delivery || !verify) throw new Error('Engineering team requires plan, candidate, review, QA, delivery and verification');
  const gates = ['plan', 'release', 'publication'].map(gate => team.steps.find(s => s.gate === gate));
  if (gates.some(g => !g) || team.steps.filter(s => s.kind === 'decision').length !== 3) throw new Error('Engineering approval gates are required');
  if (!depends(gates[0]!, plan) || !depends(candidate, gates[0]!) || !depends(review, candidate) || !depends(qa, candidate)
    || !depends(delivery, review) || !depends(delivery, qa) || !depends(gates[1]!, delivery)
    || !depends(gates[2]!, gates[1]!) || !depends(verify, gates[2]!)) throw new Error('Engineering approval/evidence ordering cannot be weakened');
  if (candidate.placement !== 'isolated' || [review, qa, delivery].some(s => s.placement !== 'candidate') || verify.placement !== 'control') throw new Error('Invalid candidate ownership');
  if (team.steps.filter(s => s.contract === 'candidate').length !== 1) throw new Error('Only one implementation step per workflow');
  for (const contract of ['plan', 'review', 'qa', 'delivery', 'verification']) if (team.steps.filter(s => s.contract === contract).length !== 1) throw new Error('Required evidence contracts must be unique');
  if (team.steps.some(s => s.placement === 'isolated' && s.contract !== 'candidate')) throw new Error('Only implementation may own an isolated candidate');
  return team;
}
