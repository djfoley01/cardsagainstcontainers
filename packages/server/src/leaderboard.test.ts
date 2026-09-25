import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Leaderboard } from './leaderboard.ts';
import { Harness, loadDecks } from './engine/testkit.ts';

const decks = loadDecks();

/** Play one round to a winner and return the harness. */
function playRound(h: Harness, winner?: string): string {
  h.submitAll();
  const target = winner && h.state.submissions.some((s) => s.playerId === winner)
    ? winner
    : h.state.submissions[0]!.playerId;
  h.dispatch({ type: 'selectWinner', playerId: h.state.czarId!, winnerId: target });
  return target;
}

function started(names = ['ana', 'ben', 'cy'], settings = {}): Harness {
  const h = new Harness(decks, { pointsToWin: null, ...settings });
  h.join(...names);
  h.dispatch({ type: 'startGame', playerId: names[0]! });
  return h;
}

describe('counting round wins', () => {
  test('a resolved round credits the winner', () => {
    const board = new Leaderboard(1000);
    const h = started();
    const winner = playRound(h);
    board.sync(h.state, 2000);

    const leaders = board.leaders();
    assert.equal(leaders.length, 1);
    assert.equal(leaders[0]!.playerId, winner);
    assert.equal(leaders[0]!.roundsWon, 1);
    assert.equal(board.stats([h.state]).roundsPlayed, 1);
  });

  test('syncing the same state repeatedly does not double count', () => {
    // sync runs on every state change, which includes changes that have
    // nothing to do with rounds, so it has to be idempotent.
    const board = new Leaderboard(1000);
    const h = started();
    playRound(h);
    for (let i = 0; i < 10; i++) board.sync(h.state, 2000);
    assert.equal(board.leaders()[0]!.roundsWon, 1);
    assert.equal(board.stats([h.state]).roundsPlayed, 1);
  });

  test('several rounds accumulate', () => {
    const board = new Leaderboard(1000);
    const h = started();
    for (let i = 0; i < 4; i++) {
      playRound(h, 'ben');
      board.sync(h.state, 2000);
      h.fireDeadline();
      board.sync(h.state, 2000);
    }
    const ben = board.leaders().find((l) => l.playerId === 'ben');
    assert.ok(ben, 'ben should be on the board');
    assert.equal(board.stats([h.state]).roundsPlayed, 4);
  });

  test('a skipped round credits nobody', () => {
    const board = new Leaderboard(1000);
    const h = started(['ana', 'ben', 'cy'], { submitTimerMs: 1000 });
    h.fireDeadline(); // nobody submitted
    assert.equal(h.state.lastResult!.skipped, true);
    board.sync(h.state, 2000);
    assert.deepEqual(board.leaders(), []);
    assert.equal(board.stats([h.state]).roundsPlayed, 0);
  });

  test('a new game in the same room keeps earlier wins and counts new ones', () => {
    // startGame clears history, so the watermark has to reset rather than
    // treating a shorter history as impossible.
    const board = new Leaderboard(1000);
    const h = started();
    playRound(h, 'ben');
    board.sync(h.state, 2000);
    assert.equal(board.stats([h.state]).roundsPlayed, 1);

    h.dispatch({ type: 'endGame', playerId: 'ana' });
    board.sync(h.state, 2000);
    h.dispatch({ type: 'startGame', playerId: 'ana' });
    board.sync(h.state, 2000);
    assert.equal(board.stats([h.state]).roundsPlayed, 1, 'a restart must not lose or repeat counts');

    playRound(h, 'cy');
    board.sync(h.state, 3000);
    assert.equal(board.stats([h.state]).roundsPlayed, 2);
  });
});

describe('counting game wins', () => {
  test('reaching the target credits a game win', () => {
    const board = new Leaderboard(1000);
    const h = started(['ana', 'ben', 'cy'], { pointsToWin: 1 });
    const winner = playRound(h);
    assert.equal(h.state.phase, 'gameOver');
    board.sync(h.state, 2000);

    const entry = board.leaders().find((l) => l.playerId === winner)!;
    assert.equal(entry.gamesWon, 1);
    assert.equal(entry.roundsWon, 1);
  });

  test('a finished game is counted once however often it is synced', () => {
    const board = new Leaderboard(1000);
    const h = started(['ana', 'ben', 'cy'], { pointsToWin: 1 });
    playRound(h);
    for (let i = 0; i < 8; i++) board.sync(h.state, 2000);
    assert.equal(board.leaders()[0]!.gamesWon, 1);
  });

  test('a tie credits everyone who tied', () => {
    const board = new Leaderboard(1000);
    const h = started();
    playRound(h, 'ben');
    h.fireDeadline();
    playRound(h, 'cy');
    // Force a tie at the top, then end it.
    h.dispatch({ type: 'endGame', playerId: 'ana' });
    board.sync(h.state, 2000);
    const winners = h.state.winnerIds;
    assert.ok(winners.length >= 1);
    for (const id of winners) {
      assert.equal(board.leaders().find((l) => l.playerId === id)!.gamesWon, 1);
    }
  });

  test('a rematch in the same room counts as another game', () => {
    const board = new Leaderboard(1000);
    const h = started(['ana', 'ben', 'cy'], { pointsToWin: 1 });
    const first = playRound(h);
    board.sync(h.state, 2000);
    h.dispatch({ type: 'startGame', playerId: 'ana' });
    board.sync(h.state, 2000);
    const second = playRound(h);
    board.sync(h.state, 3000);

    const total = board.leaders().reduce((n, l) => n + l.gamesWon, 0);
    assert.equal(total, 2, `expected two game wins (${first}, ${second})`);
  });
});

describe('ordering and identity', () => {
  test('games won outranks rounds won', () => {
    const board = new Leaderboard(1000);
    const a = started(['ana', 'ben', 'cy'], { pointsToWin: 1 });
    playRound(a, 'ben');
    board.sync(a.state, 2000);

    // A different room where someone racks up rounds but wins no game.
    const b = new Harness(decks, { pointsToWin: null });
    b.join('dee', 'eve', 'fay');
    b.dispatch({ type: 'startGame', playerId: 'dee' });
    for (let i = 0; i < 5; i++) {
      playRound(b, 'eve');
      board.sync(b.state, 2500);
      b.fireDeadline();
      board.sync(b.state, 2500);
    }

    const leaders = board.leaders();
    assert.equal(leaders[0]!.gamesWon, 1, 'a game winner should lead on rounds alone');
  });

  test('players are keyed by id, so a rename keeps their credit', () => {
    const board = new Leaderboard(1000);
    const h = started();
    playRound(h, 'ben');
    board.sync(h.state, 2000);

    assert.equal(board.leaders().find((l) => l.playerId === 'ben')!.name, 'ben');

    h.dispatch({ type: 'disconnect', playerId: 'ben' });
    h.dispatch({ type: 'join', playerId: 'ben', name: 'benjamin' });
    board.sync(h.state, 3000);

    const entries = board.leaders().filter((l) => l.playerId === 'ben');
    assert.equal(entries.length, 1, 'a rename must not create a second entry');
    assert.equal(entries[0]!.name, 'benjamin', 'the latest name should show');
    assert.equal(entries[0]!.roundsWon, 1, 'the rename must not cost them their win');
  });

  test('the list is capped', () => {
    const board = new Leaderboard(1000);
    const h = started();
    playRound(h);
    board.sync(h.state, 2000);
    assert.ok(board.leaders(1).length <= 1);
  });

  test('nobody appears before they have won anything', () => {
    const board = new Leaderboard(1000);
    const h = started();
    board.sync(h.state, 2000);
    assert.deepEqual(board.leaders(), []);
  });
});

describe('live activity counts', () => {
  test('a lobby counts as open, a started game as active', () => {
    const board = new Leaderboard(1000);
    const lobby = new Harness(decks);
    lobby.join('ana', 'ben', 'cy');
    const playing = started(['dee', 'eve', 'fay']);

    const stats = board.stats([lobby.state, playing.state]);
    assert.equal(stats.openLobbies, 1);
    assert.equal(stats.activeGames, 1);
    assert.equal(stats.playersOnline, 6);
  });

  test('a finished game is neither active nor an open lobby', () => {
    const board = new Leaderboard(1000);
    const h = started(['ana', 'ben', 'cy'], { pointsToWin: 1 });
    playRound(h);
    const stats = board.stats([h.state]);
    assert.equal(stats.activeGames, 0);
    assert.equal(stats.openLobbies, 0);
  });

  test('disconnected players are not counted as online', () => {
    const board = new Leaderboard(1000);
    const h = started();
    h.dispatch({ type: 'disconnect', playerId: 'ben' });
    assert.equal(board.stats([h.state]).playersOnline, 2);
  });

  test('no rooms means an empty but valid payload', () => {
    const board = new Leaderboard(4242);
    const stats = board.stats([]);
    assert.deepEqual(stats, {
      since: 4242,
      activeGames: 0,
      openLobbies: 0,
      playersOnline: 0,
      roundsPlayed: 0,
      leaders: [],
    });
  });
});

describe('forgetting closed rooms', () => {
  test('a closed room releases its watermarks without losing the tally', () => {
    const board = new Leaderboard(1000);
    const h = started();
    playRound(h, 'ben');
    board.sync(h.state, 2000);

    board.forget(h.state.roomCode);
    assert.equal(board.leaders()[0]!.roundsWon, 1, 'wins must survive the room closing');

    // A brand new room reusing that code starts from zero rather than being
    // treated as already counted.
    const reused = started(['dee', 'eve', 'fay']);
    reused.state.roomCode = h.state.roomCode;
    playRound(reused, 'eve');
    board.sync(reused.state, 3000);
    assert.equal(board.stats([reused.state]).roundsPlayed, 2);
  });
});
