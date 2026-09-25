/**
 * Running tally of who has won what, across every room on the server.
 *
 * Kept out of the engine on purpose: the engine is a pure reducer over one
 * room's state and knows nothing about other rooms or about history that
 * outlives a game. This sits above it and watches state go by.
 *
 * Like everything else here the tally is in memory, so it resets when the
 * server restarts. That is consistent with rooms themselves — see
 * docs/adr-001-hosting.md — and the UI says as much rather than implying an
 * all-time record.
 *
 * Players are keyed by playerId, not name, so someone who renames mid-session
 * keeps their credit. The display name follows the most recent one they used.
 */
import type { GameState } from '@cac/shared/game';
import type { LobbyStats, PlayerTally } from '@cac/shared/protocol';

interface Entry {
  playerId: string;
  name: string;
  roundsWon: number;
  gamesWon: number;
  /** Ordering tiebreak: whoever got there first stays ahead. */
  firstWinAt: number;
}

/** How many players the landing page shows. */
export const LEADER_LIMIT = 10;

export class Leaderboard {
  readonly since: number;

  private readonly players = new Map<string, Entry>();
  /** Rounds already counted per room, so a re-broadcast cannot double count. */
  private readonly countedRounds = new Map<string, number>();
  /**
   * Rooms whose current gameOver has already been counted.
   *
   * A flag rather than a key built from the round number: with a low points
   * target two games in the same room can both end on round 1, and keying on
   * the round silently treated the rematch as already counted. The flag is
   * cleared the moment the room leaves gameOver, which is exactly when a new
   * game has begun.
   */
  private readonly countedGameOver = new Set<string>();
  private roundsPlayed = 0;

  constructor(now: number) {
    this.since = now;
  }

  private entry(playerId: string, name: string, now: number): Entry {
    const existing = this.players.get(playerId);
    if (existing) {
      // Keep the latest name they went by.
      if (name) existing.name = name;
      return existing;
    }
    const fresh: Entry = { playerId, name, roundsWon: 0, gamesWon: 0, firstWinAt: now };
    this.players.set(playerId, fresh);
    return fresh;
  }

  /**
   * Fold a room's current state into the tally.
   *
   * Called on every state change, so it must be idempotent: it counts only
   * history entries it has not seen before. `history` is cleared when a new
   * game starts in the same room, which is why a shrinking length resets the
   * watermark rather than being treated as impossible.
   */
  sync(state: GameState, now: number): void {
    // Keep display names current for anyone already on the board, not only for
    // players who happen to win again. Otherwise a rename shows the old name
    // until their next victory.
    for (const player of Object.values(state.players)) {
      const entry = this.players.get(player.id);
      if (entry && player.name) entry.name = player.name;
    }

    const seen = this.countedRounds.get(state.roomCode) ?? 0;
    if (state.history.length < seen) this.countedRounds.set(state.roomCode, 0);

    const from = Math.min(seen, state.history.length);
    for (const result of state.history.slice(from)) {
      // Skipped rounds have no winner; they are not an achievement.
      if (result.skipped || !result.winnerId) continue;
      const name = state.players[result.winnerId]?.name ?? '';
      this.entry(result.winnerId, name, now).roundsWon += 1;
      this.roundsPlayed += 1;
    }
    this.countedRounds.set(state.roomCode, state.history.length);

    if (state.phase === 'gameOver') {
      if (state.winnerIds.length > 0 && !this.countedGameOver.has(state.roomCode)) {
        this.countedGameOver.add(state.roomCode);
        for (const id of state.winnerIds) {
          this.entry(id, state.players[id]?.name ?? '', now).gamesWon += 1;
        }
      }
    } else {
      // Left gameOver, so a rematch may be under way: arm it again.
      this.countedGameOver.delete(state.roomCode);
    }
  }

  /** Forget a room's watermarks once it is gone, so the maps do not grow. */
  forget(roomCode: string): void {
    this.countedRounds.delete(roomCode);
    this.countedGameOver.delete(roomCode);
  }

  leaders(limit = LEADER_LIMIT): PlayerTally[] {
    return [...this.players.values()]
      .filter((e) => e.roundsWon > 0 || e.gamesWon > 0)
      .sort(
        (a, b) =>
          b.gamesWon - a.gamesWon ||
          b.roundsWon - a.roundsWon ||
          a.firstWinAt - b.firstWinAt ||
          a.name.localeCompare(b.name),
      )
      .slice(0, limit)
      .map(({ playerId, name, roundsWon, gamesWon }) => ({ playerId, name, roundsWon, gamesWon }));
  }

  /** Build the payload the landing page renders. */
  stats(rooms: Iterable<GameState>, limit = LEADER_LIMIT): LobbyStats {
    let activeGames = 0;
    let openLobbies = 0;
    let playersOnline = 0;

    for (const state of rooms) {
      if (state.phase === 'lobby') openLobbies += 1;
      else if (state.phase !== 'gameOver') activeGames += 1;
      playersOnline += Object.values(state.players).filter((p) => p.connected).length;
    }

    return {
      since: this.since,
      activeGames,
      openLobbies,
      playersOnline,
      roundsPlayed: this.roundsPlayed,
      leaders: this.leaders(limit),
    };
  }
}
