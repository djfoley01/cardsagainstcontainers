/**
 * End-to-end tests over a real Socket.IO connection.
 *
 * The unit tests prove redaction is correct as a function. These prove it
 * survives the wire, and that a client cannot act as someone else.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { io as createClient, type Socket as ClientSocket } from 'socket.io-client';
import type { AddressInfo } from 'node:net';
import type { JoinAck, PublicGameState } from '@cac/shared/protocol';
import { build } from './index.ts';

let server: Awaited<ReturnType<typeof build>>;
let url: string;
const open: ClientSocket[] = [];

before(async () => {
  server = await build();
  await server.app.listen({ port: 0, host: '127.0.0.1' });
  const { port } = server.app.server.address() as AddressInfo;
  url = `http://127.0.0.1:${port}`;
});

after(async () => {
  for (const socket of open) socket.close();
  await server.close();
});

function connect(): ClientSocket {
  const socket = createClient(url, { transports: ['websocket'], forceNew: true });
  open.push(socket);
  return socket;
}

/** Resolve on the next occurrence of an event. */
function once<T>(socket: ClientSocket, event: string): Promise<T> {
  return new Promise((resolve) => socket.once(event, resolve as (v: unknown) => void));
}

/** Resolve on the next state whose phase matches, ignoring earlier ones. */
function stateWhere(socket: ClientSocket, predicate: (s: PublicGameState) => boolean): Promise<PublicGameState> {
  return new Promise((resolve) => {
    const handler = (s: PublicGameState) => {
      if (predicate(s)) {
        socket.off('state', handler);
        resolve(s);
      }
    };
    socket.on('state', handler);
  });
}

function emit<T>(socket: ClientSocket, event: string, payload: unknown): Promise<T> {
  return new Promise((resolve) => socket.emit(event, payload, resolve));
}

/**
 * Keeps the most recent state a socket received, so a test can read a player's
 * hand without racing the next broadcast.
 */
interface Tracker {
  latest: PublicGameState | null;
  waitFor(predicate: (s: PublicGameState) => boolean): Promise<PublicGameState>;
}

function track(socket: ClientSocket): Tracker {
  const tracker: Tracker = {
    latest: null,
    waitFor(predicate) {
      if (tracker.latest && predicate(tracker.latest)) return Promise.resolve(tracker.latest);
      return new Promise((resolve) => {
        const handler = (s: PublicGameState) => {
          if (predicate(s)) {
            socket.off('state', handler);
            resolve(s);
          }
        };
        socket.on('state', handler);
      });
    },
  };
  socket.on('state', (s: PublicGameState) => {
    tracker.latest = s;
  });
  return tracker;
}

/** Host plus two others, all joined to a fresh room. */
async function makeRoom(): Promise<{ code: string; sockets: ClientSocket[]; ids: string[] }> {
  const ids = ['player-aaaaaa', 'player-bbbbbb', 'player-cccccc'];
  const host = connect();
  const ack = await emit<JoinAck>(host, 'createRoom', { playerId: ids[0], name: 'ana' });
  assert.ok(ack.ok);
  const code = ack.roomCode;

  const sockets = [host];
  for (const [i, name] of ['ben', 'cy'].entries()) {
    const socket = connect();
    const joined = await emit<JoinAck>(socket, 'join', { roomCode: code, playerId: ids[i + 1], name });
    assert.ok(joined.ok, `join failed: ${JSON.stringify(joined)}`);
    sockets.push(socket);
  }
  return { code, sockets, ids };
}

describe('joining', () => {
  test('creating a room returns a four-letter code and a first state', async () => {
    const socket = connect();
    const statePromise = once<PublicGameState>(socket, 'state');
    const ack = await emit<JoinAck>(socket, 'createRoom', { playerId: 'player-zzzzzz', name: 'zoe' });
    assert.ok(ack.ok);
    assert.match(ack.roomCode, /^[A-HJ-NP-Z]{4}$/);

    const state = await statePromise;
    assert.equal(state.phase, 'lobby');
    assert.equal(state.players.length, 1);
    assert.equal(state.you.isHost, true);
  });

  test('joining an unknown room is refused', async () => {
    const socket = connect();
    const ack = await emit<JoinAck>(socket, 'join', {
      roomCode: 'ZZZZ',
      playerId: 'player-qqqqqq',
      name: 'q',
    });
    assert.equal(ack.ok, false);
    assert.equal(ack.ok === false && ack.code, 'NO_SUCH_ROOM');
  });

  test('a malformed code is refused before any lookup', async () => {
    const socket = connect();
    const ack = await emit<JoinAck>(socket, 'join', { roomCode: 'X', playerId: 'player-wwwwww', name: 'w' });
    assert.equal(ack.ok === false && ack.code, 'BAD_REQUEST');
  });

  test('an empty name or a junk player id is refused', async () => {
    const { code } = await makeRoom();
    const blank = connect();
    const a = await emit<JoinAck>(blank, 'join', { roomCode: code, playerId: 'player-dddddd', name: '   ' });
    assert.equal(a.ok === false && a.code, 'BAD_REQUEST');

    const badId = connect();
    const b = await emit<JoinAck>(badId, 'join', { roomCode: code, playerId: 'no', name: 'nope' });
    assert.equal(b.ok === false && b.code, 'BAD_REQUEST');
  });

  test('a duplicate name is refused', async () => {
    const { code } = await makeRoom();
    const socket = connect();
    const ack = await emit<JoinAck>(socket, 'join', {
      roomCode: code,
      playerId: 'player-eeeeee',
      name: 'ana',
    });
    assert.equal(ack.ok === false && ack.code, 'NAME_TAKEN');
  });

  test('a lowercase code still finds the room', async () => {
    const { code } = await makeRoom();
    const socket = connect();
    const ack = await emit<JoinAck>(socket, 'join', {
      roomCode: code.toLowerCase(),
      playerId: 'player-ffffff',
      name: 'fay',
    });
    assert.equal(ack.ok, true);
  });
});

describe('authority', () => {
  test('a non-host cannot start the game', async () => {
    const { sockets } = await makeRoom();
    const guest = sockets[1]!;
    const errorPromise = once<{ code: string }>(guest, 'actionError');
    guest.emit('action', { type: 'startGame' });
    const error = await errorPromise;
    assert.equal(error.code, 'NOT_HOST');
  });

  test('acting before joining is refused', async () => {
    const socket = connect();
    await once(socket, 'connect');
    const errorPromise = once<{ code: string }>(socket, 'actionError');
    socket.emit('action', { type: 'startGame' });
    const error = await errorPromise;
    assert.equal(error.code, 'BAD_REQUEST');
  });

  test('a player id in the payload is ignored; identity comes from the session', async () => {
    const { sockets } = await makeRoom();
    const guest = sockets[1]!;
    // Try to pass as the host. The action type carries no identity field, so
    // the server has nothing to trust even if a client invents one.
    const errorPromise = once<{ code: string }>(guest, 'actionError');
    guest.emit('action', { type: 'startGame', playerId: 'player-aaaaaa' });
    const error = await errorPromise;
    assert.equal(error.code, 'NOT_HOST', 'impersonation was not rejected');
  });
});

describe('a round over the wire', () => {
  test('judging reveals cards to the czar without revealing who played them', async () => {
    const { sockets, ids } = await makeRoom();
    const trackers = sockets.map(track);

    sockets[0]!.emit('action', { type: 'startGame' });
    const lobby = await trackers[0]!.waitFor((s) => s.phase === 'submitting');

    const czarId = lobby.czarId!;
    const czarIndex = ids.indexOf(czarId);
    const czarSocket = sockets[czarIndex]!;

    // Everyone but the czar plays their first card.
    for (const [i, socket] of sockets.entries()) {
      if (i === czarIndex) continue;
      const state = await trackers[i]!.waitFor((s) => s.phase === 'submitting' && s.you.hand.length > 0);
      socket.emit('action', { type: 'submit', cards: [state.you.hand[0]!.id] });
    }

    const judging = await trackers[czarIndex]!.waitFor((s) => s.phase === 'judging');
    assert.equal(judging.submissions.length, 2);
    for (const submission of judging.submissions) {
      assert.equal(submission.playerId, null, 'the czar was told who played what');
      assert.ok(submission.cards.length > 0);
    }

    // The raw frame must carry no player id alongside the cards.
    const raw = JSON.stringify(judging.submissions);
    for (const id of ids) assert.ok(!raw.includes(id), `${id} leaked over the wire`);

    // The czar picks by index; identities appear only once the round resolves.
    czarSocket.emit('action', { type: 'selectWinner', index: 0 });
    const result = await trackers[czarIndex]!.waitFor((s) => s.phase === 'roundResult');
    assert.ok(result.lastResult);
    assert.ok(result.lastResult.winnerId);
    assert.equal(result.lastResult.submissions.every((sub) => sub.playerId !== null), true);
  });

  test('a non-czar cannot pick the winner', async () => {
    const { sockets, ids } = await makeRoom();
    const trackers = sockets.map(track);

    sockets[0]!.emit('action', { type: 'startGame' });
    const lobby = await trackers[0]!.waitFor((s) => s.phase === 'submitting');
    const czarIndex = ids.indexOf(lobby.czarId!);

    for (const [i, socket] of sockets.entries()) {
      if (i === czarIndex) continue;
      const state = await trackers[i]!.waitFor((s) => s.phase === 'submitting' && s.you.hand.length > 0);
      socket.emit('action', { type: 'submit', cards: [state.you.hand[0]!.id] });
    }

    const impostorIndex = czarIndex === 0 ? 1 : 0;
    const impostor = sockets[impostorIndex]!;
    await trackers[impostorIndex]!.waitFor((s) => s.phase === 'judging');

    const errorPromise = once<{ code: string }>(impostor, 'actionError');
    impostor.emit('action', { type: 'selectWinner', index: 0 });
    assert.equal((await errorPromise).code, 'NOT_CZAR');
  });

  test("no client ever receives another player's hand", async () => {
    const { sockets, ids } = await makeRoom();
    const trackers = sockets.map(track);

    sockets[0]!.emit('action', { type: 'startGame' });
    const views = await Promise.all(
      trackers.map((t) => t.waitFor((s) => s.phase === 'submitting' && s.you.hand.length > 0)),
    );

    const hands = views.map((v) => new Set(v.you.hand.map((c) => c.id)));
    for (const [i, view] of views.entries()) {
      const serialized = JSON.stringify(view);
      for (const [j, hand] of hands.entries()) {
        if (i === j) continue;
        const leaked = [...hand].filter((id) => !hands[i]!.has(id) && serialized.includes(id));
        assert.deepEqual(leaked, [], `player ${ids[i]} received cards from ${ids[j]}`);
      }
    }
  });
});

describe('a whole game', () => {
  test('three players reach game over and can start again', async () => {
    const ids = ['player-g1aaaa', 'player-g2bbbb', 'player-g3cccc'];
    const host = connect();
    const ack = await emit<JoinAck>(host, 'createRoom', { playerId: ids[0], name: 'ana' });
    assert.ok(ack.ok);

    const sockets = [host];
    for (const [i, name] of ['ben', 'cy'].entries()) {
      const socket = connect();
      await emit<JoinAck>(socket, 'join', { roomCode: ack.roomCode, playerId: ids[i + 1], name });
      sockets.push(socket);
    }
    const trackers = sockets.map(track);

    // Short game, no timers: the test drives every transition itself, so a
    // stray deadline can't race the assertions.
    host.emit('action', {
      type: 'updateSettings',
      settings: { pointsToWin: 2, submitTimerMs: null, judgeTimerMs: null },
    });
    await trackers[0]!.waitFor((s) => s.settings.pointsToWin === 2 && s.settings.submitTimerMs === null);

    host.emit('action', { type: 'startGame' });
    await trackers[0]!.waitFor((s) => s.phase === 'submitting');

    let guard = 0;
    while (guard++ < 12) {
      const current = await trackers[0]!.waitFor(
        (s) => s.phase === 'submitting' || s.phase === 'gameOver',
      );
      if (current.phase === 'gameOver') break;

      const czarIndex = ids.indexOf(current.czarId!);
      for (const [i, socket] of sockets.entries()) {
        if (i === czarIndex) continue;
        const view = await trackers[i]!.waitFor(
          (s) => s.phase === 'submitting' && s.round === current.round && s.you.hand.length > 0,
        );
        socket.emit('action', { type: 'submit', cards: view.you.hand.slice(0, view.prompt!.pick).map((c) => c.id) });
      }

      const judging = await trackers[czarIndex]!.waitFor(
        (s) => s.phase === 'judging' && s.round === current.round,
      );
      assert.equal(judging.submissions.length, 2, 'both non-czar players should have played');
      sockets[czarIndex]!.emit('action', { type: 'selectWinner', index: 0 });

      const resolved = await trackers[czarIndex]!.waitFor(
        (s) => s.phase === 'roundResult' || s.phase === 'gameOver',
      );
      assert.ok(resolved.lastResult, 'a resolved round should carry a result');
      assert.ok(resolved.lastResult.winnerName.length > 0, 'the winner should be named');
      if (resolved.phase === 'gameOver') break;

      // Skip the between-round pause rather than waiting it out.
      host.emit('action', { type: 'nextRound' });
    }

    const over = await trackers[0]!.waitFor((s) => s.phase === 'gameOver');
    assert.ok(over.winnerIds.length >= 1, 'game over should name a winner');
    const top = Math.max(...over.players.map((p) => p.score));
    assert.ok(top >= 2, `expected someone to reach 2 points, got ${top}`);
    assert.ok(over.history.length > 0, 'history should record the rounds played');
    // Newest first, as the history panel renders it.
    assert.equal(over.history[0]!.prompt.id, over.lastResult!.prompt.id);

    // And the host can run it back on the same seats.
    host.emit('action', { type: 'startGame' });
    const restarted = await trackers[0]!.waitFor((s) => s.phase === 'submitting' && s.round === 1);
    assert.equal(restarted.players.length, 3);
    assert.deepEqual(restarted.players.map((p) => p.score), [0, 0, 0]);
  });
});

describe('pausing', () => {
  test('any player can hold the clock and everyone sees it', async () => {
    const { sockets, ids } = await makeRoom();
    const trackers = sockets.map(track);

    sockets[0]!.emit('action', { type: 'startGame' });
    await trackers[0]!.waitFor((s) => s.phase === 'submitting');

    // A non-host pauses: this is a party game, not a tournament.
    sockets[2]!.emit('action', { type: 'pause' });

    const views = await Promise.all(trackers.map((t) => t.waitFor((s) => s.paused)));
    for (const view of views) {
      assert.equal(view.paused, true);
      assert.equal(view.deadline, null, 'a held clock should carry no deadline');
      assert.equal(view.pausedBy, 'cy', 'the banner should name who paused');
    }
    void ids;

    sockets[0]!.emit('action', { type: 'resume' });
    const resumed = await trackers[1]!.waitFor((s) => !s.paused);
    assert.notEqual(resumed.deadline, null, 'resume should restore the clock');
  });
});

describe('host overrides', () => {
  test('the host can force a stalled round along', async () => {
    const { sockets, ids } = await makeRoom();
    const trackers = sockets.map(track);

    // Timers off: nothing but the host can unstick this.
    sockets[0]!.emit('action', {
      type: 'updateSettings',
      settings: { submitTimerMs: null, judgeTimerMs: null },
    });
    await trackers[0]!.waitFor((s) => s.settings.submitTimerMs === null);

    sockets[0]!.emit('action', { type: 'startGame' });
    const playing = await trackers[0]!.waitFor((s) => s.phase === 'submitting');

    // Exactly one player submits; the rest go quiet.
    const czarIndex = ids.indexOf(playing.czarId!);
    const mover = czarIndex === 0 ? 1 : 0;
    const view = await trackers[mover]!.waitFor((s) => s.phase === 'submitting' && s.you.hand.length > 0);
    sockets[mover]!.emit('action', { type: 'submit', cards: [view.you.hand[0]!.id] });

    sockets[0]!.emit('action', { type: 'forceAdvance' });
    const judging = await trackers[0]!.waitFor((s) => s.phase === 'judging');
    assert.equal(judging.submissions.length, 1, 'only the one submission should carry over');

    sockets[0]!.emit('action', { type: 'forceAdvance' });
    const done = await trackers[0]!.waitFor((s) => s.phase === 'roundResult');
    assert.equal(done.lastResult!.auto, true);
  });

  test('a non-host cannot force an advance', async () => {
    const { sockets } = await makeRoom();
    const trackers = sockets.map(track);
    sockets[0]!.emit('action', { type: 'startGame' });
    await trackers[1]!.waitFor((s) => s.phase === 'submitting');

    const errorPromise = once<{ code: string }>(sockets[1]!, 'actionError');
    sockets[1]!.emit('action', { type: 'forceAdvance' });
    assert.equal((await errorPromise).code, 'NOT_HOST');
  });

  test('the host can hand over, and loses the powers', async () => {
    const { sockets, ids } = await makeRoom();
    const trackers = sockets.map(track);

    sockets[0]!.emit('action', { type: 'transferHost', targetId: ids[1] });
    const moved = await trackers[1]!.waitFor((s) => s.you.isHost);
    assert.equal(moved.hostId, ids[1]);

    const errorPromise = once<{ code: string }>(sockets[0]!, 'actionError');
    sockets[0]!.emit('action', { type: 'startGame' });
    assert.equal((await errorPromise).code, 'NOT_HOST');
  });
});

describe('presence', () => {
  test('a disconnect shows the player as offline to everyone else', async () => {
    const { sockets, ids } = await makeRoom();
    const watcher = sockets[0]!;
    const offline = stateWhere(watcher, (s) =>
      s.players.some((p) => p.id === ids[2] && !p.connected),
    );
    sockets[2]!.close();
    const state = await offline;
    const player = state.players.find((p) => p.id === ids[2])!;
    assert.equal(player.connected, false);
    // The seat is kept, not removed.
    assert.equal(state.players.length, 3);
  });

  test('rejoining with the same player id restores the seat', async () => {
    const { code, sockets, ids } = await makeRoom();
    sockets[2]!.close();
    await stateWhere(sockets[0]!, (s) => s.players.some((p) => p.id === ids[2] && !p.connected));

    const back = connect();
    // Listen before joining: the server broadcasts synchronously after the
    // ack, so a listener attached afterwards would miss the first state.
    const tracker = track(back);
    const ack = await emit<JoinAck>(back, 'join', {
      roomCode: code,
      playerId: ids[2],
      name: 'cy',
    });
    assert.equal(ack.ok, true, 'rejoin was refused');

    const state = await tracker.waitFor(() => true);
    assert.equal(state.players.length, 3, 'a duplicate seat was created');
    assert.equal(state.players.find((p) => p.id === ids[2])!.connected, true);
  });

  test('a kicked player is told, and stops receiving room state', async () => {
    const { sockets, ids } = await makeRoom();
    const host = sockets[0]!;
    const victim = sockets[2]!;

    const removed = once<string>(victim, 'removed');
    const gone = stateWhere(host, (s) => s.players.length === 2);
    host.emit('action', { type: 'kick', targetId: ids[2] });

    assert.equal(await removed, 'kicked', 'the kicked player was never told');
    const state = await gone;
    assert.ok(!state.players.some((p) => p.id === ids[2]));

    // The victim's socket must be detached: a later broadcast must not reach it.
    let leaked = false;
    victim.on('state', () => {
      leaked = true;
    });
    const rejoined = stateWhere(host, (s) => s.players.length === 3);
    const spare = connect();
    await emit<JoinAck>(spare, 'join', {
      roomCode: state.roomCode,
      playerId: 'player-gggggg',
      name: 'gus',
    });
    await rejoined;
    assert.equal(leaked, false, 'a kicked player still received room state');
  });

  test('leaving removes the seat and tells the client', async () => {
    const { sockets, ids } = await makeRoom();
    const watcher = sockets[0]!;
    const removed = once<string>(sockets[2]!, 'removed');
    const gone = stateWhere(watcher, (s) => s.players.length === 2);

    sockets[2]!.emit('action', { type: 'leave' });
    assert.equal(await removed, 'left');
    const state = await gone;
    assert.ok(!state.players.some((p) => p.id === ids[2]));
  });
});

describe('health', () => {
  test('healthz reports deck sizes and live room count', async () => {
    const res = await fetch(`${url}/healthz`);
    const body = (await res.json()) as {
      ok: boolean;
      rooms: number;
      decks: { id: string; prompts: number; responses: number }[];
    };
    assert.equal(body.ok, true);
    assert.ok(body.rooms >= 1);
    const containers = body.decks.find((d) => d.id === 'containers')!;
    assert.equal(containers.prompts, 103);
    assert.equal(containers.responses, 271);
  });
});
