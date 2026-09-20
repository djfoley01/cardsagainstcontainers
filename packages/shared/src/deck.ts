/**
 * Card and deck types. These describe the *normalized* on-disk deck format
 * produced by scripts/import-deck.ts, which is what the server loads at boot.
 */

/** Canonical blank marker written into prompt text by the importer. */
export const BLANK = '______';

/** Matches a run of 2+ underscores. Deliberately not `_+`: card text contains
 *  identifiers like LD_PRELOAD that must survive normalization intact. */
export const BLANK_RUN = /_{2,}/g;

/** A black card: the prompt players answer. */
export interface PromptCard {
  id: string;
  text: string;
  /** Number of blanks in `text`. 0 means a standalone question. */
  blanks: number;
  /** Response cards required to answer. Always >= 1. */
  pick: number;
}

/** A white card: a possible answer. */
export interface ResponseCard {
  id: string;
  text: string;
}

export interface DeckAttribution {
  source: string;
  license: string;
  licenseUrl: string;
  upstreamCommit: string;
}

export interface Deck {
  id: string;
  name: string;
  description: string;
  /** Whether this deck is on by default in a new room. */
  defaultEnabled: boolean;
  attribution: DeckAttribution;
  prompts: PromptCard[];
  responses: ResponseCard[];
}
