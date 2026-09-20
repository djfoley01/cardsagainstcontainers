/**
 * A single game room: the engine state, the clock that drives it, and the
 * broadcast hook.
 *
 * The engine is pure and knows nothing about time passing. This is the piece
 * that turns `state.deadline` into an actual timer, so phases advance on their
 * own when a player goes quiet. It takes an injectable timer source so tests
 * can drive it without waiting in real time.
 */
import type { Deck } from '@cac/shared/deck';
import { DISCONNECT_GRACE_MS, type Action, type GameSettings, type GameState } from '@cac/shared/game';
import { buildDeckIndex, createGame, reduce, type DeckIndex, type EngineContext } from './engine/reduce.ts';
import { createRng } from './engine/rng.ts';

/** How often to sweep for players past their disconnect grace period. */
export const REAP_INTERVAL_MS = 30_000;

/** Engine-driven actions, as opposed to something a player did. */
const INTERNAL_ACTIONS = new Set<Action['type']>(['reap', 'timeout']);

export interface Timers {
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  now: () => number;
}

export const realTimers: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
  now: () => Date.now(),
};

export class Room {
  readonly code: string;
  readonly decks: DeckIndex;
  state: GameState;
  /** Last time anything happened here, for idle cleanup. */
  lastActivity: number;

  private readonly timers: Timers;
  private readonly listeners = new Set<(state: GameState) => void>();
  private deadlineHandle: unknown = null;
  private reapHandle: unknown = null;
  private closed = false;

  constructor(
    code: string,
    decks: readonly Deck[],
    settings: Partial<GameSettings> = {},
    timers: Timers = realTimers,
    seed: number = Date.now(),
  ) {
    this.code = code;
    this.timers = timers;
    this.decks = buildDeckIndex(decks);
    this.state = createGame(code, this.context(), settings);
    this.lastActivity = timers.now();
    this.scheduleReap();
  }

  private context(): EngineContext {
    // A fresh `now` on every dispatch; the rng is seeded once per room so a
    // room's whole session is reproducible from its seed.
    return { now: this.timers.now(), rng: this.rng, decks: this.decks };
  }

  private readonly rng = createRng(Math.floor(Math.random() * 2 ** 31));

  onChange(fn: (state: GameState) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /**
   * Apply an action. Throws GameError for invalid actions; callers are
   * expected to translate that into a message for the one client at fault.
   */
  dispatch(action: Action): GameState {
    if (this.closed) throw new Error('room is closed');
    this.state = reduce(this.state, action, this.context());
    // Housekeeping must not count as activity. The reap sweep runs every 30s
    // forever, so bumping lastActivity here would mean a room continually
    // refreshed its own idle timer and was never swept up.
    if (!INTERNAL_ACTIONS.has(action.type)) this.lastActivity = this.timers.now();
    this.scheduleDeadline();
    for (const listener of this.listeners) listener(this.state);
    return this.state;
  }

  /**
   * Re-arm the phase timer to match state.deadline. Called after every
   * dispatch, because almost any action can move a deadline: a submission
   * completing the round, a czar dropping, the host disabling timers.
   */
  private scheduleDeadline(): void {
    if (this.deadlineHandle !== null) {
      this.timers.clearTimeout(this.deadlineHandle);
      this.deadlineHandle = null;
    }
    if (this.closed || this.state.deadline === null) return;

    const delay = Math.max(0, this.state.deadline - this.timers.now());
    this.deadlineHandle = this.timers.setTimeout(() => {
      this.deadlineHandle = null;
      if (this.closed) return;
      // Guard against a stale firing: only act if the deadline really passed.
      if (this.state.deadline !== null && this.timers.now() >= this.state.deadline) {
        this.dispatch({ type: 'timeout' });
      } else {
        this.scheduleDeadline();
      }
    }, delay);
  }

  private scheduleReap(): void {
    if (this.closed) return;
    this.reapHandle = this.timers.setTimeout(() => {
      this.reapHandle = null;
      if (this.closed) return;
      this.dispatch({ type: 'reap' });
      this.scheduleReap();
    }, REAP_INTERVAL_MS);
  }

  /** True when nobody is connected and the grace period has fully elapsed. */
  isAbandoned(idleMs: number): boolean {
    const anyConnected = Object.values(this.state.players).some((p) => p.connected);
    if (anyConnected) return false;
    return this.timers.now() - this.lastActivity > Math.max(idleMs, DISCONNECT_GRACE_MS);
  }

  close(): void {
    this.closed = true;
    if (this.deadlineHandle !== null) this.timers.clearTimeout(this.deadlineHandle);
    if (this.reapHandle !== null) this.timers.clearTimeout(this.reapHandle);
    this.deadlineHandle = null;
    this.reapHandle = null;
    this.listeners.clear();
  }
}
