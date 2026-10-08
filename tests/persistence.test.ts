import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fixture } from './fixture.js';
import { Evolution } from '../src/evolution.js';
import { MarkdownMemory } from '../src/memory.js';
import { ConversationServer, connectConversation } from '../src/socket.js';
import { Catalog } from '../src/catalog.js';

test('scoped organization activation pins current goals and rollback restores future goals', () => {
  const f = fixture(); try {
    const goal = f.workflow.createGoal('website', 'Maintain');
    const evolution = new Evolution(f.config, f.store, () => 'published');
    const result = evolution.apply({ project: 'website', bottleneck: 'Reviewer repeatedly misses links', expectedResult: 'Review checks links explicitly', files: [{ path: 'engineering/reviewer/SKILL.md', content: readFileSync(resolve(f.repo, 'engineering/reviewer/SKILL.md'), 'utf8') + '\nInspect changed links.\n' }] });
    assert.notEqual(result.revision, f.revision); assert.equal(f.workflow.goal(goal.id).catalogRevision, f.revision);
    assert.equal(f.store.get<any>('catalog', 'website').revision, result.revision);
    new Catalog(f.repo, result.revision).team('frontend');
    const experiment = f.store.list<any>('experiment')[0]; evolution.rollback(experiment.id);
    assert.equal(f.store.get<any>('catalog', 'website').revision, f.revision);
    assert.throws(() => evolution.apply({ project: 'website', bottleneck: 'Again', expectedResult: 'Again', files: [{ path: 'engineering/reviewer/SKILL.md', content: 'changed' }] }), /Weekly/);
  } finally { f.close(); }
});
test('organization edits cannot expand authority or publish private context', () => {
  const f = fixture(); try {
    const evolution = new Evolution(f.config, f.store, () => 'published');
    const patch = (path: string, content: string) => ({ project: 'website', bottleneck: 'Observed gap', expectedResult: 'Improve', files: [{ path, content }] });
    assert.throws(() => evolution.apply(patch('governance.yaml', 'changed')), /scope/);
    assert.throws(() => evolution.apply(patch('engineering/reviewer/SKILL.md', '/Users/private/customer')), /private/);
    const config = readFileSync(resolve(f.repo, 'engineering/reviewer/agent.yaml'), 'utf8').replace('read-only', 'workspace-write');
    const legacy = readFileSync(resolve(f.repo, 'engineering/reviewer/temporal.yaml'), 'utf8').replace('read-only', 'workspace-write');
    assert.throws(() => evolution.apply({ ...patch('engineering/reviewer/agent.yaml', config), files: [{ path: 'engineering/reviewer/agent.yaml', content: config }, { path: 'engineering/reviewer/temporal.yaml', content: legacy }] }), /authority/);
  } finally { f.close(); }
});
test('Markdown memory is searchable and refuses path escape and symlinks', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'ceo-memory-')); try {
    const memory = new MarkdownMemory(root); memory.write('projects/site.md', 'Prefer small landing pages and actual traffic data.');
    assert.equal(memory.search('traffic')[0]!.name, 'projects/site.md');
    assert.throws(() => memory.write('../outside.md', 'private'));
    mkdirSync(resolve(root, 'outside')); symlinkSync(resolve(root, 'outside'), resolve(memory.root, 'linked'));
    assert.throws(() => memory.write('linked/private.md', 'private'), /symlink/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('ordinary terminal requests share one authenticated host conversation', async () => {
  const root = mkdtempSync(resolve(tmpdir(), 'ceo-socket-')), seen: string[] = [];
  const server = new ConversationServer(root, async request => {
    if (request.type === 'input') { seen.push(request.text!); return { sameConversation: true }; }
    return { inputs: seen };
  });
  let client: Awaited<ReturnType<typeof connectConversation>> | undefined;
  try {
    await server.start();
    const result = new Promise<any>(async (done, failed) => {
      try { client = await connectConversation(root, record => { if (record.type === 'result') done(record.data); }); client.write(JSON.stringify({ type: 'input', text: 'Maintain both projects' }) + '\n'); }
      catch (error) { failed(error); }
    });
    assert.deepEqual(await result, { sameConversation: true }); assert.deepEqual(seen, ['Maintain both projects']);
  } finally { client?.destroy(); await server.close(); rmSync(root, { recursive: true, force: true }); }
});
