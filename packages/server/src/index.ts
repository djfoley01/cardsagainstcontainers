/**
 * Server entry point: Fastify for HTTP, Socket.IO for the game.
 *
 * One process serves both the built client and the game socket, which is the
 * whole reason room state can live in memory. See docs/adr-001-hosting.md.
 */
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { Server } from 'socket.io';
import { loadDecks } from './decks.ts';
import { RoomRegistry } from './registry.ts';
import { attachSocketHandlers, type GameServer } from './socket.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLIENT_DIST = join(HERE, '..', '..', 'client', 'dist');

const PORT = Number(process.env['PORT'] ?? 3000);
const HOST = process.env['HOST'] ?? '0.0.0.0';

export async function build() {
  const decks = loadDecks();
  const app = Fastify({ logger: { level: process.env['LOG_LEVEL'] ?? 'info' } });
  const registry = new RoomRegistry(decks);

  app.get('/healthz', async () => ({
    ok: true,
    rooms: registry.size,
    decks: decks.map((d) => ({ id: d.id, prompts: d.prompts.length, responses: d.responses.length })),
  }));

  // The client build won't exist until milestone 4; serving it is optional so
  // the server can run standalone before then.
  if (existsSync(CLIENT_DIST)) {
    await app.register(fastifyStatic, { root: CLIENT_DIST });
    // Single-page app: unknown paths fall through to index.html so a shared
    // /room/ABCD link works on a cold load.
    app.setNotFoundHandler((_req, reply) => reply.sendFile('index.html'));
  } else {
    app.log.warn(`client build not found at ${CLIENT_DIST}; serving API only`);
  }

  await app.ready();

  const io: GameServer = new Server(app.server, {
    // Long-polling stays enabled on purpose: it is the fallback that keeps the
    // game working for players behind corporate proxies that block WebSocket
    // upgrades. See docs/adr-001-hosting.md.
    transports: ['websocket', 'polling'],
    cors: { origin: process.env['CORS_ORIGIN'] ?? true },
  });

  attachSocketHandlers(io, registry);
  registry.startSweeping();

  const close = async () => {
    registry.stop();
    await io.close();
    await app.close();
  };

  return { app, io, registry, close };
}

// Only start listening when run directly, so tests can import build().
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  // Signal handlers go up BEFORE any async startup work.
  //
  // In a container this process is PID 1, and the kernel discards signals that
  // PID 1 has no handler for. Registering these after `listen()` leaves a
  // window during boot where SIGTERM is silently dropped, so a pod deleted
  // mid-startup hangs until the grace period expires and it is SIGKILLed.
  let closing = false;
  let shutdown: (() => Promise<void>) | null = null;

  const handle = (signal: string) => {
    if (closing) return;
    closing = true;
    console.log(`${signal} received, shutting down`);
    // Nothing to close yet means the signal landed mid-boot: just leave.
    if (!shutdown) process.exit(0);
    void shutdown().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => handle(signal));
  }

  const { app, close } = await build();
  shutdown = close;
  // A signal that arrived while build() was running still needs honouring.
  if (closing) {
    await close();
    process.exit(0);
  }

  await app.listen({ port: PORT, host: HOST });
}
