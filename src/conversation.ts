import { Workflow } from './workflow.js';
import type { Decision } from './store.js';

// Founder decisions are parsed outside model tools. Neither a worker message nor
// a generated assistant reply can grant approval.
export function founderDecision(workflow: Workflow, text: string): Decision | undefined {
  const match = text.trim().match(/^\/?(approve|reject|published)\s+([a-f0-9-]{36})(?:\s+([\s\S]*))?$/i);
  if (!match) return undefined;
  return workflow.resolveDecision(match[2]!, match[1]!.toLowerCase() as 'approve' | 'reject' | 'published', match[3] ?? text);
}

const reads = new Set([
  'status', 'agent-context', 'skills list', 'skills get',
  'orchestration run-show', 'orchestration run-current', 'orchestration task-show',
  'orchestration task-list', 'orchestration worker-show', 'orchestration worker-read',
  'orchestration worker-list', 'orchestration gate-show', 'orchestration request-show',
  'linear list-issues', 'linear issue', 'linear list-projects', 'linear list-teams',
]);
export function readCommand(args: string[]): string[] {
  const command = args[0] === 'status' || args[0] === 'agent-context' ? args[0] : args.slice(0, 2).join(' ');
  if (!reads.has(command) || args.some(a => ['--ack', '--from', '--terminal', '--retry-request'].includes(a))) throw new Error('Use a managed coordination tool for mutations and caller identity');
  return args;
}
