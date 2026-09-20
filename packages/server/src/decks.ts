/**
 * Deck loading. Reads every JSON file in decks/ at boot, so dropping in a
 * custom pack needs no code change — only a restart.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Deck } from '@cac/shared/deck';

const DECK_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'decks');

export function loadDecks(dir: string = DECK_DIR): Deck[] {
  const decks = readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as Deck)
    .sort((a, b) => a.id.localeCompare(b.id));

  if (decks.length === 0) throw new Error(`no decks found in ${dir}`);
  for (const deck of decks) {
    if (!deck.id || !Array.isArray(deck.prompts) || !Array.isArray(deck.responses)) {
      throw new Error(`malformed deck: ${JSON.stringify(deck).slice(0, 80)}`);
    }
  }
  return decks;
}

export function defaultDeckIds(decks: readonly Deck[]): string[] {
  const enabled = decks.filter((d) => d.defaultEnabled).map((d) => d.id);
  return enabled.length > 0 ? enabled : [decks[0]!.id];
}
