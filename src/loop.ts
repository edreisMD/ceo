import { Workflow } from './workflow.js';
import { LinearIntake, enabledProjects } from './intake.js';
import type { Goal, Event, StepState } from './store.js';
import type { Native } from './orca.js';

export interface Brain { run(events: Event[], snapshot: unknown): Promise<void>; }
export class CoordinatorLoop {
  private busy = false;
  private polling?: Promise<void>;
  private finishPoll?: () => void;
  private nextRefresh = 0;
  private nextIntake = 0;
  constructor(readonly workflow: Workflow, readonly brain: Brain, readonly now = () => Date.now()) {}
  async waitForPoll(): Promise<void> { await this.polling; }
  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.polling = new Promise<void>(done => { this.finishPoll = done; });
    try {
      const intake = new LinearIntake(this.workflow);
      const goals = this.workflow.store.list<Goal>('goal').filter(g => ['active', 'paused'].includes(g.status));
      for (const goal of goals) {
        if (!this.workflow.config.projects.some(p => p.id === goal.project && p.enabled)) continue;
        if (goal.runId) {
          await this.workflow.orca.withRun(goal.runId, async () => {
            const batch = await this.workflow.orca.read('orchestration', 'check', '--terminal', this.workflow.orca.caller, '--run', goal.runId!);
            const messages = batch.messages ?? batch.delivery?.messages ?? [];
            if (!Array.isArray(messages)) throw new Error('Invalid native message delivery');
            for (const message of messages) this.message(goal, message);
            const deliveryId = batch.delivery?.id ?? batch.deliveryId;
            if (deliveryId) await this.workflow.orca.effect(`ack:${deliveryId}`, ['orchestration', 'check', '--terminal', this.workflow.orca.caller, '--run', goal.runId!, '--ack', deliveryId]);
          });
        }
        if (this.now() >= this.nextRefresh) {
          for (const step of this.workflow.team(goal).steps) {
            const state = this.workflow.store.step(goal.id, step.id);
            if (state.status === 'dispatched') await this.workflow.settle(goal, step);
            else if (state.settlement) {
              const resource = (state.settlement as Native).terminalResource;
              if (resource?.releaseState !== 'released' && state.dispatchId) await this.workflow.releaseWorker(goal, step);
            }
          }
        }
        if (goal.status === 'active') {
          try {
            if (this.now() >= this.nextIntake) await intake.validate(goal);
            const progress = await this.workflow.advance(goal.id);
            if (progress.ready) this.workflow.store.emit('work_ready', progress, goal.id, `ready:${goal.id}:${progress.ready}`);
            if (this.now() >= this.nextIntake) await intake.mirror(goal);
          } catch (error) { this.workflow.store.emit('goal_blocked', { reason: String(error) }, goal.id, `blocked:${goal.id}:${String(error)}`); }
        }
      }
      if (this.now() >= this.nextRefresh) this.nextRefresh = this.now() + 60000;
      if (this.now() >= this.nextIntake) {
        for (const project of enabledProjects(this.workflow.config)) {
          try { await intake.intake(project); } catch (error) { this.workflow.store.emit('intake_blocked', { project: project.id, reason: String(error) }, undefined, `intake:${project.id}:${String(error)}`); }
          if (this.workflow.config.evolution.enabled) {
            const recent = this.workflow.store.list<Goal>('goal').filter(g => g.project === project.id && g.status === 'completed');
            const week = Math.floor(this.now() / 604800000);
            if (recent.length) this.workflow.store.emit('organization_review', { project: project.id, outcomes: recent.map(g => g.id) }, undefined, `org:${project.id}:${week}:${recent.length}`);
          }
        }
        this.nextIntake = this.now() + 300000;
      }
      const events = this.workflow.store.pendingEvents().filter(e => e.kind !== 'heartbeat');
      this.finishPoll?.(); this.polling = undefined; this.finishPoll = undefined;
      if (!events.length) return;
      const key = `turns:${new Date(this.now()).toISOString().slice(0, 10)}`;
      if (this.workflow.store.count(key) >= this.workflow.config.limits.turnsPerDay) return;
      this.workflow.store.increment(key);
      await this.brain.run(events, this.snapshot());
      this.workflow.store.acknowledge(events.map(e => e.id));
    } finally { this.finishPoll?.(); this.polling = undefined; this.finishPoll = undefined; this.busy = false; }
  }
  private message(goal: Goal, message: Native): void {
    if (!message.id) throw new Error('Message lacks identity');
    if (message.run_id && message.run_id !== goal.runId) throw new Error('Message belongs to another Run');
    if (message.type === 'heartbeat') return;
    if (message.type === 'question') this.workflow.store.put('question', { id: message.id, goalId: goal.id, runId: goal.runId, message });
    this.workflow.store.emit(message.type ?? 'message', message, goal.id, `message:${message.id}`);
    // Worker_done triggers reconciliation; it never manufactures task success.
    if (message.type === 'worker_done') this.nextRefresh = 0;
  }
  snapshot(): unknown {
    return { projects: this.workflow.config.projects.map(p => ({ id: p.id, enabled: p.enabled })),
      goals: this.workflow.store.list<Goal>('goal'), steps: this.workflow.store.list<StepState>('step'),
      decisions: this.workflow.store.list<unknown>('decision'), questions: this.workflow.store.list<unknown>('question'),
      operations: this.workflow.store.list<Native>('operation').filter(op => op.state !== 'done') };
  }
}
