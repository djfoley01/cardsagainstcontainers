import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { validateDeck } from '@cac/shared/deck-validate';
import { configMapYaml, deckFileName, deckJson } from './deckYaml.ts';

/** Card text that would break a naively quoted YAML scalar. */
const NASTY = [
  "Why can't I sleep at night?",
  'LD_PRELOAD: a love story',
  'He said "ship it" and left',
  "It's 100% fine, probably",
  'A line with: a colon and a #hash',
  'Trailing whitespace   ',
  'Unicode — em dash, curly ’quote’, emoji 🚢',
  '- looks like a yaml list item',
  '{ looks like a flow mapping }',
];

function build() {
  const result = validateDeck({
    id: 'nasty',
    name: 'Nasty: the "deck"',
    description: "Everything that breaks YAML, isn't it",
    prompts: ['Deploying ______ on a Friday.', ...NASTY],
    responses: NASTY,
  });
  assert.ok(result.ok, JSON.stringify(result.errors));
  return result.deck!;
}

describe('ConfigMap generation', () => {
  test('the embedded deck round-trips back to identical JSON', () => {
    const deck = build();
    const yaml = configMapYaml(deck);

    // Pull the block scalar back out: everything indented under the key.
    const key = `  ${deckFileName(deck)}: |`;
    const start = yaml.indexOf(key);
    assert.ok(start >= 0, 'data key not found');
    const body = yaml
      .slice(start + key.length + 1)
      .split('\n')
      .map((l) => (l.startsWith('    ') ? l.slice(4) : l))
      .join('\n');

    const parsed = JSON.parse(body);
    assert.deepEqual(parsed, JSON.parse(deckJson(deck)), 'deck did not survive the round trip');
    for (const text of NASTY) {
      assert.ok(
        parsed.responses.some((r: { text: string }) => r.text === text.trim()),
        `lost or mangled: ${text}`,
      );
    }
  });

  test('every content line is indented under the block scalar', () => {
    const yaml = configMapYaml(build());
    const key = yaml.split('\n').findIndex((l) => l.trimStart().startsWith('nasty.json:'));
    const body = yaml.split('\n').slice(key + 1).filter((l) => l.length > 0);
    for (const line of body) {
      assert.ok(line.startsWith('    '), `unindented line would break the YAML: ${JSON.stringify(line)}`);
    }
  });

  test('the header is well formed and carries the namespace only when given', () => {
    const deck = build();
    const plain = configMapYaml(deck, 'my-decks');
    assert.ok(plain.startsWith('apiVersion: v1\nkind: ConfigMap\n'));
    assert.ok(plain.includes('  name: my-decks'));
    assert.ok(!plain.includes('namespace:'));

    const scoped = configMapYaml(deck, 'my-decks', 'happyhour');
    assert.ok(scoped.includes('  namespace: happyhour'));
  });

  test('the data key matches the filename the loader expects', () => {
    const deck = build();
    assert.equal(deckFileName(deck), 'nasty.json');
    assert.ok(configMapYaml(deck).includes('  nasty.json: |'));
  });

  test('deck json ends with a newline, as a file should', () => {
    assert.ok(deckJson(build()).endsWith('}\n'));
  });
});
