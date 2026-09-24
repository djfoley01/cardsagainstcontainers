import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadDecksDetailed, defaultDeckIds, extraDeckDirsFromEnv, BUILTIN_DECK_DIR } from './decks.ts';

let extra: string;

beforeEach(() => {
  extra = mkdtempSync(join(tmpdir(), 'cac-decks-'));
});
afterEach(() => {
  rmSync(extra, { recursive: true, force: true });
});

function writeDeck(name: string, deck: unknown): void {
  writeFileSync(join(extra, name), JSON.stringify(deck), 'utf8');
}

const goodDeck = {
  id: 'myteam',
  name: 'My Team',
  description: 'Inside jokes',
  prompts: ['Our standup is mostly ______.', 'What broke production?'],
  responses: ['Dave', 'A rogue cron job', 'The intern'],
};

describe('loading built-in decks', () => {
  test('loads the four shipped decks with no extra dirs', () => {
    const { decks, problems } = loadDecksDetailed({ extraDirs: [] });
    assert.deepEqual(decks.map((d) => d.id).sort(), [
      'containers', 'developers', 'nutanix', 'openshift', 'reliability', 'sales', 'terraform-gitlab',
    ]);
    assert.deepEqual(problems, []);
  });

  test('throws only if the built-in directory yields nothing', () => {
    assert.throws(() => loadDecksDetailed({ builtinDir: join(extra, 'nope') }), /no built-in decks/);
  });

  test('defaultDeckIds picks the decks marked on', () => {
    const { decks } = loadDecksDetailed({ extraDirs: [] });
    assert.deepEqual(defaultDeckIds(decks), ['containers']);
  });
});

describe('loading custom decks', () => {
  test('a valid custom deck is added alongside the built-ins', () => {
    writeDeck('myteam.json', goodDeck);
    const { decks, problems } = loadDecksDetailed({ extraDirs: [extra] });
    assert.equal(decks.length, 8);
    const mine = decks.find((d) => d.id === 'myteam')!;
    assert.equal(mine.name, 'My Team');
    assert.equal(mine.prompts.length, 2);
    assert.equal(mine.responses.length, 3);
    assert.equal(problems.filter((p) => p.includes('invalid')).length, 0);
  });

  test('card ids are namespaced so they cannot collide with a shipped deck', () => {
    // The dangerous case: a custom deck reusing a containers id. Without
    // namespacing the engine's id map would silently overwrite the real card.
    writeDeck('evil.json', {
      ...goodDeck,
      id: 'evil',
      prompts: [{ id: 'c-p-001', text: 'Hijacked ______.' }],
      responses: [{ id: 'c-r-001', text: 'Hijacked answer' }],
    });
    const { decks } = loadDecksDetailed({ extraDirs: [extra] });
    const evil = decks.find((d) => d.id === 'evil')!;
    assert.equal(evil.prompts[0]!.id, 'evil-p-001');
    assert.equal(evil.responses[0]!.id, 'evil-r-001');

    const ids = new Set<string>();
    for (const deck of decks) {
      for (const card of [...deck.prompts, ...deck.responses]) {
        assert.ok(!ids.has(card.id), `duplicate card id ${card.id}`);
        ids.add(card.id);
      }
    }
  });

  test('a custom deck cannot shadow a built-in deck id', () => {
    writeDeck('fake.json', { ...goodDeck, id: 'containers' });
    const { decks, problems } = loadDecksDetailed({ extraDirs: [extra] });
    assert.equal(decks.filter((d) => d.id === 'containers').length, 1);
    assert.equal(decks.find((d) => d.id === 'containers')!.prompts.length, 103);
    assert.ok(problems.some((p) => p.includes('already used by')));
  });

  test('accepts cards as plain strings or as card objects', () => {
    writeDeck('objects.json', {
      id: 'objs',
      name: 'Objects',
      prompts: [{ text: 'Object form ______.' }],
      responses: [{ text: 'works' }, 'and so do strings'],
    });
    const { decks } = loadDecksDetailed({ extraDirs: [extra] });
    const deck = decks.find((d) => d.id === 'objs')!;
    assert.equal(deck.prompts.length, 1);
    assert.equal(deck.responses.length, 2);
  });

  test('pick count is derived from the blanks in the text', () => {
    writeDeck('picks.json', {
      ...goodDeck,
      id: 'picks',
      prompts: ['One ______.', 'Two ______ and ______.', 'No blank at all?'],
    });
    const { decks } = loadDecksDetailed({ extraDirs: [extra] });
    const deck = decks.find((d) => d.id === 'picks')!;
    assert.deepEqual(deck.prompts.map((p) => p.pick), [1, 2, 1]);
    assert.deepEqual(deck.prompts.map((p) => p.blanks), [1, 2, 0]);
  });

  test('several custom directories are all searched, in order', () => {
    const second = mkdtempSync(join(tmpdir(), 'cac-decks2-'));
    try {
      writeDeck('a.json', { ...goodDeck, id: 'deck-a' });
      writeFileSync(join(second, 'b.json'), JSON.stringify({ ...goodDeck, id: 'deck-b' }), 'utf8');
      const { decks } = loadDecksDetailed({ extraDirs: [extra, second] });
      assert.ok(decks.some((d) => d.id === 'deck-a'));
      assert.ok(decks.some((d) => d.id === 'deck-b'));
    } finally {
      rmSync(second, { recursive: true, force: true });
    }
  });
});

describe('bad custom decks never take the server down', () => {
  test('malformed JSON is skipped and reported', () => {
    writeFileSync(join(extra, 'broken.json'), '{ this is not json', 'utf8');
    writeDeck('fine.json', goodDeck);
    const { decks, problems } = loadDecksDetailed({ extraDirs: [extra] });
    assert.ok(decks.some((d) => d.id === 'myteam'), 'a good deck beside a broken one should still load');
    assert.ok(problems.some((p) => p.includes('broken.json')));
  });

  test('a deck missing required fields is skipped with a reason', () => {
    writeDeck('nameless.json', { id: 'nameless', prompts: ['a ______'], responses: ['b'] });
    const { decks, problems } = loadDecksDetailed({ extraDirs: [extra] });
    assert.ok(!decks.some((d) => d.id === 'nameless'));
    assert.ok(problems.some((p) => p.includes('name')), `expected a name error, got: ${problems.join(' | ')}`);
  });

  test('a deck with no cards is skipped', () => {
    writeDeck('empty.json', { id: 'empty', name: 'Empty', prompts: [], responses: [] });
    const { decks, problems } = loadDecksDetailed({ extraDirs: [extra] });
    assert.ok(!decks.some((d) => d.id === 'empty'));
    assert.ok(problems.some((p) => p.includes('empty.json')));
  });

  test('a bad deck id is rejected', () => {
    writeDeck('shouty.json', { ...goodDeck, id: 'Not Valid!' });
    const { decks, problems } = loadDecksDetailed({ extraDirs: [extra] });
    assert.equal(decks.length, 7);
    assert.ok(problems.some((p) => p.includes('shouty.json')));
  });

  test('non-json files and ConfigMap symlink shims are ignored', () => {
    writeFileSync(join(extra, 'README.md'), '# not a deck', 'utf8');
    writeFileSync(join(extra, '.hidden.json'), '{}', 'utf8');
    mkdirSync(join(extra, '..2026_01_01_00_00_00.123456'), { recursive: true });
    writeDeck('real.json', goodDeck);
    const { decks, problems } = loadDecksDetailed({ extraDirs: [extra] });
    assert.ok(decks.some((d) => d.id === 'myteam'));
    assert.deepEqual(problems.filter((p) => p.includes('README') || p.includes('hidden')), []);
  });

  test('a directory that does not exist is not an error', () => {
    const { decks, problems } = loadDecksDetailed({ extraDirs: [join(extra, 'not-created-yet')] });
    assert.equal(decks.length, 7);
    assert.deepEqual(problems, []);
  });
});

describe('deck directories from the environment', () => {
  test('parses a colon-separated list, like PATH', () => {
    assert.deepEqual(extraDeckDirsFromEnv({ CAC_DECK_DIRS: '/a:/b:/c' }), ['/a', '/b', '/c']);
  });

  test('empty or unset means no extra directories', () => {
    assert.deepEqual(extraDeckDirsFromEnv({}), []);
    assert.deepEqual(extraDeckDirsFromEnv({ CAC_DECK_DIRS: '' }), []);
    assert.deepEqual(extraDeckDirsFromEnv({ CAC_DECK_DIRS: ' : ' }), []);
  });
});

describe('built-in directory', () => {
  test('points at the repository decks folder', () => {
    assert.ok(BUILTIN_DECK_DIR.endsWith('decks'), BUILTIN_DECK_DIR);
  });
});
