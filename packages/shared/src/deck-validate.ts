/**
 * Deck validation, shared by the server and the browser.
 *
 * The server runs this when loading a deck file; the deck builder page runs it
 * live as you type. One implementation on purpose — if the rules lived in two
 * places they would drift, and a deck that looked fine in the builder would
 * fail to load on the server, which is the worst possible time to find out.
 */
import { BLANK, BLANK_RUN, type Deck, type PromptCard, type ResponseCard } from './deck.ts';

/** Deck ids become part of card ids and Helm resource names, so keep them tame. */
export const DECK_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,30}$/;

export const LIMITS = {
  maxNameLength: 60,
  maxDescriptionLength: 200,
  maxCardLength: 300,
  maxPrompts: 2000,
  maxResponses: 5000,
  /** Beyond this a prompt is unplayable: nobody holds that many cards. */
  maxPick: 3,
} as const;

export interface ValidationIssue {
  /** Where the problem is, for pointing at a form field. */
  field: 'id' | 'name' | 'description' | 'prompts' | 'responses';
  message: string;
  /** 1-based line number within prompts/responses, when applicable. */
  line?: number;
}

export interface ValidationResult {
  ok: boolean;
  /** Blocking problems. A deck with any of these will not load. */
  errors: ValidationIssue[];
  /** Playable, but probably not what the author intended. */
  warnings: ValidationIssue[];
  /** The normalized deck, present only when ok is true. */
  deck: Deck | null;
}

export interface DeckInput {
  id: string;
  name: string;
  description?: string;
  /** One prompt per line. Blanks written as runs of underscores. */
  prompts: string[];
  /** One response per line. */
  responses: string[];
  defaultEnabled?: boolean;
  attribution?: Partial<Deck['attribution']>;
}

/** Collapse whitespace and canonicalize blank runs, as the importer does. */
export function normalizeCardText(raw: string): string {
  return raw.replace(BLANK_RUN, BLANK).replace(/\s+/g, ' ').trim();
}

export function countBlanks(text: string): number {
  return text.split(BLANK).length - 1;
}

/**
 * Card ids are namespaced by deck id. Without this a custom deck reusing
 * `c-r-001` would silently replace a real Cards Against Containers card: the
 * engine keys cards by id, so the collision overwrites rather than errors, and
 * the wrong text simply appears on the table.
 */
export function cardId(deckId: string, kind: 'p' | 'r', index: number): string {
  return `${deckId}-${kind}-${String(index + 1).padStart(3, '0')}`;
}

function checkTextList(
  lines: string[],
  field: 'prompts' | 'responses',
  errors: ValidationIssue[],
  warnings: ValidationIssue[],
): string[] {
  const seen = new Map<string, number>();
  const out: string[] = [];

  lines.forEach((raw, i) => {
    const text = normalizeCardText(raw);
    if (text.length === 0) return; // blank lines are just formatting
    if (text.length > LIMITS.maxCardLength) {
      errors.push({
        field,
        line: i + 1,
        message: `Card is ${text.length} characters; the limit is ${LIMITS.maxCardLength}.`,
      });
      return;
    }

    const key = text.toLowerCase();
    const first = seen.get(key);
    if (first !== undefined) {
      warnings.push({
        field,
        line: i + 1,
        message: `Duplicate of line ${first}. It will be dropped.`,
      });
      return;
    }
    seen.set(key, i + 1);

    if (field === 'prompts') {
      const blanks = countBlanks(text);
      if (blanks > LIMITS.maxPick) {
        errors.push({
          field,
          line: i + 1,
          message: `${blanks} blanks is more than the maximum of ${LIMITS.maxPick}.`,
        });
        return;
      }
      if (/_/.test(text) && blanks === 0) {
        warnings.push({
          field,
          line: i + 1,
          message: 'Has a single underscore, which is not treated as a blank. Use at least two.',
        });
      }
    }

    out.push(text);
  });

  return out;
}

export function validateDeck(input: DeckInput): ValidationResult {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];

  const id = (input.id ?? '').trim().toLowerCase();
  if (id.length === 0) {
    errors.push({ field: 'id', message: 'An id is required.' });
  } else if (!DECK_ID_PATTERN.test(id)) {
    errors.push({
      field: 'id',
      message: 'Use 2-31 characters: lowercase letters, numbers and hyphens, starting with a letter or number.',
    });
  }

  const name = (input.name ?? '').trim();
  if (name.length === 0) {
    errors.push({ field: 'name', message: 'A name is required — it labels the checkbox in the lobby.' });
  } else if (name.length > LIMITS.maxNameLength) {
    errors.push({ field: 'name', message: `Name is longer than ${LIMITS.maxNameLength} characters.` });
  }

  const description = (input.description ?? '').trim();
  if (description.length > LIMITS.maxDescriptionLength) {
    errors.push({
      field: 'description',
      message: `Description is longer than ${LIMITS.maxDescriptionLength} characters.`,
    });
  }

  const promptTexts = checkTextList(input.prompts ?? [], 'prompts', errors, warnings);
  const responseTexts = checkTextList(input.responses ?? [], 'responses', errors, warnings);

  if (promptTexts.length === 0) errors.push({ field: 'prompts', message: 'At least one prompt is required.' });
  if (responseTexts.length === 0) errors.push({ field: 'responses', message: 'At least one answer is required.' });
  if (promptTexts.length > LIMITS.maxPrompts) {
    errors.push({ field: 'prompts', message: `More than ${LIMITS.maxPrompts} prompts.` });
  }
  if (responseTexts.length > LIMITS.maxResponses) {
    errors.push({ field: 'responses', message: `More than ${LIMITS.maxResponses} answers.` });
  }

  // Advice, not rules: a small deck is fine when combined with others, but a
  // deck played on its own needs enough answers to deal everyone a hand.
  if (responseTexts.length > 0 && responseTexts.length < 120) {
    warnings.push({
      field: 'responses',
      message: `${responseTexts.length} answers is fine alongside other decks, but a full table needs about 120 to play this deck on its own.`,
    });
  }
  if (promptTexts.length > 0 && promptTexts.length < 10) {
    warnings.push({
      field: 'prompts',
      message: `${promptTexts.length} prompts will repeat quickly once the pile is reshuffled.`,
    });
  }

  if (errors.length > 0) return { ok: false, errors, warnings, deck: null };

  const prompts: PromptCard[] = promptTexts.map((text, i) => {
    const blanks = countBlanks(text);
    return { id: cardId(id, 'p', i), text, blanks, pick: Math.max(1, blanks) };
  });
  const responses: ResponseCard[] = responseTexts.map((text, i) => ({ id: cardId(id, 'r', i), text }));

  return {
    ok: true,
    errors,
    warnings,
    deck: {
      id,
      name,
      description,
      defaultEnabled: input.defaultEnabled ?? false,
      attribution: {
        source: input.attribution?.source ?? '',
        license: input.attribution?.license ?? '',
        licenseUrl: input.attribution?.licenseUrl ?? '',
        upstreamCommit: input.attribution?.upstreamCommit ?? '',
      },
      prompts,
      responses,
    },
  };
}

/** Validate a deck that already exists as a parsed JSON object. */
export function validateDeckJson(value: unknown): ValidationResult {
  if (typeof value !== 'object' || value === null) {
    return { ok: false, errors: [{ field: 'id', message: 'Not a JSON object.' }], warnings: [], deck: null };
  }
  const raw = value as Record<string, unknown>;
  const cards = (key: string): string[] => {
    const list = raw[key];
    if (!Array.isArray(list)) return [];
    return list.map((c) =>
      typeof c === 'string' ? c : typeof (c as { text?: unknown })?.text === 'string' ? String((c as { text: string }).text) : '',
    );
  };

  return validateDeck({
    id: String(raw['id'] ?? ''),
    name: String(raw['name'] ?? ''),
    description: raw['description'] === undefined ? '' : String(raw['description']),
    prompts: cards('prompts'),
    responses: cards('responses'),
    defaultEnabled: raw['defaultEnabled'] === true,
    attribution: (raw['attribution'] as Deck['attribution'] | undefined) ?? {},
  });
}
