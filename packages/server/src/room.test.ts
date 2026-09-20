import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { DISCONNECT_GRACE_MS } from '@cac/shared/game';
import { loadDecks } from './engine/testkit.ts';
import { Room, REAP_INTERVAL_MS, type Timers } from './room.ts';
import { RoomRegistry, ROOM_IDLE_MS, generateCode } from './registry.ts';
import { ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH } from '@cac/shared/protocol';

const decks = loadDecks();

/** A controllable clock, so timer behaviour is tested without real waiting. */
class FakeTimers implements Timers {
  private time = 1_000;
  private seq = 0;
  private pending = new Map<number, { at: number; fn: () => void }>();

  now = (): number => this.time;

  setTimeout = (fn: () => void, ms: number): unknown => {
    const id = ++this.seq;
    this.pending.set(id, { at: this.time + ms, fn });
    return id;
  };

  clearTimeout = (handle: unknown): void => {
    this.pending.delete(handle as number);
  };

  /** Advance the clock, firing due callbacks in order. */
  advance(ms: number): void {
    const target = this.time + ms;
    for (;;) {
      const due = [...this.pending.entries()]
        .filter(([, t]) => t.at <= target)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      const [id, timer] = due;
      this.pending.delete(id);
      this.time = timer.at;
      timer.fn();
    }
    this.time = target;
  }

  get pendingCount(): number {
    return this.pending.size;
  }
}

function startedRoom(timers: FakeTimers, names = ['ana', 'ben', 'cy'], settings = {}): Room {
  const room = new Room('TEST', decks, settings, timers);
  for (const name of names) room.dispatch({ type: 'join', playerId: name, name });
  room.dispatch({ type: 'startGame', playerId: names[0]! });
  return room;
}

describe('room scheduling', () => {
  test('a submission deadline fires on its own', () => {
    const timers = new FakeTimers();
    const room = startedRoom(timers);
    assert.equal(room.state.phase, 'submitting');

    timers.advance(89_000);
    assert.equal(room.state.phase, 'submitting', 'fired early');

    timers.advance(2_000);
    assert.equal(room.state.phase, 'roundResult', 'deadline did not fire');
    assert.equal(room.state.lastResult!.skipped, true);
    room.close();
  });

  test('the round advances through a full cycle unattended', () => {
    const timers = new FakeTimers();
    const room = startedRoom(timers);
    const prompt = room.state.promptId;

    // Nobody submits, nobody judges: the room should still reach round 2.
    timers.advance(90_000 + 8_000 + 10);
    assert.equal(room.state.round, 2);
    assert.notEqual(room.state.promptId, prompt);
    room.close();
  });

  test('submitting early re-arms the timer for the judging phase', () => {
    const timers = new FakeTimers();
    const room = startedRoom(timers);
    const czar = room.state.czarId!;
    for (const id of room.state.seatOrder) {
      if (id === czar) continue;
      room.dispatch({ type: 'submit', playerId: id, cards: [room.state.players[id]!.hand[0]!] });
    }
    assert.equal(room.state.phase, 'judging');

    timers.advance(59_000);
    assert.equal(room.state.phase, 'judging');
    timers.advance(2_000);
    assert.equal(room.state.phase, 'roundResult');
    assert.equal(room.state.lastResult!.auto, true);
    room.close();
  });

  test('a czar dropping mid-judge resolves after the grace, not the judge timer', () => {
    const timers = new FakeTimers();
    const room = startedRoom(timers, ['ana', 'ben', 'cy'], { judgeTimerMs: null });
    const czar = room.state.czarId!;
    for (const id of room.state.seatOrder) {
      if (id === czar) continue;
      room.dispatch({ type: 'submit', playerId: id, cards: [room.state.players[id]!.hand[0]!] });
    }
    assert.equal(room.state.deadline, null, 'judging should be untimed here');

    room.dispatch({ type: 'disconnect', playerId: czar });
    timers.advance(21_000);
    assert.equal(room.state.phase, 'roundResult');
    room.close();
  });

  test('listeners are notified for timer-driven transitions, not just actions', () => {
    const timers = new FakeTimers();
    const room = startedRoom(timers);
    let notifications = 0;
    room.onChange(() => notifications++);

    timers.advance(91_000);
    assert.ok(notifications > 0, 'timeout did not notify listeners');
    room.close();
  });

  test('reap runs on its own schedule and evicts a long-gone player', () => {
    const timers = new FakeTimers();
    const room = startedRoom(timers, ['ana', 'ben', 'cy', 'di'], {
      submitTimerMs: null,
      judgeTimerMs: null,
    });
    room.dispatch({ type: 'disconnect', playerId: 'di' });

    timers.advance(REAP_INTERVAL_MS);
    assert.ok(room.state.players['di'], 'evicted before the grace period');

    timers.advance(DISCONNECT_GRACE_MS);
    assert.equal(room.state.players['di'], undefined, 'never evicted');
    room.close();
  });

  test('closing a room cancels every pending timer', () => {
    const timers = new FakeTimers();
    const room = startedRoom(timers);
    assert.ok(timers.pendingCount > 0);
    room.close();
    assert.equal(timers.pendingCount, 0);
  });

  test('a closed room refuses further dispatches', () => {
    const timers = new FakeTimers();
    const room = startedRoom(timers);
    room.close();
    assert.throws(() => room.dispatch({ type: 'timeout' }), /closed/);
  });

  test('abandoned only once everyone is gone and the room has gone quiet', () => {
    const timers = new FakeTimers();
    const room = startedRoom(timers);
    assert.equal(room.isAbandoned(ROOM_IDLE_MS), false);

    for (const id of [...room.state.seatOrder]) room.dispatch({ type: 'disconnect', playerId: id });
    assert.equal(room.isAbandoned(ROOM_IDLE_MS), false, 'too eager');

    timers.advance(ROOM_IDLE_MS + 60_000);
    assert.equal(room.isAbandoned(ROOM_IDLE_MS), true);
    room.close();
  });
});

describe('room codes', () => {
  test('are four characters from the unambiguous alphabet', () => {
    for (let i = 0; i < 500; i++) {
      const code = generateCode();
      assert.equal(code.length, ROOM_CODE_LENGTH);
      for (const ch of code) assert.ok(ROOM_CODE_ALPHABET.includes(ch), `bad char ${ch}`);
    }
  });

  test('exclude I and O, which read as 1 and 0 over a video call', () => {
    assert.ok(!ROOM_CODE_ALPHABET.includes('I'));
    assert.ok(!ROOM_CODE_ALPHABET.includes('O'));
  });
});

describe('registry', () => {
  test('creates rooms with distinct codes', () => {
    const timers = new FakeTimers();
    const registry = new RoomRegistry(decks, timers);
    const codes = new Set(Array.from({ length: 50 }, () => registry.create().code));
    assert.equal(codes.size, 50);
    assert.equal(registry.size, 50);
    registry.stop();
  });

  test('retries when a generated code is already taken', () => {
    const timers = new FakeTimers();
    const registry = new RoomRegistry(decks, timers);
    // A generator that returns the same code twice, then a different one.
    const sequence = [0, 0, 0, 0, 0, 0, 0, 0, 0.5, 0.5, 0.5, 0.5];
    let i = 0;
    const rand = () => sequence[i++ % sequence.length]!;

    const first = registry.create({}, rand);
    const second = registry.create({}, rand);
    assert.notEqual(first.code, second.code);
    registry.stop();
  });

  test('lookup is case-insensitive and tolerates whitespace', () => {
    const timers = new FakeTimers();
    const registry = new RoomRegistry(decks, timers);
    const room = registry.create();
    assert.equal(registry.get(room.code.toLowerCase())?.code, room.code);
    assert.equal(registry.get(`  ${room.code}  `)?.code, room.code);
    assert.equal(registry.get('ZZZZ'), undefined);
    registry.stop();
  });

  test('sweeps abandoned rooms but keeps live ones', () => {
    const timers = new FakeTimers();
    const registry = new RoomRegistry(decks, timers);
    const dead = registry.create();
    const live = registry.create();
    live.dispatch({ type: 'join', playerId: 'ana', name: 'ana' });

    timers.advance(ROOM_IDLE_MS + 60_000);
    const removed = registry.sweep();
    assert.equal(removed, 1);
    assert.equal(registry.get(dead.code), undefined);
    assert.ok(registry.get(live.code));
    registry.stop();
  });

  test('stop closes every room', () => {
    const timers = new FakeTimers();
    const registry = new RoomRegistry(decks, timers);
    registry.create();
    registry.create();
    registry.stop();
    assert.equal(registry.size, 0);
    assert.equal(timers.pendingCount, 0);
  });
});
