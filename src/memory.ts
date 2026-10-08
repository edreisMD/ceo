import { lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { inside, privateDirectory } from './config.js';

export interface Memory { read(name: string): string; write(name: string, text: string): void; search(query: string): { name: string; excerpt: string }[]; }
export class MarkdownMemory implements Memory {
  readonly root: string;
  constructor(home: string) { this.root = privateDirectory(resolve(home, 'memory')); }
  private path(name: string): string {
    if (!/^(?:[a-z0-9-]+\/)*[a-z0-9-]+\.md$/.test(name)) throw new Error('Memory names must be relative Markdown paths');
    const path = inside(this.root, resolve(this.root, name), false);
    let parent = dirname(path);
    while (parent !== this.root) {
      try { if (lstatSync(parent).isSymbolicLink()) throw new Error('Memory symlink refused'); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
      parent = dirname(parent);
    }
    try { if (lstatSync(path).isSymbolicLink()) throw new Error('Memory symlink refused'); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    return path;
  }
  read(name: string): string { return readFileSync(this.path(name), 'utf8'); }
  write(name: string, text: string): void {
    if (Buffer.byteLength(text) > 65536) throw new Error('Memory document exceeds 64 KiB');
    const path = this.path(name);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${randomUUID()}.tmp`;
    writeFileSync(temporary, text, { mode: 0o600, flag: 'wx' });
    renameSync(temporary, path);
  }
  search(query: string): { name: string; excerpt: string }[] {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return [];
    const results: { name: string; excerpt: string }[] = [];
    const scan = (directory: string, prefix = '') => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) continue;
        const name = prefix + entry.name;
        if (entry.isDirectory()) scan(resolve(directory, entry.name), name + '/');
        else if (entry.isFile() && entry.name.endsWith('.md')) {
          const text = this.read(name);
          if (terms.every(t => text.toLowerCase().includes(t))) results.push({ name, excerpt: text.slice(0, 1200) });
        }
      }
    };
    scan(this.root);
    return results.slice(0, 10);
  }
}
