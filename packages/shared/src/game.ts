/**
 * Game state, settings and action types.
 *
 * These live in `shared` because the client needs to reason about the same
 * shapes the server produces. The reducer that acts on them lives in
 * `packages/server/src/engine` — the client never mutates game state.
 */

export type Phase = 'lobby' | 'submitting' | 'judging' | 'roundResult' | 'gameOver';

export const MIN_PLAYERS = 3;
export const MAX_PLAYERS = 12;

/** How long the round waits for a czar who dropped mid-judge before it
 *  resolves itself. Applies even when judge timers are switched off, because
 *  otherwise a czar closing their laptop wedges the game permanently. */
export const CZAR_GRACE_MS = 20_000;

/** How long a disconnected player keeps their seat, hand and score. */
export const DISCONNECT_GRACE_MS = 120_000;

export interface GameSettings {
  handSize: number;
  /** Points needed to win, or null for an endless game the host ends manually. */
  pointsToWin: number | null;
  /** Submission time limit in ms, or null for no limit. */
  submitTimerMs: number | null;
  /** Judging time limit in ms, or null for no limit. */
  judgeTimerMs: number | null;
  /** Deck ids in play. Must be non-empty. */
  deckIds: string[];
}

export const DEFAULT_SETTINGS: GameSettings = {
  handSize: 10,
  pointsToWin: 7,
  submitTimerMs: 90_000,
  judgeTimerMs: 60_000,
  deckIds: ['containers'],
};

export interface Player {
  id: string;
  name: string;
  connected: boolean;
  /** When the player went offline, for grace-period eviction. */
  disconnectedAt: number | null;
  score: number;
  /** Response card ids held by this player. Never sent to other clients. */
  hand: string[];
  joinedAt: number;
}

export interface Submission {
  playerId: string;
  /** Response card ids in the order played. Order matters for pick-2 prompts. */
  cards: string[];
}

export interface RoundResult {
  promptId: string;
  winnerId: string;
  winningCards: string[];
  /** Every submission, revealed once the round is over. */
  submissions: Submission[];
  /** True when nobody submitted and the round was discarded. */
  skipped: boolean;
  /** True when the engine picked rather than the czar (czar dropped or timed out). */
  auto: boolean;
}

export interface GameState {
  roomCode: string;
  phase: Phase;
  /** Null only if every player has left. */
  hostId: string | null;
  players: Record<string, Player>;
  /** Stable seat order; czar rotation walks this. Includes disconnected players. */
  seatOrder: string[];
  czarId: string | null;
  round: number;
  promptId: string | null;
  submissions: Submission[];
  /** Player ids shuffled for anonymous reveal during judging. */
  revealOrder: string[];
  lastResult: RoundResult | null;
  /** Completed rounds, newest last. Drives the history panel. */
  history: RoundResult[];
  settings: GameSettings;
  /** Epoch ms the current phase auto-advances at, or null if untimed. */
  deadline: number | null;
  /** True while the clock is held. Distinct from `deadline === null`, which
   *  also means "untimed" or "parked waiting for players". */
  paused: boolean;
  /** Time left on the held deadline, restored on resume. Null if the paused
   *  phase had no deadline to begin with. */
  pausedRemainingMs: number | null;
  /** Who called the pause, for the banner. */
  pausedBy: string | null;
  promptDraw: string[];
  promptDiscard: string[];
  responseDraw: string[];
  responseDiscard: string[];
  /** Set when the game ends. May contain several ids on a tie. */
  winnerIds: string[];
}

export type Action =
  | { type: 'join'; playerId: string; name: string }
  | { type: 'leave'; playerId: string }
  | { type: 'disconnect'; playerId: string }
  | { type: 'reconnect'; playerId: string }
  | { type: 'kick'; playerId: string; targetId: string }
  | { type: 'updateSettings'; playerId: string; settings: Partial<GameSettings> }
  | { type: 'startGame'; playerId: string }
  | { type: 'submit'; playerId: string; cards: string[] }
  | { type: 'unsubmit'; playerId: string }
  | { type: 'selectWinner'; playerId: string; winnerId: string }
  | { type: 'nextRound'; playerId: string }
  | { type: 'endGame'; playerId: string }
  /** Host override: move the phase along now, even if the clock is held.
   *  The escape hatch when a player or czar has gone quiet with timers off. */
  | { type: 'forceAdvance'; playerId: string }
  | { type: 'transferHost'; playerId: string; targetId: string }
  | { type: 'pause'; playerId: string }
  | { type: 'resume'; playerId: string }
  /** Fired by the scheduler when `deadline` passes. Not a player action. */
  | { type: 'timeout' }
  /** Fired periodically to evict players past the disconnect grace period. */
  | { type: 'reap' };

export type GameErrorCode =
  | 'ROOM_FULL'
  | 'NAME_TAKEN'
  | 'NOT_HOST'
  | 'NOT_CZAR'
  | 'IS_CZAR'
  | 'WRONG_PHASE'
  | 'NOT_ENOUGH_PLAYERS'
  | 'UNKNOWN_PLAYER'
  | 'ALREADY_SUBMITTED'
  | 'BAD_SUBMISSION'
  | 'NO_SUCH_SUBMISSION'
  | 'INVALID_SETTINGS';

export class GameError extends Error {
  // Written longhand rather than as a parameter property: Node runs TypeScript
  // in strip-only mode, which rejects `constructor(readonly code: ...)`.
  readonly code: GameErrorCode;

  constructor(code: GameErrorCode, message?: string) {
    super(message ?? code);
    this.name = 'GameError';
    this.code = code;
  }
}
