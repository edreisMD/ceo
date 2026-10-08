#!/usr/bin/env node
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { loadConfig, defaultHome } from './config.js';
import { cliTransport, Orca } from './orca.js';
import { Store, type Operation } from './store.js';
import { Catalog } from './catalog.js';
import { connectConversation } from './socket.js';
import { runHarness } from './harness.js';
import { CoordinatorLoop } from './loop.js';
import { Workflow } from './workflow.js';
import { stageFrontendPilot } from './migration.js';

const quote = (text: string) => "'" + text.replaceAll("'", "'\\''") + "'";
async function attach(home: string): Promise<void> {
  const socket = await connectConversation(home, record => {
    if (record.type === 'assistant') {
      const text = record.data?.content?.filter((part: any) => part.type === 'text').map((part: any) => part.text).join('\n');
      if (text) console.log(`\nceo: ${text}\n`);
    } else if (record.type !== 'connected') console.log(JSON.stringify(record.data ?? record));
  });
  console.log('Connected to ceo. /status and /history inspect the same conversation. Ctrl-D detaches.');
  const input = createInterface({ input: process.stdin, output: process.stdout, prompt: 'you> ' });
  input.prompt();
  input.on('line', line => { socket.write(JSON.stringify(line === '/status' ? { type: 'status' } : line === '/history' ? { type: 'history' } : { type: 'input', text: line }) + '\n'); input.prompt(); });
  socket.once('close', () => input.close()); input.once('close', () => socket.end());
  await new Promise<void>(done => socket.once('close', done));
}
export async function cli(args = process.argv.slice(2)): Promise<void> {
  if (args.includes('--help') || args[0] === 'help') {
    console.log(`ceo — one conversation for all your projects\n\nceo [--config <private.yaml>]           Start in Orca, or attach from a terminal\nceo host [--config <private.yaml>]      Run in its own Orca terminal\nceo attach [--config <private.yaml>]    Attach to the existing conversation\nceo doctor [--config <private.yaml>]    Verify catalog and native CLI support\nceo status|export [--config <private.yaml>]\n\nInside ceo: approve <decision-id>, reject <decision-id> <feedback>, published <decision-id>.\nPi flags (provider, model, session and RPC options) pass through to the host.\nConfiguration defaults to $CEO_HOME/config.yaml or ~/.ceo/config.yaml.`);
    return;
  }
  let configPath = resolve(defaultHome(), 'config.yaml');
  const configIndex = args.indexOf('--config');
  if (configIndex >= 0) { if (!args[configIndex + 1]) throw new Error('--config requires a path'); configPath = resolve(args[configIndex + 1]!); args.splice(configIndex, 2); }
  if (!existsSync(configPath)) throw new Error(`Create private installation configuration at ${configPath}; see examples/config.yaml`);
  const config = loadConfig(configPath), command = args[0];
  const native = cliTransport(config.orca);
  if (command === 'stage-pilot') {
    const [project, binding, state] = args.slice(1);
    if (!project || !binding || !state) throw new Error('stage-pilot <project> <private-binding.json> <private-active.json>');
    const store = new Store(config.stateDir);
    try { console.log(JSON.stringify(await stageFrontendPilot(new Workflow(config, store, new Orca(store, native, 'read-only')), project, resolve(binding), resolve(state)))); }
    finally { store.close(); }
    return;
  }
  if (['doctor', 'status', 'export'].includes(command ?? '')) {
    const store = new Store(config.stateDir);
    try {
      if (command === 'doctor') {
        const status = await native(['status']), schema = await native(['agent-context']);
        const commands = new Set(schema.commands?.map((c: any) => c.command));
        for (const required of ['orchestration run-create', 'orchestration worker-start', 'orchestration worker-show', 'orchestration check', 'orchestration request-show']) if (!commands.has(required)) throw new Error(`Native host lacks ${required}`);
        for (const project of config.projects) new Catalog(project.catalogPath, project.catalogRevision).team(project.team);
        console.log(JSON.stringify({ ok: true, host: status, projects: config.projects.map(p => ({ id: p.id, enabled: p.enabled })), stateDir: config.stateDir }));
      } else console.log(JSON.stringify(command === 'export' ? store.export() : new CoordinatorLoop(new Workflow(config, store, new Orca(store, native, 'read-only')), { run: async () => {} }).snapshot(), null, 2));
    } finally { store.close(); }
    return;
  }
  if (command === 'attach') { await attach(config.stateDir); return; }
  const caller = process.env.ORCA_TERMINAL_HANDLE || process.env.ORCA_AGENT_SESSION_ID;
  if (caller) {
    // Use the identity supplied by the native launch, never an imported worker handle.
    await native(['terminal', 'show', '--terminal', caller]);
    await runHarness(config, caller, command === 'host' ? args.slice(1) : args);
    return;
  }
  if (command === 'host') throw new Error('Launch ceo host in its own Orca terminal; caller identity is required');
  try { await attach(config.stateDir); return; } catch (error) {
    if (!['ENOENT', 'ECONNREFUSED'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
  }
  const store = new Store(config.stateDir), release = store.claim(`bootstrap:${config.instance}`);
  try {
    const old = store.list<Operation>('operation').find(op => op.key === 'coordinator-launch' && op.state === 'unknown');
    if (old) throw new Error(`Coordinator launch is uncertain (${old.id}). Inspect native terminals before retrying; no second coordinator was created.`);
    const prior = store.get<any>('host', config.instance);
    if (prior) throw new Error(`Previous coordinator ${prior.terminal ?? 'launch'} is recorded. Inspect it and restore its conversation; automatic replacement is disabled until its actual state is reconciled.`);
    const launch = `${quote(process.execPath)} ${quote(fileURLToPath(import.meta.url))} host --config ${quote(configPath)} ${args.map(quote).join(' ')}`;
    const orca = new Orca(store, native, 'bootstrap');
    const receipt = await orca.effect('coordinator-launch', ['terminal', 'create', '--worktree', `path:${config.controlWorkspace}`, '--title', 'ceo', '--command', launch]);
    store.put('host', { id: config.instance, receipt, launchedAt: new Date().toISOString(), terminal: receipt.terminal?.handle ?? receipt.handle });
    writeFileSync(resolve(config.stateDir, 'host-receipt.json'), JSON.stringify(receipt, null, 2), { mode: 0o600 });
    console.log('ceo launched in Orca. Open its terminal for provider login if needed, then run ceo attach here.');
  } finally { release(); store.close(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) cli().catch(error => { console.error(String(error)); process.exitCode = 1; });
