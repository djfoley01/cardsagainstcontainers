# Custom decks

The decks shipped in the image are always available. Additional decks are read
from any directory listed in `CAC_DECK_DIRS` (colon-separated, like `PATH`).

The server **watches those directories**, so a deck added during the evening
takes effect without a restart — and a restart would end every game in
progress.

## Decks that ship in the image

Seven decks ship built in; only Cards Against Containers is on by default. The
other six are toggled in the lobby, and the three written for this project —
Terraform, OpenShift and Nutanix — keep their cards as plain text under
`decks/source/<deck>/prompts.txt` and `responses.txt`. To add or reword a card,
edit the text file and regenerate:

```sh
npm run deck:import
```

That path is for decks that belong in the repository. Everything below is for
decks that do not.

## Writing a deck

Open **`/decks`** in the running app, or follow the "Make your own deck" link on
the landing page. Type your cards, and it validates as you go using the same
rules the server applies when loading a file, so a deck that looks clean in the
builder is guaranteed to load. It then gives you the deck JSON and
ready-to-apply ConfigMap YAML.

Writing one by hand is fine too:

```json
{
  "id": "myteam",
  "name": "My Team",
  "description": "Inside jokes, mostly about the deploy pipeline",
  "prompts": [
    "Our standup is mostly ______.",
    "We replaced ______ with ______.",
    "What broke production?"
  ],
  "responses": ["A rogue cron job", "Blaming DNS", "The intern's first PR"]
}
```

- Blanks are **two or more underscores**. Two blanks makes it a pick-2 card; a
  line with no blank becomes a straight question.
- `id` must be lowercase letters, numbers and hyphens, and must not match a
  built-in deck.
- Cards may be plain strings, as above, or objects with a `text` field. Any
  `id` you supply is ignored and regenerated — see below.

## How many cards you need

A game refuses to start if the enabled decks cannot deal every player a full
hand: **players × hand size**, so 30 cards for three players, 120 for a full
table of twelve.

This is checked rather than left to chance because the failure is quiet
otherwise: the deal runs dry part-way through the seat order, the players at
the end get nothing, and the round waits forever on people who physically
cannot play.

A small deck is perfectly good **alongside** others — only the combined total
matters. The builder warns below 120 answers for this reason rather than
refusing.

## Running locally

```sh
mkdir -p ~/cac-decks && cp myteam.json ~/cac-decks/

podman run -d --name cac -p 8080:3000 \
  -v ~/cac-decks:/decks/custom:ro,Z \
  -e CAC_DECK_DIRS=/decks/custom \
  docker.io/djfoley01/cards-against-containers:0.3.0
```

Drop another file into `~/cac-decks` and it appears in the lobby within a
second or two, no restart.

## On OpenShift with a ConfigMap

```sh
oc create configmap cac-custom-decks --from-file=myteam.json

helm upgrade cac deploy/helm/cards-against-containers \
  --set customDecks.configMap=cac-custom-decks
```

Or apply the YAML the builder generates, which keeps the deck in git alongside
everything else.

To add a deck later, update the ConfigMap. The kubelet syncs mounted
ConfigMaps in place, so the running pod picks it up on its own:

```sh
oc create configmap cac-custom-decks \
  --from-file=myteam.json --from-file=another.json \
  --dry-run=client -o yaml | oc apply -f -
```

The ConfigMap is mounted `optional: true`, so it may be created after the app
without breaking anything. All four built-in decks total about 107 KB against
a ConfigMap's 1 MiB limit, so size is rarely the constraint people expect.

## With a PersistentVolumeClaim

Only needed if decks must be writable or exceed the ConfigMap limit:

```sh
helm upgrade cac deploy/helm/cards-against-containers \
  --set customDecks.persistentVolumeClaim=cac-decks
```

A read-write-once claim is fine: this app runs a single replica by design, and
the Deployment uses `Recreate`, so two pods never contend for the volume.

## What happens to a bad deck

A custom deck is untrusted input, so it is validated on load and a bad one is
**skipped with a logged reason** rather than taking the server down. A typo in
someone's deck must not stop the game starting.

```
deck: /decks/custom/oops.json: invalid deck, skipped — name: A name is required
```

Card ids are always regenerated as `<deck-id>-p-001`, `<deck-id>-r-001`. This
is not cosmetic: the engine keys cards by id, so a custom deck reusing
`c-r-001` would silently *replace* a real Cards Against Containers card — the
wrong text would simply appear on the table, with no error anywhere.

A custom deck also cannot reuse a built-in deck's `id`; the lobby keys decks by
id and two decks sharing one would be indistinguishable there.

## What reloading does to a game in progress

Nothing. Rooms snapshot their decks when created:

- **Rooms in the lobby** adopt the new deck list, so it appears in front of you.
- **Games already under way** keep the decks they were dealt from. Every card
  in hand is referenced by id; swapping the deck under a live game would make
  cards vanish from players' hands.
- If a deck you had enabled disappears, the lobby drops it from the selection
  rather than failing.
