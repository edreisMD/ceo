import { DatabaseSync } from 'node:sqlite';
import { chmodSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { privateDirectory } from './config.js';

export type Goal = { id: string; project: string; objective: string; status: 'active' | 'paused' | 'completed' | 'abandoned';
  runId?: string; catalogRevision: string; team: unknown; source?: { kind: 'linear'; id: string; identifier: string; url: string; fingerprint: string }; createdAt: string };
export type StepState = { goalId: string; stepId: string; taskId?: string; dispatchId?: string;
  status: 'pending' | 'ready' | 'dispatched' | 'completed' | 'failed' | 'blocked'; report?: Record<string, unknown>; evidence?: string; settlement?: unknown };
export type Decision = { id: string; goalId: string; stepId: string; kind: string; artifact: string; summary: string;
  status: 'pending' | 'approved' | 'rejected' | 'invalidated'; createdAt: string; response?: string; nativeGate?: string };
export type Operation = { id: string; key: string; requestId: string; payload: unknown; state: 'pending' | 'unknown' | 'done'; receipt?: unknown };
export type Event = { id: string; kind: string; goalId?: string; data: unknown; createdAt: string };

export class Store {
  readonly db: DatabaseSync;
  constructor(readonly home: string) {
    privateDirectory(home);
    const file = resolve(home, 'state.sqlite');
    this.db = new DatabaseSync(file);
    chmodSync(file, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS records (kind TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(kind,id));
      CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, data TEXT NOT NULL, processed INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS leases (id TEXT PRIMARY KEY, token TEXT NOT NULL, pid INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS counters (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
      PRAGMA user_version=1;`);
  }
  close(): void { this.db.close(); }
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = fn(); this.db.exec('COMMIT'); return value; } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  put<T extends { id: string }>(kind: string, value: T): T {
    this.db.prepare('INSERT INTO records(kind,id,data) VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data').run(kind, value.id, JSON.stringify(value));
    return value;
  }
  get<T>(kind: string, id: string): T | undefined {
    const row = this.db.prepare('SELECT data FROM records WHERE kind=? AND id=?').get(kind, id);
    return row ? JSON.parse(String(row.data)) as T : undefined;
  }
  list<T>(kind: string): T[] { return this.db.prepare('SELECT data FROM records WHERE kind=? ORDER BY rowid').all(kind).map(r => JSON.parse(String(r.data)) as T); }
  delete(kind: string, id: string): void { this.db.prepare('DELETE FROM records WHERE kind=? AND id=?').run(kind, id); }
  step(goalId: string, stepId: string): StepState {
    return this.get<StepState>('step', `${goalId}:${stepId}`) ?? { goalId, stepId, status: 'pending' };
  }
  saveStep(value: StepState): StepState { this.put('step', { ...value, id: `${value.goalId}:${value.stepId}` }); return value; }
  emit(kind: string, data: unknown, goalId?: string, id: string = randomUUID()): Event {
    const event = { id, kind, goalId, data, createdAt: new Date().toISOString() };
    this.db.prepare('INSERT OR IGNORE INTO events(id,data) VALUES(?,?)').run(id, JSON.stringify(event));
    return event;
  }
  pendingEvents(): Event[] { return this.db.prepare('SELECT data FROM events WHERE processed=0 ORDER BY seq').all().map(r => JSON.parse(String(r.data)) as Event); }
  acknowledge(ids: string[]): void { this.transaction(() => { for (const id of ids) this.db.prepare('UPDATE events SET processed=1 WHERE id=?').run(id); }); }
  count(key: string): number { return Number(this.db.prepare('SELECT value FROM counters WHERE key=?').get(key)?.value ?? 0); }
  increment(key: string): number { this.db.prepare('INSERT INTO counters(key,value) VALUES(?,1) ON CONFLICT(key) DO UPDATE SET value=value+1').run(key); return this.count(key); }
  claim(id: string): () => void {
    const token = randomUUID();
    this.transaction(() => {
      const old = this.db.prepare('SELECT * FROM leases WHERE id=?').get(id);
      if (old) {
        let live = true;
        try { process.kill(Number(old.pid), 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') live = false; }
        if (live) throw new Error('A coordinator already owns this portfolio');
        this.db.prepare('DELETE FROM leases WHERE id=? AND token=?').run(id, String(old.token));
      }
      this.db.prepare('INSERT INTO leases(id,token,pid) VALUES(?,?,?)').run(id, token, process.pid);
    });
    return () => { this.db.prepare('DELETE FROM leases WHERE id=? AND token=?').run(id, token); };
  }
  beginOperation(key: string, payload: unknown): Operation {
    const id = key;
    const old = this.get<Operation>('operation', id);
    if (old) {
      if (JSON.stringify(old.payload) !== JSON.stringify(payload)) throw new Error('Operation key reused with different content');
      return old;
    }
    return this.put('operation', { id, key, requestId: randomUUID(), payload, state: 'pending' as const });
  }
  finishOperation(op: Operation, receipt: unknown): void { this.put('operation', { ...op, state: 'done' as const, receipt }); }
  unknownOperation(op: Operation, receipt: unknown): void { this.put('operation', { ...op, state: 'unknown' as const, receipt }); }
  export(): unknown { return { records: this.db.prepare('SELECT kind,id,data FROM records').all().map(r => ({ kind: r.kind, id: r.id, data: JSON.parse(String(r.data)) })), events: this.db.prepare('SELECT data,processed FROM events').all().map(r => ({ event: JSON.parse(String(r.data)), processed: r.processed })) }; }
}
