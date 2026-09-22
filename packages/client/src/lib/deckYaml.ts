/**
 * Turns a validated deck into the files and commands needed to deploy it.
 *
 * The deck JSON is embedded in the ConfigMap as a YAML block scalar (`|`)
 * rather than a quoted string. Card text is full of apostrophes, quotes and
 * colons — "Why can't I sleep at night?", `LD_PRELOAD: a love story` — and
 * every one of those needs escaping in a quoted scalar. A block scalar takes
 * the content verbatim and only cares about indentation, so there is nothing
 * to get wrong.
 */
import type { Deck } from '@cac/shared/deck';

const INDENT = '    ';

export function deckFileName(deck: Deck): string {
  return `${deck.id}.json`;
}

export function deckJson(deck: Deck): string {
  return JSON.stringify(deck, null, 2) + '\n';
}

/**
 * A ConfigMap containing one deck.
 *
 * `oc create configmap --from-file` does the same job, but emitting YAML lets
 * the deck live in git next to everything else, which is the point of using a
 * ConfigMap over a mounted directory.
 */
export function configMapYaml(deck: Deck, name = 'cac-custom-decks', namespace = ''): string {
  const body = deckJson(deck)
    .split('\n')
    .map((line) => (line.length > 0 ? INDENT + line : ''))
    .join('\n')
    .replace(/\n+$/, '\n');

  return [
    'apiVersion: v1',
    'kind: ConfigMap',
    'metadata:',
    `  name: ${name}`,
    ...(namespace ? [`  namespace: ${namespace}`] : []),
    '  labels:',
    '    app.kubernetes.io/part-of: cards-against-containers',
    'data:',
    `  ${deckFileName(deck)}: |`,
    body.replace(/\n$/, ''),
    '',
  ].join('\n');
}

/** The equivalent imperative command, for people who prefer not to keep YAML. */
export function createCommand(deck: Deck, name = 'cac-custom-decks'): string {
  return `oc create configmap ${name} --from-file=${deckFileName(deck)}`;
}

/** How to point the chart at the ConfigMap once it exists. */
export function helmCommand(name = 'cac-custom-decks'): string {
  return [
    'helm upgrade cac deploy/helm/cards-against-containers \\',
    `  --set customDecks.configMap=${name}`,
  ].join('\n');
}

/** Running it locally: mount a folder instead of a ConfigMap. */
export function podmanCommand(deck: Deck): string {
  return [
    `# put ${deckFileName(deck)} in ~/cac-decks first`,
    'podman run -d --name cac -p 8080:3000 \\',
    '  -v ~/cac-decks:/decks/custom:ro,Z \\',
    '  -e CAC_DECK_DIRS=/decks/custom \\',
    '  docker.io/djfoley01/cards-against-containers:0.2.0',
  ].join('\n');
}
