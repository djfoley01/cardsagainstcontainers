/** Test helpers. Not imported by production code. */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Deck } from '@cac/shared/deck';
import type { Action, GameSettings, GameState } from '@cac/shared/game';
import { createRng } from './rng.ts';
import { buildDeckIndex, createGame, reduce, type EngineContext } from './reduce.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

export function loadDecks(): Deck[] {
  return ['containers', 'sales', 'reliability', 'developers'].map(
    (id) => JSON.parse(readFileSync(join(ROOT, 'decks', `${id}.json`), 'utf8')) as Deck,
  );
}

/** A tiny synthetic deck, for exercising exhaustion and reshuffle paths. */
export function tinyDeck(prompts: number, responses: number, pick = 1): Deck {
  return {
    id: 'tiny',
    name: 'Tiny',
    description: 'test deck',
    defaultEnabled: true,
    attribution: { source: '', license: '', licenseUrl: '', upstreamCommit: '' },
    // Text must be distinct: piles are deduped by card text, so identical
    // prompts would collapse into one and the deck would be smaller than asked.
    prompts: Array.from({ length: prompts }, (_, i) => ({
      id: `t-p-${i}`,
      text: `p${i} ${Array.from({ length: pick }, () => '______').join(' and ')}`,
      blanks: pick,
      pick,
    })),
    responses: Array.from({ length: responses }, (_, i) => ({ id: `t-r-${i}`, text: `r${i}` })),
  };
}

/** A mutable clock + seeded rng, so tests can advance time explicitly. */
export class Harness {
  state: GameState;
  ctx: EngineContext;

  constructor(decks: Deck[], settings: Partial<GameSettings> = {}, seed = 1, now = 1_000) {
    this.ctx = { now, rng: createRng(seed), decks: buildDeckIndex(decks) };
    this.state = createGame('TEST', this.ctx, settings);
  }

  dispatch(action: Action): GameState {
    this.state = reduce(this.state, action, this.ctx);
    return this.state;
  }

  advance(ms: number): void {
    this.ctx.now += ms;
  }

  /** Jump to the current deadline and fire the timeout, as the scheduler would. */
  fireDeadline(): GameState {
    if (this.state.deadline === null) throw new Error('no deadline set');
    this.ctx.now = this.state.deadline;
    return this.dispatch({ type: 'timeout' });
  }

  join(...names: string[]): void {
    for (const name of names) this.dispatch({ type: 'join', playerId: name, name });
  }

  /** Every non-czar connected player plays the first legal cards in hand. */
  submitAll(except: string[] = []): void {
    const prompt = this.ctx.decks.prompts.get(this.state.promptId!)!;
    for (const id of [...this.state.seatOrder]) {
      const player = this.state.players[id];
      if (!player?.connected || id === this.state.czarId || except.includes(id)) continue;
      if (this.state.submissions.some((s) => s.playerId === id)) continue;
      this.dispatch({ type: 'submit', playerId: id, cards: player.hand.slice(0, prompt.pick) });
    }
  }
}

/**
 * Total response cards in existence. Must never change: cards move between
 * hands, submissions and piles, but none may be created or lost.
 */
export function countResponses(state: GameState): number {
  return (
    state.responseDraw.length +
    state.responseDiscard.length +
    Object.values(state.players).reduce((n, p) => n + p.hand.length, 0) +
    state.submissions.reduce((n, s) => n + s.cards.length, 0)
  );
}

export function countPrompts(state: GameState): number {
  return state.promptDraw.length + state.promptDiscard.length + (state.promptId ? 1 : 0);
}
