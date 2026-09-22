import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  CZAR_GRACE_MS,
  DISCONNECT_GRACE_MS,
  GameError,
  MAX_PLAYERS,
  type GameState,
} from '@cac/shared/game';
import { ROUND_RESULT_MS } from './reduce.ts';
import { blockedTerm } from '@cac/shared/content-filter';
import { Harness, countPrompts, countResponses, loadDecks, tinyDeck } from './testkit.ts';

const decks = loadDecks();

/** Assert a dispatch throws a GameError with a specific code. */
function assertCode(fn: () => unknown, code: string): void {
  assert.throws(fn, (err: unknown) => err instanceof GameError && err.code === code);
}

function startedGame(names = ['ana', 'ben', 'cy'], settings = {}): Harness {
  const h = new Harness(decks, settings);
  h.join(...names);
  h.dispatch({ type: 'startGame', playerId: names[0]! });
  return h;
}

describe('lobby', () => {
  test('first player becomes host, others do not', () => {
    const h = new Harness(decks);
    h.join('ana', 'ben');
    assert.equal(h.state.hostId, 'ana');
    assert.equal(h.state.seatOrder.length, 2);
  });

  test('rejects duplicate names case-insensitively', () => {
    const h = new Harness(decks);
    h.join('ana');
    assertCode(() => h.dispatch({ type: 'join', playerId: 'x', name: 'ANA' }), 'NAME_TAKEN');
  });

  test('rejects players past the room cap', () => {
    const h = new Harness(decks);
    h.join(...Array.from({ length: MAX_PLAYERS }, (_, i) => `p${i}`));
    assertCode(() => h.dispatch({ type: 'join', playerId: 'extra', name: 'extra' }), 'ROOM_FULL');
  });

  test('refuses to start below the player minimum', () => {
    const h = new Harness(decks);
    h.join('ana', 'ben');
    assertCode(() => h.dispatch({ type: 'startGame', playerId: 'ana' }), 'NOT_ENOUGH_PLAYERS');
  });

  test('only the host may start or change settings', () => {
    const h = new Harness(decks);
    h.join('ana', 'ben', 'cy');
    assertCode(() => h.dispatch({ type: 'startGame', playerId: 'ben' }), 'NOT_HOST');
    assertCode(
      () => h.dispatch({ type: 'updateSettings', playerId: 'ben', settings: { handSize: 5 } }),
      'NOT_HOST',
    );
  });

  test('enabling a second deck grows the draw piles', () => {
    const h = new Harness(decks);
    h.join('ana');
    const before = h.state.responseDraw.length;
    h.dispatch({ type: 'updateSettings', playerId: 'ana', settings: { deckIds: ['containers', 'sales'] } });

    // Derived rather than hardcoded: the expected total is the union of both
    // decks' answer text, since pile-level deduping drops the handful the two
    // upstream decks happen to share ("Artificial Intelligence", "Giving
    // 110%", ...). A literal here goes stale every time a deck changes.
    const containers = decks.find((d) => d.id === 'containers')!;
    const sales = decks.find((d) => d.id === 'sales')!;
    const union = new Set(
      [...containers.responses, ...sales.responses].map((r) => r.text.toLowerCase()),
    );
    assert.equal(before, containers.responses.length);
    assert.equal(h.state.responseDraw.length, union.size);
    assert.equal(h.state.promptDraw.length, containers.prompts.length + sales.prompts.length);
  });

  test('rejects nonsense settings', () => {
    const h = new Harness(decks);
    h.join('ana');
    assertCode(
      () => h.dispatch({ type: 'updateSettings', playerId: 'ana', settings: { deckIds: [] } }),
      'INVALID_SETTINGS',
    );
    assertCode(
      () => h.dispatch({ type: 'updateSettings', playerId: 'ana', settings: { handSize: 99 } }),
      'INVALID_SETTINGS',
    );
  });
});

describe('starting a game', () => {
  test('deals a full hand to everyone and picks a czar and prompt', () => {
    const h = startedGame();
    assert.equal(h.state.phase, 'submitting');
    assert.equal(h.state.round, 1);
    assert.ok(h.state.czarId);
    assert.ok(h.state.promptId);
    for (const id of h.state.seatOrder) {
      assert.equal(h.state.players[id]!.hand.length, 10);
    }
  });

  test('sets a submission deadline from settings, or none when disabled', () => {
    const timed = startedGame();
    assert.equal(timed.state.deadline, timed.ctx.now + 90_000);

    const untimed = startedGame(['ana', 'ben', 'cy'], { submitTimerMs: null });
    assert.equal(untimed.state.deadline, null);
  });
});

describe('submitting', () => {
  test('the czar cannot submit', () => {
    const h = startedGame();
    const czar = h.state.czarId!;
    const card = h.state.players[czar]!.hand[0]!;
    assertCode(() => h.dispatch({ type: 'submit', playerId: czar, cards: [card] }), 'IS_CZAR');
  });

  test('rejects the wrong number of cards', () => {
    const h = startedGame();
    const player = h.state.seatOrder.find((id) => id !== h.state.czarId)!;
    const hand = h.state.players[player]!.hand;
    assertCode(
      () => h.dispatch({ type: 'submit', playerId: player, cards: hand.slice(0, 2) }),
      'BAD_SUBMISSION',
    );
  });

  test('rejects cards the player does not hold', () => {
    const h = startedGame();
    const player = h.state.seatOrder.find((id) => id !== h.state.czarId)!;
    assertCode(
      () => h.dispatch({ type: 'submit', playerId: player, cards: ['c-r-999'] }),
      'BAD_SUBMISSION',
    );
  });

  test('rejects the same card played twice on a pick-2 prompt', () => {
    const h = new Harness([tinyDeck(5, 60, 2)], { deckIds: ['tiny'] });
    h.join('ana', 'ben', 'cy');
    h.dispatch({ type: 'startGame', playerId: 'ana' });
    const player = h.state.seatOrder.find((id) => id !== h.state.czarId)!;
    const card = h.state.players[player]!.hand[0]!;
    assertCode(
      () => h.dispatch({ type: 'submit', playerId: player, cards: [card, card] }),
      'BAD_SUBMISSION',
    );
  });

  test('rejects submitting twice', () => {
    const h = startedGame();
    const player = h.state.seatOrder.find((id) => id !== h.state.czarId)!;
    const hand = h.state.players[player]!.hand;
    h.dispatch({ type: 'submit', playerId: player, cards: [hand[0]!] });
    assertCode(
      () => h.dispatch({ type: 'submit', playerId: player, cards: [hand[1]!] }),
      'ALREADY_SUBMITTED',
    );
  });

  test('unsubmit returns the exact cards to hand', () => {
    const h = startedGame();
    const player = h.state.seatOrder.find((id) => id !== h.state.czarId)!;
    const before = [...h.state.players[player]!.hand];
    h.dispatch({ type: 'submit', playerId: player, cards: [before[0]!] });
    assert.equal(h.state.players[player]!.hand.length, 9);
    h.dispatch({ type: 'unsubmit', playerId: player });
    assert.deepEqual([...h.state.players[player]!.hand].sort(), [...before].sort());
  });

  test('judging begins only once every non-czar player has submitted', () => {
    const h = startedGame(['ana', 'ben', 'cy', 'di']);
    const others = h.state.seatOrder.filter((id) => id !== h.state.czarId);
    for (const id of others.slice(0, -1)) {
      h.dispatch({ type: 'submit', playerId: id, cards: [h.state.players[id]!.hand[0]!] });
      assert.equal(h.state.phase, 'submitting');
    }
    const last = others.at(-1)!;
    h.dispatch({ type: 'submit', playerId: last, cards: [h.state.players[last]!.hand[0]!] });
    assert.equal(h.state.phase, 'judging');
    assert.equal(h.state.revealOrder.length, others.length);
  });
});

describe('judging', () => {
  test('only the czar may pick a winner', () => {
    const h = startedGame();
    h.submitAll();
    const notCzar = h.state.seatOrder.find((id) => id !== h.state.czarId)!;
    assertCode(
      () => h.dispatch({ type: 'selectWinner', playerId: notCzar, winnerId: notCzar }),
      'NOT_CZAR',
    );
  });

  test('the czar cannot pick someone who did not submit', () => {
    const h = startedGame();
    h.submitAll();
    assertCode(
      () => h.dispatch({ type: 'selectWinner', playerId: h.state.czarId!, winnerId: h.state.czarId! }),
      'NO_SUCH_SUBMISSION',
    );
  });

  test('picking a winner scores a point and records history', () => {
    const h = startedGame();
    h.submitAll();
    const winner = h.state.submissions[0]!.playerId;
    h.dispatch({ type: 'selectWinner', playerId: h.state.czarId!, winnerId: winner });
    assert.equal(h.state.phase, 'roundResult');
    assert.equal(h.state.players[winner]!.score, 1);
    assert.equal(h.state.history.length, 1);
    assert.equal(h.state.lastResult!.winnerId, winner);
    assert.equal(h.state.lastResult!.auto, false);
  });
});

describe('czar rotation', () => {
  test('rotates to the next seat each round', () => {
    const h = startedGame(['ana', 'ben', 'cy']);
    const seen: string[] = [];
    for (let i = 0; i < 3; i++) {
      seen.push(h.state.czarId!);
      h.submitAll();
      h.dispatch({ type: 'selectWinner', playerId: h.state.czarId!, winnerId: h.state.submissions[0]!.playerId });
      h.fireDeadline();
    }
    assert.deepEqual(seen, h.state.seatOrder);
  });

  test('skips a disconnected seat without losing the rotation', () => {
    const h = startedGame(['ana', 'ben', 'cy', 'di']);
    const order = h.state.seatOrder;
    const first = h.state.czarId!;
    const shouldBeNext = order[(order.indexOf(first) + 1) % order.length]!;

    h.dispatch({ type: 'disconnect', playerId: shouldBeNext });
    h.submitAll();
    h.dispatch({ type: 'selectWinner', playerId: first, winnerId: h.state.submissions[0]!.playerId });
    h.fireDeadline();

    const expected = order[(order.indexOf(shouldBeNext) + 1) % order.length]!;
    assert.equal(h.state.czarId, expected);
  });
});

describe('disconnects', () => {
  test('a disconnected player no longer blocks judging', () => {
    const h = startedGame(['ana', 'ben', 'cy', 'di']);
    const others = h.state.seatOrder.filter((id) => id !== h.state.czarId);
    const [absent, ...present] = others;
    for (const id of present) {
      h.dispatch({ type: 'submit', playerId: id, cards: [h.state.players[id]!.hand[0]!] });
    }
    assert.equal(h.state.phase, 'submitting');
    h.dispatch({ type: 'disconnect', playerId: absent! });
    assert.equal(h.state.phase, 'judging');
  });

  test('a czar dropping mid-judge sets a grace deadline even with timers off', () => {
    const h = startedGame(['ana', 'ben', 'cy'], { submitTimerMs: null, judgeTimerMs: null });
    h.submitAll();
    assert.equal(h.state.deadline, null);
    h.dispatch({ type: 'disconnect', playerId: h.state.czarId! });
    assert.equal(h.state.deadline, h.ctx.now + CZAR_GRACE_MS);

    h.fireDeadline();
    assert.equal(h.state.phase, 'roundResult');
    assert.equal(h.state.lastResult!.auto, true);
    assert.ok(h.state.lastResult!.winnerId);
  });

  test('the czar grace never pushes an existing deadline later', () => {
    const h = startedGame(['ana', 'ben', 'cy'], { judgeTimerMs: 5_000 });
    h.submitAll();
    const judgeDeadline = h.state.deadline!;
    h.dispatch({ type: 'disconnect', playerId: h.state.czarId! });
    assert.equal(h.state.deadline, judgeDeadline);
  });

  test('reconnecting restores the same seat, hand and score', () => {
    const h = startedGame();
    const player = h.state.seatOrder.find((id) => id !== h.state.czarId)!;
    const hand = [...h.state.players[player]!.hand];
    h.dispatch({ type: 'disconnect', playerId: player });
    h.dispatch({ type: 'reconnect', playerId: player });
    assert.equal(h.state.players[player]!.connected, true);
    assert.deepEqual(h.state.players[player]!.hand, hand);
  });

  test('rejoining with a new name adopts it', () => {
    const h = startedGame();
    const player = h.state.seatOrder.find((id) => id !== h.state.czarId)!;
    h.dispatch({ type: 'disconnect', playerId: player });
    h.dispatch({ type: 'join', playerId: player, name: 'renamed' });
    assert.equal(h.state.players[player]!.name, 'renamed');
  });

  test('rejoining keeps the old name when the new one is taken', () => {
    const h = startedGame(['ana', 'ben', 'cy']);
    h.dispatch({ type: 'disconnect', playerId: 'cy' });
    h.dispatch({ type: 'join', playerId: 'cy', name: 'ana' });
    assert.equal(h.state.players['cy']!.name, 'cy', 'a duplicate name was allowed');
    assert.equal(h.state.players['ana']!.name, 'ana');
  });

  test('rejoining with the same id is a reconnect, not a new seat', () => {
    const h = startedGame();
    const player = h.state.seatOrder.find((id) => id !== h.state.czarId)!;
    const seats = h.state.seatOrder.length;
    h.dispatch({ type: 'disconnect', playerId: player });
    h.dispatch({ type: 'join', playerId: player, name: 'whatever' });
    assert.equal(h.state.seatOrder.length, seats);
    assert.equal(h.state.players[player]!.connected, true);
  });

  test('reap evicts only players past the grace period', () => {
    const h = startedGame(['ana', 'ben', 'cy', 'di']);
    const player = h.state.seatOrder.find((id) => id !== h.state.czarId)!;
    h.dispatch({ type: 'disconnect', playerId: player });

    h.advance(DISCONNECT_GRACE_MS - 1);
    h.dispatch({ type: 'reap' });
    assert.ok(h.state.players[player], 'evicted too early');

    h.advance(2);
    h.dispatch({ type: 'reap' });
    assert.equal(h.state.players[player], undefined);
  });
});

describe('host migration', () => {
  test('host leaving promotes the longest-serving player', () => {
    const h = startedGame(['ana', 'ben', 'cy', 'di']);
    assert.equal(h.state.hostId, 'ana');
    h.dispatch({ type: 'leave', playerId: 'ana' });
    assert.equal(h.state.hostId, 'ben');
  });

  test('the host cannot kick themselves', () => {
    const h = startedGame();
    assertCode(() => h.dispatch({ type: 'kick', playerId: 'ana', targetId: 'ana' }), 'NOT_HOST');
  });

  test('host is null once everyone has left', () => {
    const h = new Harness(decks);
    h.join('ana');
    h.dispatch({ type: 'leave', playerId: 'ana' });
    assert.equal(h.state.hostId, null);
  });
});

describe('timeouts', () => {
  test('submission timeout with no submissions discards the round', () => {
    const h = startedGame();
    h.fireDeadline();
    assert.equal(h.state.phase, 'roundResult');
    assert.equal(h.state.lastResult!.skipped, true);
    assert.equal(h.state.lastResult!.winnerId, '');
    for (const p of Object.values(h.state.players)) assert.equal(p.score, 0);
  });

  test('submission timeout with partial submissions judges what came in', () => {
    const h = startedGame(['ana', 'ben', 'cy', 'di']);
    const one = h.state.seatOrder.find((id) => id !== h.state.czarId)!;
    h.dispatch({ type: 'submit', playerId: one, cards: [h.state.players[one]!.hand[0]!] });
    h.fireDeadline();
    assert.equal(h.state.phase, 'judging');
    assert.equal(h.state.submissions.length, 1);
  });

  test('judging timeout picks a winner automatically', () => {
    const h = startedGame();
    h.submitAll();
    h.fireDeadline();
    assert.equal(h.state.phase, 'roundResult');
    assert.equal(h.state.lastResult!.auto, true);
    assert.equal(h.state.players[h.state.lastResult!.winnerId]!.score, 1);
  });

  test('round result auto-advances to the next round', () => {
    const h = startedGame();
    h.submitAll();
    h.dispatch({ type: 'selectWinner', playerId: h.state.czarId!, winnerId: h.state.submissions[0]!.playerId });
    assert.equal(h.state.deadline, h.ctx.now + ROUND_RESULT_MS);
    h.fireDeadline();
    assert.equal(h.state.phase, 'submitting');
    assert.equal(h.state.round, 2);
  });
});

describe('pausing', () => {
  test('holds the clock and restores the exact time left', () => {
    const h = startedGame();
    const deadline = h.state.deadline!;
    h.advance(30_000);

    h.dispatch({ type: 'pause', playerId: 'ana' });
    assert.equal(h.state.paused, true);
    assert.equal(h.state.deadline, null, 'a held clock has no wall-clock deadline');
    assert.equal(h.state.pausedRemainingMs, deadline - h.ctx.now);

    // Time passing while paused must not consume the round.
    const remaining = h.state.pausedRemainingMs!;
    h.advance(10 * 60_000);
    h.dispatch({ type: 'resume', playerId: 'ana' });
    assert.equal(h.state.paused, false);
    assert.equal(h.state.deadline, h.ctx.now + remaining);
    assert.equal(h.state.phase, 'submitting', 'the round expired while paused');
  });

  test('any player may pause, not just the host', () => {
    const h = startedGame();
    const guest = h.state.seatOrder[1]!;
    h.dispatch({ type: 'pause', playerId: guest });
    assert.equal(h.state.paused, true);
    assert.equal(h.state.pausedBy, guest);
  });

  test('a stranger cannot pause', () => {
    const h = startedGame();
    assertCode(() => h.dispatch({ type: 'pause', playerId: 'nobody' }), 'UNKNOWN_PLAYER');
  });

  test('pausing is not available in the lobby or after the game', () => {
    const h = new Harness(decks);
    h.join('ana', 'ben', 'cy');
    assertCode(() => h.dispatch({ type: 'pause', playerId: 'ana' }), 'WRONG_PHASE');
  });

  test('pausing and resuming twice is harmless', () => {
    const h = startedGame();
    h.dispatch({ type: 'pause', playerId: 'ana' });
    const remaining = h.state.pausedRemainingMs;
    h.dispatch({ type: 'pause', playerId: 'ben' });
    assert.equal(h.state.pausedRemainingMs, remaining, 'a second pause moved the clock');
    assert.equal(h.state.pausedBy, 'ana', 'a second pause stole the attribution');

    h.dispatch({ type: 'resume', playerId: 'ben' });
    h.dispatch({ type: 'resume', playerId: 'ben' });
    assert.equal(h.state.paused, false);
  });

  test('works on the round result, which is where people want it', () => {
    const h = startedGame();
    h.submitAll();
    h.dispatch({ type: 'selectWinner', playerId: h.state.czarId!, winnerId: h.state.submissions[0]!.playerId });
    assert.equal(h.state.phase, 'roundResult');

    h.dispatch({ type: 'pause', playerId: 'ana' });
    h.advance(5 * 60_000);
    h.dispatch({ type: 'timeout' });
    assert.equal(h.state.phase, 'roundResult', 'the next round started while paused');

    h.dispatch({ type: 'resume', playerId: 'ana' });
    h.fireDeadline();
    assert.equal(h.state.phase, 'submitting');
  });

  test('a phase entered while paused banks its time instead of starting it', () => {
    const h = startedGame(['ana', 'ben', 'cy', 'di']);
    h.dispatch({ type: 'pause', playerId: 'ana' });
    h.submitAll();

    assert.equal(h.state.phase, 'judging');
    assert.equal(h.state.deadline, null, 'judging started its clock despite the pause');
    assert.equal(h.state.pausedRemainingMs, 60_000, 'the judge timer was not banked');

    h.dispatch({ type: 'resume', playerId: 'ana' });
    assert.equal(h.state.deadline, h.ctx.now + 60_000);
  });

  test('a czar dropping while paused banks the grace rather than starting it', () => {
    const h = startedGame(['ana', 'ben', 'cy'], { judgeTimerMs: null });
    h.submitAll();
    h.dispatch({ type: 'pause', playerId: h.state.seatOrder[0]! });
    h.dispatch({ type: 'disconnect', playerId: h.state.czarId! });

    assert.equal(h.state.deadline, null, 'the grace ticked during a pause');
    assert.equal(h.state.pausedRemainingMs, CZAR_GRACE_MS);

    h.dispatch({ type: 'resume', playerId: h.state.seatOrder[0]! });
    h.fireDeadline();
    assert.equal(h.state.phase, 'roundResult');
  });

  test('the grace still cannot extend a shorter running judge timer', () => {
    const h = startedGame(['ana', 'ben', 'cy'], { judgeTimerMs: 5_000 });
    h.submitAll();
    const judgeDeadline = h.state.deadline!;
    h.dispatch({ type: 'disconnect', playerId: h.state.czarId! });
    assert.equal(h.state.deadline, judgeDeadline);
  });

  test('players are not evicted while the game is paused', () => {
    const h = startedGame(['ana', 'ben', 'cy', 'di']);
    const player = h.state.seatOrder.find((id) => id !== h.state.czarId)!;
    h.dispatch({ type: 'disconnect', playerId: player });
    h.dispatch({ type: 'pause', playerId: 'ana' });

    h.advance(DISCONNECT_GRACE_MS * 3);
    h.dispatch({ type: 'reap' });
    assert.ok(h.state.players[player], 'a paused game evicted a player');

    h.dispatch({ type: 'resume', playerId: 'ana' });
    h.advance(DISCONNECT_GRACE_MS);
    h.dispatch({ type: 'reap' });
    assert.equal(h.state.players[player], undefined);
  });

  test('an untimed phase can still be paused and resumed', () => {
    const h = startedGame(['ana', 'ben', 'cy'], { submitTimerMs: null });
    assert.equal(h.state.deadline, null);
    h.dispatch({ type: 'pause', playerId: 'ana' });
    assert.equal(h.state.paused, true);
    assert.equal(h.state.pausedRemainingMs, null);

    h.dispatch({ type: 'resume', playerId: 'ana' });
    assert.equal(h.state.deadline, null, 'resume invented a deadline');
    assert.equal(h.state.phase, 'submitting');
  });

  test('starting a new game clears a held clock', () => {
    const h = startedGame();
    h.dispatch({ type: 'pause', playerId: 'ana' });
    h.dispatch({ type: 'endGame', playerId: 'ana' });
    assert.equal(h.state.paused, false, 'game over left the clock held');

    h.dispatch({ type: 'startGame', playerId: 'ana' });
    assert.equal(h.state.paused, false);
    assert.notEqual(h.state.deadline, null);
  });

  test('play continues normally while paused', () => {
    const h = startedGame(['ana', 'ben', 'cy', 'di']);
    h.dispatch({ type: 'pause', playerId: 'ana' });
    // A pause holds the clock, not the game: people can still play their cards.
    h.submitAll();
    assert.equal(h.state.phase, 'judging');
    h.dispatch({ type: 'selectWinner', playerId: h.state.czarId!, winnerId: h.state.submissions[0]!.playerId });
    assert.equal(h.state.phase, 'roundResult');
    assert.equal(h.state.paused, true, 'the pause was lost mid-round');
  });
});

describe('host overrides', () => {
  test('forces a stalled submitting round into judging', () => {
    // Timers off is exactly when a game can wedge on one quiet player.
    const h = startedGame(['ana', 'ben', 'cy', 'di'], { submitTimerMs: null, judgeTimerMs: null });
    const one = h.state.seatOrder.find((id) => id !== h.state.czarId)!;
    h.dispatch({ type: 'submit', playerId: one, cards: [h.state.players[one]!.hand[0]!] });
    assert.equal(h.state.phase, 'submitting');
    assert.equal(h.state.deadline, null, 'no clock will rescue this round');

    h.dispatch({ type: 'forceAdvance', playerId: 'ana' });
    assert.equal(h.state.phase, 'judging');
    assert.equal(h.state.submissions.length, 1);
  });

  test('forces a stalled judging round to a result', () => {
    const h = startedGame(['ana', 'ben', 'cy'], { submitTimerMs: null, judgeTimerMs: null });
    h.submitAll();
    assert.equal(h.state.phase, 'judging');

    h.dispatch({ type: 'forceAdvance', playerId: 'ana' });
    assert.equal(h.state.phase, 'roundResult');
    assert.equal(h.state.lastResult!.auto, true);
  });

  test('discards a round nobody played', () => {
    const h = startedGame(['ana', 'ben', 'cy'], { submitTimerMs: null });
    h.dispatch({ type: 'forceAdvance', playerId: 'ana' });
    assert.equal(h.state.phase, 'roundResult');
    assert.equal(h.state.lastResult!.skipped, true);
  });

  test('works even while paused, because that is the point of it', () => {
    const h = startedGame(['ana', 'ben', 'cy'], { submitTimerMs: null, judgeTimerMs: null });
    h.submitAll();
    h.dispatch({ type: 'pause', playerId: 'ana' });
    h.dispatch({ type: 'forceAdvance', playerId: 'ana' });
    assert.equal(h.state.phase, 'roundResult', 'a paused game could not be rescued');
  });

  test('only the host may force an advance', () => {
    const h = startedGame();
    assertCode(() => h.dispatch({ type: 'forceAdvance', playerId: 'ben' }), 'NOT_HOST');
  });

  test('the host can hand off to another connected player', () => {
    const h = startedGame();
    h.dispatch({ type: 'transferHost', playerId: 'ana', targetId: 'ben' });
    assert.equal(h.state.hostId, 'ben');
    // And the old host is now an ordinary player.
    assertCode(() => h.dispatch({ type: 'forceAdvance', playerId: 'ana' }), 'NOT_HOST');
  });

  test('cannot hand off to someone offline or absent', () => {
    const h = startedGame();
    h.dispatch({ type: 'disconnect', playerId: 'ben' });
    assertCode(() => h.dispatch({ type: 'transferHost', playerId: 'ana', targetId: 'ben' }), 'UNKNOWN_PLAYER');
    assertCode(() => h.dispatch({ type: 'transferHost', playerId: 'ana', targetId: 'nobody' }), 'UNKNOWN_PLAYER');
  });
});

describe('settings during play', () => {
  test('timers can be changed mid-game', () => {
    const h = startedGame();
    h.dispatch({ type: 'updateSettings', playerId: 'ana', settings: { submitTimerMs: 30_000 } });
    assert.equal(h.state.settings.submitTimerMs, 30_000);
  });

  test('the score target can be raised mid-game', () => {
    const h = startedGame(['ana', 'ben', 'cy'], { pointsToWin: 3 });
    h.dispatch({ type: 'updateSettings', playerId: 'ana', settings: { pointsToWin: 10 } });
    assert.equal(h.state.settings.pointsToWin, 10);
    assert.equal(h.state.phase, 'submitting');
  });

  test('lowering the target below a score ends the game immediately', () => {
    const h = startedGame(['ana', 'ben', 'cy'], { pointsToWin: 10 });
    h.submitAll();
    const winner = h.state.submissions[0]!.playerId;
    h.dispatch({ type: 'selectWinner', playerId: h.state.czarId!, winnerId: winner });
    assert.equal(h.state.players[winner]!.score, 1);

    h.dispatch({ type: 'updateSettings', playerId: 'ana', settings: { pointsToWin: 1 } });
    assert.equal(h.state.phase, 'gameOver');
    assert.deepEqual(h.state.winnerIds, [winner]);
  });

  test('decks and hand size cannot change under live hands', () => {
    const h = startedGame();
    assertCode(
      () => h.dispatch({ type: 'updateSettings', playerId: 'ana', settings: { deckIds: ['containers', 'sales'] } }),
      'WRONG_PHASE',
    );
    assertCode(
      () => h.dispatch({ type: 'updateSettings', playerId: 'ana', settings: { handSize: 5 } }),
      'WRONG_PHASE',
    );
  });

  test('decks can still be changed back in the lobby', () => {
    const h = new Harness(decks);
    h.join('ana', 'ben', 'cy');
    h.dispatch({ type: 'updateSettings', playerId: 'ana', settings: { deckIds: ['containers', 'sales'] } });
    assert.equal(h.state.promptDraw.length, 103 + 79);
  });
});

describe('ending', () => {
  test('reaching the point target ends the game', () => {
    const h = startedGame(['ana', 'ben', 'cy'], { pointsToWin: 2 });
    let guard = 0;
    while (h.state.phase !== 'gameOver' && guard++ < 20) {
      if (h.state.phase === 'submitting') h.submitAll();
      if (h.state.phase === 'judging') {
        // Always award the same player so the target is reached quickly.
        const target = h.state.submissions.find((s) => s.playerId === 'ben') ?? h.state.submissions[0]!;
        h.dispatch({ type: 'selectWinner', playerId: h.state.czarId!, winnerId: target.playerId });
      }
      if (h.state.phase === 'roundResult' && h.state.deadline !== null) h.fireDeadline();
    }
    assert.equal(h.state.phase, 'gameOver');
    assert.ok(h.state.winnerIds.length >= 1);
    const best = Math.max(...Object.values(h.state.players).map((p) => p.score));
    assert.ok(best >= 2);
  });

  test('endless mode keeps going past any score', () => {
    const h = startedGame(['ana', 'ben', 'cy'], { pointsToWin: null });
    for (let i = 0; i < 6; i++) {
      h.submitAll();
      h.dispatch({ type: 'selectWinner', playerId: h.state.czarId!, winnerId: h.state.submissions[0]!.playerId });
      h.fireDeadline();
    }
    assert.notEqual(h.state.phase, 'gameOver');
    assert.equal(h.state.round, 7);
  });

  test('the host can end a game in progress, highest score wins', () => {
    const h = startedGame();
    h.submitAll();
    const winner = h.state.submissions[0]!.playerId;
    h.dispatch({ type: 'selectWinner', playerId: h.state.czarId!, winnerId: winner });
    h.dispatch({ type: 'endGame', playerId: 'ana' });
    assert.equal(h.state.phase, 'gameOver');
    assert.deepEqual(h.state.winnerIds, [winner]);
  });

  test('starting again from gameOver resets scores but keeps seats', () => {
    const h = startedGame();
    h.submitAll();
    h.dispatch({ type: 'selectWinner', playerId: h.state.czarId!, winnerId: h.state.submissions[0]!.playerId });
    h.dispatch({ type: 'endGame', playerId: 'ana' });
    const seats = [...h.state.seatOrder];
    h.dispatch({ type: 'startGame', playerId: 'ana' });
    assert.equal(h.state.phase, 'submitting');
    assert.equal(h.state.round, 1);
    assert.deepEqual(h.state.seatOrder, seats);
    for (const p of Object.values(h.state.players)) assert.equal(p.score, 0);
  });
});

describe('player removal mid-round', () => {
  test('the czar leaving discards the round rather than handing judging over', () => {
    const h = startedGame(['ana', 'ben', 'cy', 'di']);
    h.submitAll();
    const czar = h.state.czarId!;
    h.dispatch({ type: 'leave', playerId: czar });
    assert.equal(h.state.phase, 'roundResult');
    assert.equal(h.state.lastResult!.skipped, true);
    assert.equal(h.state.players[czar], undefined);
  });

  test('a non-czar leaving mid-submission unblocks judging', () => {
    const h = startedGame(['ana', 'ben', 'cy', 'di']);
    const others = h.state.seatOrder.filter((id) => id !== h.state.czarId);
    const [quitter, ...rest] = others;
    for (const id of rest) {
      h.dispatch({ type: 'submit', playerId: id, cards: [h.state.players[id]!.hand[0]!] });
    }
    h.dispatch({ type: 'leave', playerId: quitter! });
    assert.equal(h.state.phase, 'judging');
  });

  test('dropping below the minimum parks the game until someone returns', () => {
    const h = startedGame(['ana', 'ben', 'cy']);
    h.submitAll();
    h.dispatch({ type: 'selectWinner', playerId: h.state.czarId!, winnerId: h.state.submissions[0]!.playerId });
    h.dispatch({ type: 'leave', playerId: h.state.seatOrder[0]! });

    assert.equal(h.state.phase, 'roundResult');
    h.dispatch({ type: 'timeout' });
    assert.equal(h.state.phase, 'roundResult', 'should not start a round with too few players');
    assert.equal(h.state.deadline, null);

    h.dispatch({ type: 'join', playerId: 'ed', name: 'ed' });
    assert.notEqual(h.state.deadline, null, 'should resume once enough players are back');
    h.fireDeadline();
    assert.equal(h.state.phase, 'submitting');
  });

  test('a player joining mid-game is dealt in immediately', () => {
    const h = startedGame();
    h.dispatch({ type: 'join', playerId: 'ed', name: 'ed' });
    assert.equal(h.state.players['ed']!.hand.length, 10);
  });
});

describe('decks too small to play', () => {
  test('a deck that cannot fill every hand is refused at start, with numbers', () => {
    // The custom-deck case: someone writes five great cards and plays it alone.
    const h = new Harness([tinyDeck(5, 5)], { deckIds: ['tiny'] });
    h.join('ana', 'ben', 'cy');
    assert.throws(
      () => h.dispatch({ type: 'startGame', playerId: 'ana' }),
      (err: unknown) =>
        err instanceof GameError &&
        err.code === 'NOT_ENOUGH_CARDS' &&
        /5 answer cards; 3 players need 30/.test(err.message),
    );
  });

  test('the same deck plays fine alongside a big one', () => {
    const h = new Harness([...decks, tinyDeck(5, 5)], { deckIds: ['containers', 'tiny'] });
    h.join('ana', 'ben', 'cy');
    h.dispatch({ type: 'startGame', playerId: 'ana' });
    assert.equal(h.state.phase, 'submitting');
    for (const id of h.state.seatOrder) assert.equal(h.state.players[id]!.hand.length, 10);
  });

  test('a smaller hand size makes a small deck playable', () => {
    const h = new Harness([tinyDeck(5, 30)], { deckIds: ['tiny'], handSize: 10 });
    h.join('ana', 'ben', 'cy');
    h.dispatch({ type: 'startGame', playerId: 'ana' });
    assert.equal(h.state.phase, 'submitting');
  });

  test('exactly enough cards is enough', () => {
    const h = new Harness([tinyDeck(5, 30)], { deckIds: ['tiny'] });
    h.join('ana', 'ben', 'cy');
    h.dispatch({ type: 'startGame', playerId: 'ana' });
    assert.equal(h.state.phase, 'submitting');
    assert.equal(h.state.responseDraw.length, 0, 'should have dealt the pile exactly dry');
  });

  test('a player holding too few cards is not waited on', () => {
    // Defence in depth: the start check makes this rare, but a player joining
    // mid-game against a thin pile can still end up short.
    const h = new Harness(decks, { deckIds: ['containers'], submitTimerMs: null });
    h.join('ana', 'ben', 'cy');
    h.dispatch({ type: 'startGame', playerId: 'ana' });
    const short = h.state.seatOrder.find((id) => id !== h.state.czarId)!;
    h.state.players[short]!.hand = [];

    h.submitAll();
    assert.equal(h.state.phase, 'judging', 'the round waited on a player who held nothing');
  });
});

describe('multiple decks', () => {
  test('every shipped deck loads with cards and attribution', () => {
    assert.equal(decks.length, 4);
    for (const deck of decks) {
      assert.ok(deck.prompts.length > 0, `${deck.id} has no prompts`);
      assert.ok(deck.responses.length > 0, `${deck.id} has no responses`);
      assert.ok(deck.attribution.license.length > 0, `${deck.id} has no licence`);
      assert.ok(deck.attribution.source.startsWith('https://'), `${deck.id} has no source`);
      assert.match(deck.attribution.upstreamCommit, /^[0-9a-f]{40}$/, `${deck.id} is not pinned`);
    }
  });

  test('card ids are unique across every deck', () => {
    const ids = new Set<string>();
    for (const deck of decks) {
      for (const card of [...deck.prompts, ...deck.responses]) {
        assert.ok(!ids.has(card.id), `duplicate card id ${card.id}`);
        ids.add(card.id);
      }
    }
  });

  test('enabling several decks combines their piles', () => {
    const h = new Harness(decks, { deckIds: ['containers', 'reliability'] });
    const containers = decks.find((d) => d.id === 'containers')!;
    const reliability = decks.find((d) => d.id === 'reliability')!;
    // Minus the handful of cards the two decks happen to share.
    assert.ok(h.state.promptDraw.length > containers.prompts.length);
    assert.ok(h.state.promptDraw.length <= containers.prompts.length + reliability.prompts.length);
  });

  test('duplicate card text across decks is dealt only once', () => {
    const all = new Harness(decks, { deckIds: decks.map((d) => d.id) });
    const byId = new Map(decks.flatMap((d) => d.responses).map((r) => [r.id, r.text.toLowerCase()]));
    const texts = all.state.responseDraw.map((id) => byId.get(id)!);
    assert.equal(new Set(texts).size, texts.length, 'the same answer text was dealt twice');

    const promptsById = new Map(decks.flatMap((d) => d.prompts).map((p) => [p.id, p.text.toLowerCase()]));
    const promptTexts = all.state.promptDraw.map((id) => promptsById.get(id)!);
    assert.equal(new Set(promptTexts).size, promptTexts.length, 'the same prompt text was dealt twice');
  });

  test('a deck enabled alone keeps all of its own cards', () => {
    // Deduping happens when piles are built, not at import: a deck that shares
    // cards with another must still be whole when it is the only one on.
    for (const deck of decks) {
      const h = new Harness(decks, { deckIds: [deck.id] });
      assert.equal(h.state.promptDraw.length, deck.prompts.length, `${deck.id} lost prompts`);
      assert.equal(h.state.responseDraw.length, deck.responses.length, `${deck.id} lost responses`);
    }
  });

  test('deck order does not change which cards survive deduping', () => {
    const forward = new Harness(decks, { deckIds: ['containers', 'reliability'] });
    const reversed = new Harness([...decks].reverse(), { deckIds: ['containers', 'reliability'] });
    assert.equal(forward.state.responseDraw.length, reversed.state.responseDraw.length);
  });

  test('a multi-deck game plays without running dry', () => {
    const h = new Harness(decks, { deckIds: decks.map((d) => d.id), pointsToWin: null });
    h.join('ana', 'ben', 'cy', 'di');
    h.dispatch({ type: 'startGame', playerId: 'ana' });
    for (let round = 0; round < 10; round++) {
      h.submitAll();
      if (h.state.phase === 'judging') {
        h.dispatch({
          type: 'selectWinner',
          playerId: h.state.czarId!,
          winnerId: h.state.submissions[0]!.playerId,
        });
      }
      if (h.state.deadline !== null) h.fireDeadline();
      assert.equal(h.state.phase, 'submitting', `stalled in round ${round}`);
    }
  });

  test('pick counts are right in the new decks', () => {
    const reliability = decks.find((d) => d.id === 'reliability')!;
    const developers = decks.find((d) => d.id === 'developers')!;
    for (const deck of [reliability, developers]) {
      for (const prompt of deck.prompts) {
        assert.equal(prompt.pick, Math.max(1, prompt.blanks), `${prompt.id} pick mismatch`);
        assert.ok(prompt.pick >= 1 && prompt.pick <= 2, `${prompt.id} has odd pick ${prompt.pick}`);
      }
    }
    assert.equal(developers.prompts.filter((p) => p.pick === 2).length, 4);
    assert.equal(reliability.prompts.filter((p) => p.pick === 2).length, 1);
  });

  test('no LaTeX markup survived the import', () => {
    for (const deck of decks) {
      for (const card of [...deck.prompts, ...deck.responses]) {
        assert.ok(!card.text.includes('\\'), `${card.id} still has a backslash: ${card.text}`);
        assert.ok(!card.text.includes('BLANK'), `${card.id} still has a BLANK macro`);
        assert.ok(!/&#\d+;/.test(card.text), `${card.id} still has an HTML entity`);
      }
    }
  });
});

describe('content filter', () => {
  test('no shipped card contains sexual content', () => {
    for (const deck of decks) {
      for (const card of [...deck.prompts, ...deck.responses]) {
        const term = blockedTerm(card.text);
        assert.equal(term, null, `${deck.id}/${card.id} slipped through ("${term}"): ${card.text}`);
      }
    }
  });

  test('profanity is deliberately kept', () => {
    // Swearing is fine for this audience; the filter targets sex, not language.
    // If this fails, the filter has been widened past what was asked for.
    const all = decks.flatMap((d) => d.responses.map((r) => r.text.toLowerCase()));
    assert.ok(
      all.some((t) => /\b(shit|damn|hell|crap|bastard)\b/.test(t)),
      'profanity was filtered out along with the sexual content',
    );
  });

  test('technical vocabulary is not caught by the filter', () => {
    // The real danger of this filter: unanchored, `anal` matches "analysis",
    // `cum` matches "document" and "accumulate", `sex` matches "sexism".
    // These are exactly the words a deck about infrastructure is full of.
    const safe = [
      'Root cause analysis',
      'Reading the documentation',
      'Accumulated technical debt',
      'Casual sexism in code review',
      'Analysing the logs',
      'A circumstantial outage',
      'Scunthorpe',
      'Essex',
      'Cucumber tests',
      'Dickens',
      'Titsworth the intern',
    ];
    for (const text of safe) {
      assert.equal(blockedTerm(text), null, `false positive on: ${text}`);
    }
  });

  test('the filter does catch what it is meant to', () => {
    for (const text of [
      'A whole new kind of porn.',
      'AI based sex toys',
      'Going to prom naked',
      'Unexpected arousal',
      'Watching Porn over the company vpn',
    ]) {
      assert.notEqual(blockedTerm(text), null, `should have been filtered: ${text}`);
    }
  });

  test('compound words are caught, not just standalone terms', () => {
    // Word boundaries alone missed this: `\bporn` does not match "Youporn",
    // and a real card slipped through the first version of the filter.
    for (const text of [
      'Reading the Youporn blog entries on technology for research purposes',
      'A PornHub outage',
      'Definitely NSFW',
    ]) {
      assert.notEqual(blockedTerm(text), null, `compound term missed: ${text}`);
    }
  });
});

describe('deck integrity', () => {
  test('no response card is ever created or lost', () => {
    // Endless mode so the run isn't cut short by someone hitting the target.
    const h = startedGame(['ana', 'ben', 'cy', 'di'], { pointsToWin: null });
    const total = 271;
    assert.equal(countResponses(h.state), total);

    for (let round = 0; round < 12; round++) {
      h.submitAll();
      assert.equal(countResponses(h.state), total, `after submits, round ${round}`);
      if (h.state.phase === 'judging') {
        h.dispatch({
          type: 'selectWinner',
          playerId: h.state.czarId!,
          winnerId: h.state.submissions[0]!.playerId,
        });
      }
      assert.equal(countResponses(h.state), total, `after judging, round ${round}`);
      if (h.state.deadline !== null) h.fireDeadline();
      assert.equal(countResponses(h.state), total, `after next round, round ${round}`);
    }
  });

  test('cards from a player who leaves return to the discard pile', () => {
    const h = startedGame(['ana', 'ben', 'cy', 'di']);
    assert.equal(countResponses(h.state), 271);
    h.submitAll();
    h.dispatch({ type: 'leave', playerId: h.state.seatOrder.at(-1)! });
    assert.equal(countResponses(h.state), 271);
  });

  test('the response pile reshuffles from the discard when it runs dry', () => {
    // 3 players x 10 cards = 30 dealt, leaving 6 spare: exhaustion in a round or two.
    const h = new Harness([tinyDeck(20, 36)], { deckIds: ['tiny'] });
    h.join('ana', 'ben', 'cy');
    h.dispatch({ type: 'startGame', playerId: 'ana' });

    let reshuffled = false;
    for (let round = 0; round < 8; round++) {
      const drawBefore = h.state.responseDraw.length;
      h.submitAll();
      if (h.state.phase === 'judging') {
        h.dispatch({
          type: 'selectWinner',
          playerId: h.state.czarId!,
          winnerId: h.state.submissions[0]!.playerId,
        });
      }
      if (h.state.deadline !== null) h.fireDeadline();
      if (h.state.responseDraw.length > drawBefore) reshuffled = true;
      assert.equal(countResponses(h.state), 36, `card count drifted in round ${round}`);
    }
    assert.ok(reshuffled, 'expected the discard pile to be reshuffled back in');
  });

  test('prompts are conserved and recycled too', () => {
    const h = new Harness([tinyDeck(3, 60)], { deckIds: ['tiny'] });
    h.join('ana', 'ben', 'cy');
    h.dispatch({ type: 'startGame', playerId: 'ana' });
    for (let round = 0; round < 6; round++) {
      assert.equal(countPrompts(h.state), 3, `prompt count drifted in round ${round}`);
      h.submitAll();
      if (h.state.phase === 'judging') {
        h.dispatch({
          type: 'selectWinner',
          playerId: h.state.czarId!,
          winnerId: h.state.submissions[0]!.playerId,
        });
      }
      if (h.state.deadline !== null) h.fireDeadline();
    }
  });
});

describe('purity', () => {
  test('reduce does not mutate the state it is given', () => {
    const h = startedGame();
    const before: GameState = structuredClone(h.state);
    const player = h.state.seatOrder.find((id) => id !== h.state.czarId)!;
    h.dispatch({ type: 'submit', playerId: player, cards: [h.state.players[player]!.hand[0]!] });
    assert.deepEqual(before, JSON.parse(JSON.stringify(before)));
    assert.notEqual(h.state.submissions.length, before.submissions.length);
  });

  test('the same seed produces the same deal', () => {
    const a = new Harness(decks, {}, 99);
    const b = new Harness(decks, {}, 99);
    a.join('ana', 'ben', 'cy');
    b.join('ana', 'ben', 'cy');
    a.dispatch({ type: 'startGame', playerId: 'ana' });
    b.dispatch({ type: 'startGame', playerId: 'ana' });
    assert.equal(a.state.promptId, b.state.promptId);
    assert.deepEqual(a.state.players['ana']!.hand, b.state.players['ana']!.hand);
  });
});
