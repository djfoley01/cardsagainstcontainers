import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { GameState } from '@cac/shared/game';
import { Harness, loadDecks } from './engine/testkit.ts';
import { buildDeckIndex } from './engine/reduce.ts';
import { toPublicState } from './redact.ts';

const decks = loadDecks();
const index = buildDeckIndex(decks);

function started(names = ['ana', 'ben', 'cy'], settings = {}): Harness {
  const h = new Harness(decks, settings);
  h.join(...names);
  h.dispatch({ type: 'startGame', playerId: names[0]! });
  return h;
}

/** Every response card id that appears anywhere in a serialized payload. */
function idsIn(payload: unknown): Set<string> {
  const found = new Set<string>();
  for (const match of JSON.stringify(payload).matchAll(/"(c-r-\d+)"/g)) found.add(match[1]!);
  return found;
}

describe('redaction', () => {
  test('a player sees their own hand and nobody else receives it', () => {
    const h = started();
    const [me, other] = h.state.seatOrder;
    const mine = new Set(h.state.players[me!]!.hand);
    const theirs = new Set(h.state.players[other!]!.hand);

    const view = toPublicState(h.state, me!, index);
    assert.equal(view.you.hand.length, 10);
    assert.deepEqual(new Set(view.you.hand.map((c) => c.id)), mine);

    // Nothing from another player's hand may appear anywhere in the payload.
    const leaked = [...idsIn(view)].filter((id) => theirs.has(id) && !mine.has(id));
    assert.deepEqual(leaked, [], 'another hand leaked into the payload');
  });

  test('the draw pile never reaches the client, only counts', () => {
    const h = started();
    const view = toPublicState(h.state, h.state.seatOrder[0]!, index);
    const serialized = JSON.stringify(view);

    assert.equal(view.responsesRemaining, 271 - 30);
    assert.ok(!('responseDraw' in (view as object)));
    assert.ok(!('promptDraw' in (view as object)));

    // Spot-check: a card sitting in the draw pile must not appear by id.
    const buried = h.state.responseDraw[0]!;
    assert.ok(!serialized.includes(buried), 'a draw-pile card id leaked');
  });

  test('other players expose a hand count but no cards', () => {
    const h = started();
    const view = toPublicState(h.state, h.state.seatOrder[0]!, index);
    for (const player of view.players) {
      assert.equal(player.handCount, 10);
      assert.ok(!('hand' in (player as object)), 'player object carries a hand');
    }
  });

  test('no submissions are visible at all while players are still choosing', () => {
    const h = started(['ana', 'ben', 'cy', 'di']);
    const player = h.state.seatOrder.find((id) => id !== h.state.czarId)!;
    h.dispatch({ type: 'submit', playerId: player, cards: [h.state.players[player]!.hand[0]!] });

    const view = toPublicState(h.state, h.state.czarId!, index);
    assert.equal(view.phase, 'submitting');
    assert.deepEqual(view.submissions, [], 'cards visible before judging');
    assert.equal(view.submissionCount, 1);
    assert.equal(view.awaitingCount, 2);
    // Who has played is public; what they played is not.
    assert.equal(view.players.find((p) => p.id === player)!.hasSubmitted, true);
  });

  test('during judging the czar sees cards but no identities', () => {
    const h = started(['ana', 'ben', 'cy', 'di']);
    h.submitAll();
    assert.equal(h.state.phase, 'judging');

    const view = toPublicState(h.state, h.state.czarId!, index);
    assert.equal(view.submissions.length, 3);
    for (const submission of view.submissions) {
      assert.equal(submission.playerId, null, 'judging leaked who played a card');
    }
    // The payload must not carry player ids alongside the cards in any form.
    const serialized = JSON.stringify(view.submissions);
    for (const id of h.state.seatOrder) {
      assert.ok(!serialized.includes(`"${id}"`), `player id ${id} leaked into submissions`);
    }
  });

  test('identities appear once the round is resolved', () => {
    const h = started();
    h.submitAll();
    const winner = h.state.submissions[0]!.playerId;
    h.dispatch({ type: 'selectWinner', playerId: h.state.czarId!, winnerId: winner });

    const view = toPublicState(h.state, h.state.czarId!, index);
    assert.equal(view.phase, 'roundResult');
    assert.equal(view.lastResult!.winnerId, winner);
    assert.ok(view.lastResult!.winnerName.length > 0);
    for (const submission of view.lastResult!.submissions) {
      assert.ok(submission.playerId, 'result should name who played each card');
    }
  });

  test('the reveal index maps to a real submission and is the only handle', () => {
    const h = started(['ana', 'ben', 'cy', 'di']);
    h.submitAll();
    const view = toPublicState(h.state, h.state.czarId!, index);
    const indices = view.submissions.map((s) => s.index);
    assert.deepEqual(indices, [0, 1, 2]);
    for (const i of indices) {
      assert.ok(h.state.revealOrder[i], `index ${i} does not map to a player`);
    }
  });

  test('a viewer who is not in the room gets an empty self view', () => {
    const h = started();
    const view = toPublicState(h.state, 'stranger', index);
    assert.deepEqual(view.you.hand, []);
    assert.equal(view.you.isHost, false);
    assert.equal(view.you.isCzar, false);
  });

  test('self view reports the viewer\'s own submitted cards back to them', () => {
    const h = started();
    const player = h.state.seatOrder.find((id) => id !== h.state.czarId)!;
    const card = h.state.players[player]!.hand[0]!;
    h.dispatch({ type: 'submit', playerId: player, cards: [card] });

    const mine = toPublicState(h.state, player, index);
    assert.equal(mine.you.hasSubmitted, true);
    assert.deepEqual(mine.you.submittedCards.map((c) => c.id), [card]);

    // ...but not to anyone else, while judging is still open.
    const theirs = toPublicState(h.state, h.state.czarId!, index);
    assert.deepEqual(theirs.you.submittedCards, []);
  });

  test('history is capped and newest first', () => {
    const h = started(['ana', 'ben', 'cy'], { pointsToWin: null });
    for (let i = 0; i < 25; i++) {
      h.submitAll();
      h.dispatch({
        type: 'selectWinner',
        playerId: h.state.czarId!,
        winnerId: h.state.submissions[0]!.playerId,
      });
      h.fireDeadline();
    }
    const view = toPublicState(h.state, h.state.seatOrder[0]!, index);
    assert.equal(view.history.length, 20);
    const rounds = h.state.history.slice(-20).map((r) => r.promptId).reverse();
    assert.deepEqual(view.history.map((r) => r.prompt.id), rounds);
  });

  test('settings and deadline are public', () => {
    const h = started();
    const view = toPublicState(h.state, h.state.seatOrder[1]!, index);
    assert.equal(view.settings.handSize, 10);
    assert.equal(view.deadline, h.state.deadline);
  });
});
