/**
 * The set of live rooms, keyed by code.
 *
 * All rooms live in this process's memory. That's a deliberate constraint —
 * see docs/adr-001-hosting.md — and the reason the server runs as a single
 * long-lived container rather than on serverless functions.
 */
import type { Deck } from '@cac/shared/deck';
import { ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH } from '@cac/shared/protocol';
import type { GameSettings, GameState } from '@cac/shared/game';
import { Room, realTimers, type Timers } from './room.ts';

/** A room with nobody in it is swept up after this long. */
export const ROOM_IDLE_MS = 30 * 60_000;
const SWEEP_INTERVAL_MS = 60_000;

export function generateCode(rand: () => number = Math.random): string {
  let code = '';
  for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
    code += ROOM_CODE_ALPHABET[Math.floor(rand() * ROOM_CODE_ALPHABET.length)];
  }
  return code;
}

export class RoomRegistry {
  private readonly rooms = new Map<string, Room>();
  private sweepHandle: unknown = null;
  private readonly roomClosedListeners = new Set<(code: string) => void>();

  // Written longhand: Node's strip-only mode rejects parameter properties.
  private decks: readonly Deck[];
  private readonly timers: Timers;

  constructor(decks: readonly Deck[], timers: Timers = realTimers) {
    this.decks = decks;
    this.timers = timers;
  }

  get size(): number {
    return this.rooms.size;
  }

  get deckList(): readonly Deck[] {
    return this.decks;
  }

  /** Current state of every live room, for aggregate reporting. */
  states(): GameState[] {
    return [...this.rooms.values()].map((r) => r.state);
  }

  /** Called with a room code whenever a room is dropped, so watchers can
   *  release anything they were tracking for it. */
  onRoomClosed(fn: (code: string) => void): void {
    this.roomClosedListeners.add(fn);
  }

  private notifyClosed(code: string): void {
    for (const fn of this.roomClosedListeners) fn(code);
  }

  /**
   * Swap in a freshly loaded deck list. New rooms get it immediately; rooms
   * sitting in a lobby adopt it so the deck list updates in front of them;
   * games already under way keep the decks they were dealt from.
   *
   * The array is replaced rather than mutated, because each Room holds its own
   * index built from whatever it was handed — mutating in place would reach
   * backwards into games in progress.
   */
  setDecks(decks: readonly Deck[]): { adopted: number; unchanged: number } {
    this.decks = decks;
    let adopted = 0;
    let unchanged = 0;
    for (const room of this.rooms.values()) {
      if (room.adoptDecks(decks)) adopted++;
      else unchanged++;
    }
    return { adopted, unchanged };
  }

  create(settings: Partial<GameSettings> = {}, rand: () => number = Math.random): Room {
    let code = generateCode(rand);
    // 24^4 codes against a handful of live rooms; a collision is vanishingly
    // rare but retrying is cheaper than reasoning about whether it can happen.
    for (let attempt = 0; this.rooms.has(code) && attempt < 100; attempt++) {
      code = generateCode(rand);
    }
    if (this.rooms.has(code)) throw new Error('could not allocate a free room code');

    const room = new Room(code, this.decks, settings, this.timers);
    this.rooms.set(code, room);
    return room;
  }

  get(code: string): Room | undefined {
    return this.rooms.get(code.trim().toUpperCase());
  }

  close(code: string): void {
    const room = this.rooms.get(code);
    if (!room) return;
    room.close();
    this.rooms.delete(code);
    this.notifyClosed(code);
  }

  /** Drop rooms nobody has touched in a while, so a long-running server
   *  doesn't accumulate dead games. */
  sweep(idleMs: number = ROOM_IDLE_MS): number {
    let removed = 0;
    for (const [code, room] of this.rooms) {
      if (room.isAbandoned(idleMs)) {
        room.close();
        this.rooms.delete(code);
        this.notifyClosed(code);
        removed++;
      }
    }
    return removed;
  }

  startSweeping(): void {
    const tick = () => {
      this.sweep();
      this.sweepHandle = this.timers.setTimeout(tick, SWEEP_INTERVAL_MS);
    };
    this.sweepHandle = this.timers.setTimeout(tick, SWEEP_INTERVAL_MS);
  }

  stop(): void {
    if (this.sweepHandle !== null) this.timers.clearTimeout(this.sweepHandle);
    this.sweepHandle = null;
    for (const room of this.rooms.values()) room.close();
    this.rooms.clear();
  }
}
