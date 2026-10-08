import { createServer, createConnection, type Socket, type Server } from 'node:net';
import { chmodSync, existsSync, lstatSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { privateDirectory } from './config.js';

export type SocketRequest = { type: 'input' | 'status' | 'history'; text?: string };
export class ConversationServer {
  readonly path: string;
  readonly tokenPath: string;
  private readonly server: Server;
  private clients = new Set<Socket>();
  readonly token: string;
  constructor(home: string, readonly handle: (request: SocketRequest) => Promise<unknown>) {
    privateDirectory(home);
    this.path = resolve(home, 'conversation.sock'); this.tokenPath = resolve(home, 'conversation.token');
    this.token = randomBytes(32).toString('hex');
    writeFileSync(this.tokenPath, this.token, { mode: 0o600 }); chmodSync(this.tokenPath, 0o600);
    this.server = createServer(socket => this.accept(socket));
  }
  async start(): Promise<void> {
    if (existsSync(this.path)) {
      if (!lstatSync(this.path).isSocket()) throw new Error('Conversation path is not a socket');
      unlinkSync(this.path); // Caller must hold the portfolio lease before constructing this server.
    }
    await new Promise<void>((resolveStart, reject) => { this.server.once('error', reject); this.server.listen(this.path, () => { chmodSync(this.path, 0o600); resolveStart(); }); });
  }
  private accept(socket: Socket): void {
    let buffer = '', authenticated = false, chain = Promise.resolve();
    const timer = setTimeout(() => { if (!authenticated) socket.destroy(); }, 5000);
    socket.on('data', data => {
      buffer += data.toString('utf8');
      if (Buffer.byteLength(buffer) > 65536) { socket.destroy(); return; }
      let index: number;
      while ((index = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
        chain = chain.then(async () => {
          if (socket.destroyed) return;
          const record = JSON.parse(line);
          if (!authenticated) {
            const received = Buffer.from(String(record.token ?? ''));
            const expected = Buffer.from(this.token);
            if (received.length !== expected.length || !timingSafeEqual(received, expected)) { socket.destroy(); return; }
            authenticated = true; clearTimeout(timer); this.clients.add(socket);
            socket.write(JSON.stringify({ type: 'connected' }) + '\n'); return;
          }
          if (!['input', 'status', 'history'].includes(record.type) || (record.type === 'input' && (typeof record.text !== 'string' || record.text.length > 16384))) throw new Error('Invalid conversation request');
          const result = await this.handle(record);
          if (result !== undefined) socket.write(JSON.stringify({ type: 'result', data: result }) + '\n');
        }).catch(error => { if (!socket.destroyed) socket.write(JSON.stringify({ type: 'error', message: String(error) }) + '\n'); });
      }
    });
    socket.on('close', () => { clearTimeout(timer); this.clients.delete(socket); });
    socket.on('error', () => socket.destroy());
  }
  broadcast(type: string, data: unknown): void { for (const socket of this.clients) socket.write(JSON.stringify({ type, data }) + '\n'); }
  async close(): Promise<void> {
    for (const socket of this.clients) socket.destroy();
    await new Promise<void>(resolveClose => this.server.close(() => resolveClose()));
    if (existsSync(this.path)) unlinkSync(this.path);
  }
}
export async function connectConversation(home: string, receive: (value: any) => void): Promise<Socket> {
  const tokenPath = resolve(home, 'conversation.token');
  const metadata = lstatSync(tokenPath);
  if (metadata.isSymbolicLink() || metadata.uid !== process.getuid?.() || (metadata.mode & 0o077)) throw new Error('Conversation credential must be private to this user');
  const token = readFileSync(tokenPath, 'utf8');
  const socket = createConnection(resolve(home, 'conversation.sock'));
  let buffer = '';
  socket.on('data', data => { buffer += data.toString('utf8'); let index: number;
    while ((index = buffer.indexOf('\n')) !== -1) { const line = buffer.slice(0, index); buffer = buffer.slice(index + 1); receive(JSON.parse(line)); } });
  await new Promise<void>((ready, reject) => { socket.once('error', reject); socket.once('connect', ready); });
  socket.write(JSON.stringify({ token }) + '\n');
  return socket;
}
