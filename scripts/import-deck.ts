/**
 * One-time deck importer. Reads the vendored upstream sources from
 * decks/source/<deck>/ and writes normalized JSON to decks/.
 *
 * Run: node scripts/import-deck.ts
 *
 * This is NOT run at server boot. The generated JSON is committed so the game
 * has no build-time network dependency and the decks can't shift under us.
 *
 * Two upstream formats are supported, because the decks come from unrelated
 * projects:
 *
 *   quoted — every line wrapped in double quotes, blanks as runs of
 *            underscores. Used by the Cards Against Containers repo.
 *   latex  — plain lines with `\BLANK` markers and stray LaTeX escapes,
 *            because those decks are typeset to PDF. Used by the Cards
 *            Against Reliability / Developers family.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BLANK, BLANK_RUN, type Deck, type PromptCard, type ResponseCard } from '../packages/shared/src/deck.ts';
import { blockedTerm } from '../packages/shared/src/content-filter.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'decks', 'source');
const OUT = join(ROOT, 'decks');

/**
 * quoted — every line wrapped in double quotes, blanks as runs of
 *          underscores. The Cards Against Containers repo.
 * latex  — plain lines with `\BLANK` and stray LaTeX escapes, because those
 *          decks are typeset to printable PDFs.
 * plain  — one card per line, exactly as written. Used by the decks authored
 *          for this project, so adding a card means editing a text file.
 */
type Format = 'quoted' | 'latex' | 'plain';

interface DeckSource {
  id: string;
  name: string;
  description: string;
  defaultEnabled: boolean;
  format: Format;
  dir: string;
  promptFile: string;
  responseFile: string;
  source: string;
  license: string;
  licenseUrl: string;
  /** Prefix for card ids. Must be unique across decks, or one deck's cards
   *  would overwrite another's in the engine's id map. */
  prefix: string;
}

const CC_BY_NC_SA_2 = {
  license: 'CC BY-NC-SA 2.0',
  licenseUrl: 'https://creativecommons.org/licenses/by-nc-sa/2.0/',
};

const SOURCES: DeckSource[] = [
  {
    id: 'containers',
    name: 'Cards Against Containers',
    description: 'The original container and Kubernetes deck.',
    defaultEnabled: true,
    format: 'quoted',
    dir: 'containers',
    promptFile: 'questions.txt',
    responseFile: 'answers.txt',
    source: 'https://github.com/cardsagainstcontainers/deck',
    prefix: 'c',
    ...CC_BY_NC_SA_2,
  },
  {
    id: 'sales',
    name: 'Cards Against Sales',
    description: 'The sales expansion pack.',
    defaultEnabled: false,
    format: 'quoted',
    dir: 'containers',
    promptFile: 'cas_questions.txt',
    responseFile: 'cas_answers.txt',
    source: 'https://github.com/cardsagainstcontainers/deck',
    prefix: 's',
    ...CC_BY_NC_SA_2,
  },
  {
    id: 'reliability',
    name: 'Cards Against Reliability',
    description: 'For engineers who carry a pager. SRE and incident humour.',
    defaultEnabled: false,
    format: 'latex',
    dir: 'reliability',
    promptFile: 'black.txt',
    responseFile: 'white.txt',
    source: 'https://github.com/dastergon/CardsAgainstReliability',
    prefix: 'r',
    ...CC_BY_NC_SA_2,
  },
  {
    id: 'developers',
    name: 'Cards Against Developers',
    description: 'Stack Overflow, legacy code and other daily indignities.',
    defaultEnabled: false,
    format: 'latex',
    dir: 'developers',
    promptFile: 'black.txt',
    responseFile: 'white.txt',
    source: 'https://github.com/crashtest-security/CardsAgainstDevelopers',
    prefix: 'd',
    ...CC_BY_NC_SA_2,
  },
];

/**
 * Decks written for this project rather than vendored from another repository.
 *
 * Their card ids are prefixed with the deck id, so they can never collide with
 * the shorter prefixes the vendored decks use.
 */
const ORIGINAL = {
  source: 'https://github.com/cardsagainstcontainers/deck',
  license: 'CC BY-NC-SA 4.0',
  licenseUrl: 'https://creativecommons.org/licenses/by-nc-sa/4.0/',
};

for (const [id, name, description] of [
  ['terraform-gitlab', 'Cards Against Terraform', 'State files, pipelines, and the plan nobody read.'],
  ['openshift', 'Cards Against OpenShift', 'CrashLoopBackOff, SCCs and the cluster upgrade.'],
  ['nutanix', 'Cards Against Nutanix', 'CVMs, Curator scans and one-click upgrades.'],
] as const) {
  SOURCES.push({
    id,
    name,
    description,
    // Off by default: shipped for teams who want them, not imposed on
    // everyone who starts a game.
    defaultEnabled: false,
    format: 'plain',
    dir: id,
    promptFile: 'prompts.txt',
    responseFile: 'responses.txt',
    prefix: id,
    ...ORIGINAL,
  });
}

const removed: { deck: string; kind: string; text: string; term: string }[] = [];

/** True when a card should not ship. Records why, so the run is auditable. */
function isBlocked(text: string, deck: string, kind: string): boolean {
  const term = blockedTerm(text);
  if (!term) return false;
  removed.push({ deck, kind, text, term });
  return true;
}

/** Tracks what the importer actually changed, so normalization is auditable. */
const stats = {
  doubleEncodedFixed: 0,
  entitiesDecoded: 0,
  blanksNormalized: 0,
  latexStripped: 0,
  whitespaceCollapsed: 0,
};

/**
 * Upstream has a double-encoding artifact: `&#44;#44;` where a comma was
 * encoded twice. Decoding naively leaves a literal `,#44;` in the card text.
 */
function fixDoubleEncoding(s: string): string {
  const fixed = s.replace(/&#(\d+);(?:#\1;)+/g, '&#$1;');
  if (fixed !== s) stats.doubleEncodedFixed++;
  return fixed;
}

/** Decode numeric HTML entities (&#44; &#34; &#37;) present in the sales deck. */
function decodeEntities(s: string): string {
  const decoded = s.replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)));
  if (decoded !== s) stats.entitiesDecoded++;
  return decoded;
}

/** Strip the wrapping double quotes every line of a quoted-format deck carries. */
function stripWrappingQuotes(s: string): string {
  return s.length >= 2 && s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1) : s;
}

/**
 * Undo the LaTeX these decks are typeset with. They are written to be compiled
 * into printable PDFs, so a handful of cards carry markup that would otherwise
 * show up verbatim on screen.
 */
function stripLatex(s: string): string {
  const before = s;
  let out = s
    .replace(/\\BLANK/g, BLANK)
    // \texttt{Ctrl+F} -> Ctrl+F
    .replace(/\\[a-zA-Z]+\{([^}]*)\}/g, '$1')
    // ``quoted'' -> "quoted"
    .replace(/``/g, '"')
    .replace(/''/g, '"')
    .replace(/\\LaTeX\b/g, 'LaTeX')
    .replace(/\\([%&$#_{}])/g, '$1')
    // Any remaining bare control sequence: keep the word, drop the backslash.
    .replace(/\\([a-zA-Z]+)/g, '$1')
    .replace(/~/g, ' ');
  if (out !== before) stats.latexStripped++;
  return out;
}

/** Collapse the 1-, 6- and 8-underscore variants to one canonical marker. */
function normalizeBlanks(s: string): string {
  const normalized = s.replace(BLANK_RUN, BLANK);
  if (normalized !== s) stats.blanksNormalized++;
  return normalized;
}

function collapseWhitespace(s: string): string {
  const collapsed = s.replace(/\s+/g, ' ').trim();
  if (collapsed !== s) stats.whitespaceCollapsed++;
  return collapsed;
}

/**
 * Note: upstream typos ("commiting", "couldnt", "celebrationg") are left
 * untouched on purpose. Silently editing card text would fork us from the
 * published decks for no gain.
 */
function normalize(line: string, format: Format): string {
  let s = line.trim();
  if (format === 'quoted') {
    s = stripWrappingQuotes(s);
    s = fixDoubleEncoding(s);
    s = decodeEntities(s);
  } else if (format === 'latex') {
    s = stripLatex(s);
  }
  // 'plain' needs no unpicking: it is written the way it is played.
  s = normalizeBlanks(s);
  s = collapseWhitespace(s);
  return s;
}

function readLines(dir: string, file: string): string[] {
  return readFileSync(join(SRC, dir, file), 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('%'));
}

function countBlanks(text: string): number {
  return text.split(BLANK).length - 1;
}

function buildPrompts(src: DeckSource): PromptCard[] {
  const seen = new Set<string>();
  const out: PromptCard[] = [];
  for (const line of readLines(src.dir, src.promptFile)) {
    const text = normalize(line, src.format);
    if (!text || seen.has(text)) {
      if (text) console.warn(`  ! duplicate prompt skipped: ${text.slice(0, 56)}`);
      continue;
    }
    if (isBlocked(text, src.id, 'prompt')) continue;
    seen.add(text);
    const blanks = countBlanks(text);
    out.push({
      id: `${src.prefix}-p-${String(out.length + 1).padStart(3, '0')}`,
      text,
      blanks,
      // A prompt with no blank is a standalone question; it still takes one card.
      pick: Math.max(1, blanks),
    });
  }
  return out;
}

function buildResponses(src: DeckSource): ResponseCard[] {
  const seen = new Set<string>();
  const out: ResponseCard[] = [];
  for (const line of readLines(src.dir, src.responseFile)) {
    const text = normalize(line, src.format);
    if (!text || seen.has(text)) {
      if (text) console.warn(`  ! duplicate response skipped: ${text.slice(0, 56)}`);
      continue;
    }
    if (isBlocked(text, src.id, 'response')) continue;
    seen.add(text);
    out.push({ id: `${src.prefix}-r-${String(out.length + 1).padStart(3, '0')}`, text });
  }
  return out;
}

const prefixes = new Set<string>();
for (const src of SOURCES) {
  if (prefixes.has(src.prefix)) throw new Error(`duplicate card-id prefix: ${src.prefix}`);
  prefixes.add(src.prefix);
}

for (const src of SOURCES) {
  const upstreamCommit = readFileSync(join(SRC, src.dir, '.upstream-sha'), 'utf8').trim();
  const deck: Deck = {
    id: src.id,
    name: src.name,
    description: src.description,
    defaultEnabled: src.defaultEnabled,
    attribution: {
      source: src.source,
      license: src.license,
      licenseUrl: src.licenseUrl,
      upstreamCommit,
    },
    prompts: buildPrompts(src),
    responses: buildResponses(src),
  };

  writeFileSync(join(OUT, `${deck.id}.json`), JSON.stringify(deck, null, 2) + '\n', 'utf8');

  const picks = deck.prompts.reduce<Record<number, number>>((acc, p) => {
    acc[p.pick] = (acc[p.pick] ?? 0) + 1;
    return acc;
  }, {});
  console.log(
    `${deck.id}.json  prompts=${deck.prompts.length} responses=${deck.responses.length} ` +
      `picks=${JSON.stringify(picks)} standalone=${deck.prompts.filter((p) => p.blanks === 0).length}`,
  );
}

console.log('\nnormalization:', stats);
console.log(`\nfiltered ${removed.length} card(s) for sexual content:`);
for (const r of removed) {
  console.log(`  [${r.deck}/${r.kind}] ${r.term.padEnd(8)} ${r.text.slice(0, 62)}`);
}
