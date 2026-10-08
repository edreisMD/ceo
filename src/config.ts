import { chmodSync, mkdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, resolve, sep } from 'node:path';
import { parse } from 'yaml';
import { ConfigSchema, validated, type Config } from './contracts.js';

export const defaultHome = () => process.env.CEO_HOME || resolve(homedir(), '.ceo');
export function privateDirectory(path: string): string {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (statSync(path).uid !== process.getuid?.()) throw new Error('State directory must belong to this user');
  chmodSync(path, 0o700);
  return realpathSync(path);
}
export function inside(root: string, path: string, mustExist = true): string {
  const base = realpathSync(root), target = mustExist ? realpathSync(path) : resolve(path);
  if (target !== base && !target.startsWith(base + sep)) throw new Error('Path escapes its assigned workspace');
  return target;
}
export function loadConfig(path: string): Config {
  const config = validated<Config>(ConfigSchema, parse(readFileSync(path, 'utf8')));
  const ids = new Set<string>();
  for (const project of config.projects) {
    if (ids.has(project.id)) throw new Error('Duplicate project id');
    ids.add(project.id);
    for (const p of [project.sourcePath, project.controlWorkspace, project.catalogPath]) if (!isAbsolute(p)) throw new Error('Project paths must be absolute');
    if (project.defaultBranch.startsWith('-')) throw new Error('Invalid default branch');
  }
  for (const p of [config.stateDir, config.controlWorkspace, config.evolution.catalogPath]) if (!isAbsolute(p)) throw new Error('Configuration paths must be absolute');
  return config;
}
