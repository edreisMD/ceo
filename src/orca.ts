import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Store, type Operation } from './store.js';

const execute = promisify(execFile);
export type Native = Record<string, any>; // Orca's versioned JSON envelope is decoded at this boundary.
export type Transport = (args: string[]) => Promise<Native>;
export class NativeFailure extends Error {
  constructor(readonly receipt: Native) { super(String(receipt.error?.message || receipt.message || 'Orca operation failed')); }
}
export function cliTransport(executable: string): Transport {
  return async args => {
    let stdout: string;
    try { ({ stdout } = await execute(executable, [...args, '--json'], { timeout: 45000, maxBuffer: 8 * 1024 * 1024 })); }
    catch (error) {
      const e = error as Error & { stdout?: string };
      if (e.stdout) { try { throw new NativeFailure(JSON.parse(e.stdout)); } catch (parsed) { if (parsed instanceof NativeFailure) throw parsed; } }
      throw error;
    }
    const result = JSON.parse(stdout) as Native;
    if (result.ok === false || result.isError) throw new NativeFailure(result);
    return result.result ?? result;
  };
}
export class Orca {
  private tail: Promise<unknown> = Promise.resolve();
  private schema?: Map<string, Set<string>>;
  constructor(readonly store: Store, readonly transport: Transport, readonly caller: string) {}
  serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(fn);
    this.tail = run.catch(() => undefined);
    return run;
  }
  async capabilities(): Promise<Map<string, Set<string>>> {
    if (!this.schema) {
      const data = await this.transport(['agent-context']);
      if (data.schemaVersion !== 1 || !Array.isArray(data.commands)) throw new Error('Unsupported Orca command schema');
      this.schema = new Map(data.commands.map((c: Native) => [c.command, new Set<string>(c.flags)]));
    }
    return this.schema;
  }
  async read(...args: string[]): Promise<Native> { return this.transport(args); }
  async effect(key: string, args: string[]): Promise<Native> {
    const op = this.store.beginOperation(key, args);
    if (op.state === 'done') return op.receipt as Native;
    if (op.state === 'unknown') throw new Error(`Reconcile uncertain operation ${op.id} before proceeding`);
    // Once persisted, any interruption is uncertain. Only this first invocation may send.
    this.store.unknownOperation(op, { reason: 'Invocation started; outcome not yet recorded' });
    const command = args.slice(0, 2).join(' ');
    const flags = (await this.capabilities()).get(command);
    const requestFlag = flags?.has('retry-request') ? ['--retry-request', op.requestId] : [];
    try {
      const result = await this.transport([...args, ...requestFlag]);
      this.store.finishOperation(op, result);
      return result;
    } catch (error) {
      this.store.unknownOperation(op, error instanceof NativeFailure ? error.receipt : { reason: String(error) });
      throw error;
    }
  }
  withRun<T>(runId: string, fn: () => Promise<T>): Promise<T> {
    return this.serial(async () => {
      const current = await this.transport(['orchestration', 'run-current', '--from', this.caller]);
      if (current.run?.id !== runId) await this.transport(['orchestration', 'run-use', '--id', runId, '--from', this.caller]);
      return fn();
    });
  }
  mutate(key: string, runId: string, ...args: string[]): Promise<Native> {
    return this.withRun(runId, async () => {
      const flags = (await this.capabilities()).get(`orchestration ${args[0]}`);
      if (!flags) throw new Error('Orca does not advertise this operation');
      return this.effect(key, ['orchestration', ...args, ...(flags.has('run') ? ['--run', runId] : []), ...(flags.has('from') ? ['--from', this.caller] : [])]);
    });
  }
  async reconcileOperation(id: string): Promise<Operation> {
    const op = this.store.get<Operation>('operation', id);
    if (!op || op.state !== 'unknown') throw new Error('Operation is not uncertain');
    if (!Array.isArray(op.payload) || !(await this.capabilities()).get(op.payload.slice(0, 2).join(' '))?.has('retry-request')) throw new Error('This operation has no advertised replay guarantee; reconcile its artifact instead');
    const flags = (await this.capabilities()).get('orchestration request-show');
    if (!flags) throw new Error('Host does not advertise native mutation receipts');
    const receipt = await this.transport(['orchestration', 'request-show', '--request', op.requestId]);
    const row = receipt.request ?? receipt;
    // Absence or a pending receipt does not prove a write failed.
    if (row.state !== 'completed' && row.status !== 'completed' && row.status !== 'succeeded') throw new Error('Native receipt is not a confirmed completion; preserve operation');
    // A completed ledger row proves the mutation landed. Replay its exact request
    // to obtain the original result; Orca guarantees replay, not a second effect.
    const result = await this.transport([...(op.payload as string[]), '--retry-request', op.requestId]);
    this.store.finishOperation(op, result);
    return this.store.get<Operation>('operation', id)!;
  }
}
