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
import { watch, type FSWatcher } from 'node:fs';
import { extraDeckDirsFromEnv, loadDecksDetailed } from './decks.ts';
import { RoomRegistry } from './registry.ts';
import { attachSocketHandlers, type GameServer } from './socket.ts';
import { Leaderboard } from './leaderboard.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLIENT_DIST = join(HERE, '..', '..', 'client', 'dist');

const PORT = Number(process.env['PORT'] ?? 3000);
const HOST = process.env['HOST'] ?? '0.0.0.0';

export async function build() {
  const extraDirs = extraDeckDirsFromEnv();
  const initial = loadDecksDetailed({ extraDirs });
  const app = Fastify({ logger: { level: process.env['LOG_LEVEL'] ?? 'info' } });
  const registry = new RoomRegistry(initial.decks);

  for (const problem of initial.problems) app.log.warn(`deck: ${problem}`);
  app.log.info(
    `loaded ${initial.decks.length} deck(s): ${initial.decks.map((d) => d.id).join(', ')}` +
      (extraDirs.length > 0 ? ` (custom deck dirs: ${extraDirs.join(', ')})` : ''),
  );

  /** Re-read every deck directory and hand the result to the registry. */
  function reloadDecks(reason: string): void {
    let result;
    try {
      result = loadDecksDetailed({ extraDirs });
    } catch (err) {
      // Never let a bad reload take down a running server.
      app.log.error(`deck reload failed (${reason}): ${(err as Error).message}`);
      return;
    }
    for (const problem of result.problems) app.log.warn(`deck: ${problem}`);
    const { adopted, unchanged } = registry.setDecks(result.decks);
    app.log.info(
      `decks reloaded (${reason}): ${result.decks.length} deck(s) — ` +
        `${adopted} room(s) updated, ${unchanged} left alone (game in progress)`,
    );
  }

  app.get('/healthz', async () => ({
    ok: true,
    rooms: registry.size,
    decks: registry.deckList.map((d) => ({
      id: d.id,
      prompts: d.prompts.length,
      responses: d.responses.length,
    })),
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

  // Set SHOW_LEADERBOARD=false where surfacing player names on a page anyone
  // can load is not wanted.
  const showLeaderboard = (process.env['SHOW_LEADERBOARD'] ?? 'true') !== 'false';
  const leaderboard = new Leaderboard(Date.now());
  attachSocketHandlers(io, registry, { leaderboard, showLeaderboard });
  registry.startSweeping();
  if (!showLeaderboard) app.log.info('leaderboard disabled by SHOW_LEADERBOARD=false');

  // Watch the custom deck directories so a deck dropped in during the evening
  // takes effect without a restart — a restart would end every game running.
  //
  // Changes are debounced because writers are rarely atomic: an editor saving
  // a file, or a kubelet swapping a ConfigMap's ..data symlink, produces a
  // burst of events, and reloading on each one would read half-written files.
  const watchers: FSWatcher[] = [];
  let debounce: NodeJS.Timeout | null = null;
  for (const dir of extraDirs) {
    try {
      watchers.push(
        watch(dir, { persistent: false }, () => {
          if (debounce) clearTimeout(debounce);
          debounce = setTimeout(() => reloadDecks(`change in ${dir}`), 1_000);
        }),
      );
      app.log.info(`watching ${dir} for deck changes`);
    } catch (err) {
      // A directory that does not exist yet is normal: the ConfigMap may be
      // created after the app. It simply will not hot-reload until a restart.
      app.log.warn(`not watching ${dir}: ${(err as Error).message}`);
    }
  }

  const close = async () => {
    if (debounce) clearTimeout(debounce);
    for (const w of watchers) w.close();
    registry.stop();
    await io.close();
    await app.close();
  };

  return { app, io, registry, close, reloadDecks };
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
