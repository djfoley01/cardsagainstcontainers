# Cards Against Containers — Online

A web version of [Cards Against Containers](https://github.com/cardsagainstcontainers/deck)
for distributed teams. Players join a room from wherever they are and play together
over a video call.

Built for team happy hours. Not affiliated with Sysdig or Cards Against Humanity.

## Status

In development. See `docs/` for design decisions.

| Milestone | State |
| --- | --- |
| 1. Deck import and normalization | Done |
| 2. Game engine + tests | Done |
| 3. Server (rooms, sockets) | Done |
| 4. Client core (join, lobby, hand) | Done |
| 5. Judging, reveal, scoreboard | Done |
| 6. Timers, disconnects, host controls | Done |
| 7. Container image + deployment | Image and Helm chart done |

## Layout

```
decks/            normalized deck JSON (generated, committed)
decks/source/     vendored upstream .txt files, pinned to a commit
scripts/          one-time import tooling
packages/shared/  types shared by client and server
packages/server/  Fastify + Socket.IO game server
packages/client/  React + Vite + Tailwind client
docs/             architecture decision records
```

## Decks

| Deck | Prompts | Responses | Licence | Default |
| --- | --- | --- | --- | --- |
| Cards Against Containers | 103 | 271 | CC BY-NC-SA 2.0 | on |
| Cards Against Sales | 79 | 172 | CC BY-NC-SA 2.0 | off |
| Cards Against Reliability | 78 | 203 | CC BY-NC-SA 2.0 | off |
| Cards Against Developers | 61 | 157 | CC BY-NC-SA 2.0 | off |

All four are togglable in the lobby, and the lobby list is built from whatever
the server loaded rather than hardcoded — dropping a new JSON file into
`decks/` and restarting is enough to add a deck.

Deck JSON is generated from the vendored `.txt` files and committed, so the game
has no build-time network dependency and upstream edits can't shift the deck
under a running game. To refresh from upstream, update `decks/source/` and run:

```sh
npm run deck:import
```

## Development

```sh
npm install
npm test           # strip check + typecheck + 131 tests

# Two terminals for development:
npm run dev        # game server on :3000
npm run dev:client # Vite on :5173, proxies the socket to :3000

# Or build the client and let the server host everything on :3000:
npm run build && npm start
```

### Testing with several players on one machine

`localStorage` is shared across every window of a browser profile, and all
incognito windows share a single partition. Three windows therefore produce
**one** identity, and the server reads the second and third joins as the first
player reconnecting — so the room never reaches three players.

Add `?seat=` to give each window its own identity:

```
http://localhost:5173/?seat=1
http://localhost:5173/?seat=2
http://localhost:5173/?seat=3
```

Create the room in seat 1, then join from 2 and 3 with the code. The parameter
namespaces the stored keys, survives reloads, and is preserved when the app
rewrites the address bar. It is only needed for local testing — real players on
their own machines get distinct identities anyway — and the invite link the
lobby copies never includes it.

TypeScript runs directly under Node 26's native type stripping, so there is no
build step in development.

Strip-only mode erases types but generates no code, so **parameter properties,
enums and namespaces fail at import time** — and `tsc` will not warn you,
because they are valid TypeScript. `npm run check:strip` runs Node's own
stripper over every source file to catch this before it reaches a test run.
Write parameter properties longhand; use const objects instead of enums.

## Game engine

The engine (`packages/server/src/engine`) is a pure reducer:
`(state, action, context) => state`. It never touches sockets, timers,
`Date.now()` or `Math.random()` — time and randomness arrive through the
context, so the full round lifecycle is testable and any bug is reproducible
from a seed. The socket layer is a thin shell that feeds actions in and
broadcasts the result.

Rules worth knowing:

- A czar who drops mid-judge gets a 20s grace, then the engine picks a winner
  so a closed laptop can't wedge the round. This applies even with timers off.
- A czar who *leaves* mid-round causes the round to be discarded rather than
  handing judging to someone who may have already submitted.
- Disconnected players keep their seat, hand and score for 2 minutes, and stop
  blocking the round immediately.
- Dropping below 3 connected players parks the game; it resumes when someone
  returns.
- **Any player can pause**, not just the host — the moment someone wants to
  hold the game is usually the moment a card lands, and that person may not be
  the host. A pause holds the clock, not the game: cards can still be played
  and judged while it runs.
- Cards are conserved: a test asserts no response card is ever created or lost
  across rounds, reshuffles and players leaving.

## Server

One Fastify process serves the built client and the Socket.IO game socket, with
all rooms in memory. Room codes are 4 letters from a 24-character alphabet that
excludes I and O, since those read as 1 and 0 when someone says a code aloud on
a call.

`packages/server/src/redact.ts` is a security boundary, not a convenience.
Everything the server sends reaches the browser, so anything a player must not
see is withheld there rather than merely left unrendered:

- a hand goes only to the player holding it
- draw piles are reduced to counts
- **during judging, submissions carry no player id at all** — the czar sees
  cards and picks by shuffled reveal index, and the server maps that index back
  to a player

Client actions carry no identity: the server takes it from the socket session,
so a player cannot act as someone else by editing a payload. End-to-end tests
assert all of this over a real socket connection, not just as unit tests.

## Client

React and Tailwind, bundled by Vite. The client holds no game logic: it renders
whatever state the server last sent and sends back intents. That is why a
reconnect needs no reconciliation — the next state frame is the truth.

- Identity is a random id in `localStorage`, so a refresh, a closed laptop or a
  dropped connection resumes the same seat, hand and score. It is not a
  credential; it names a seat in a party game.
- The socket tries HTTP long-polling first and upgrades to WebSocket, so a
  player behind a proxy that blocks upgrades still gets in.
- Timers are display only. The deadline is an absolute server timestamp, so a
  slow clock or a backgrounded tab can never disagree with the game.
- Sharing `/<ROOMCODE>` works on a cold load: the server falls through unknown
  paths to `index.html` and the join screen prefills the code.

Submissions appear one at a time during judging, which gives the czar a natural
rhythm for reading them aloud. The stagger is client-side only, derived from
the server's shuffled reveal order, so every player sees the same sequence
without extra round trips. Deliberately *not* a click-to-flip interaction: one
player flipping a card locally would not show for anyone else, and a synced
version would mean putting reveal state in the engine for little gain.

During judging the prompt is rendered with each submission filled into its
blanks, so the joke lands without the czar holding the wording in their head.

### Pausing

Every deadline in the engine is set through one pause-aware helper, so holding
the clock works in any phase rather than only where it was thought about.
`paused` is tracked separately from `deadline === null`, because that already
means two other things: an untimed setting, and a game parked below the player
minimum.

### Host controls

The host's escape hatches live behind a collapsed panel so they aren't hit by
accident:

- **Move it along** forces a stalled phase to advance. With timers switched
  off, one quiet player or an idle czar would otherwise stall the round
  indefinitely, and the only other way out would be ending the game. It runs
  the same transition a deadline does, and works through a pause — that case is
  exactly what it exists for.
- **Timers and the score target are adjustable mid-game.** A host usually only
  discovers the round length is wrong once play is under way. Decks and hand
  size stay lobby-only, since both mean reshuffling under live hands. Lowering
  the target below someone's score ends the game rather than leaving it
  unwinnable in reverse.
- **Host hand-off** is explicit as well as automatic; the automatic migration
  still covers a host who simply leaves.

Kicking a player and ending a game are two-step buttons. Both are single
clicks sitting beside ordinary controls, and both are unrecoverable mid-game.

Because rooms live in memory, a server restart ends them. The client detects
this on reconnect — its rejoin comes back `NO_SUCH_ROOM` — and returns to the
join screen saying so, rather than leaving a stale board on screen.

While paused:

- phases cannot expire, including via a stray or replayed timeout
- a phase entered while paused *banks* its time instead of starting it, and
  resume converts it back
- the czar-disconnect grace is banked the same way
- disconnected players are not evicted — a long pause should not quietly remove
  someone who is sitting right there

The importer handles two upstream formats, because the decks come from
unrelated projects:

- **quoted** — every line wrapped in double quotes, blanks as runs of
  underscores, some HTML entities including one double-encoded comma.
- **latex** — plain lines with `\BLANK` markers and stray LaTeX escapes
  (`\texttt{...}`, `\%`, ` ``quoted'' `), because those decks are typeset to
  printable PDFs.

It deliberately leaves upstream typos alone, and deliberately does not treat
single underscores as blanks — card text contains identifiers like
`LD_PRELOAD`.

### Content filter

Sexual content is filtered out at import: this is a workplace happy hour, where
"a party game for horrible people" humour lands differently than it does among
friends. **Profanity is deliberately kept** — swearing is fine, sex and
pornography are not. Nine cards were removed across the four decks, and the
importer prints every one on each run.

The rule lives in `packages/shared/src/content-filter.ts` and every term is
word-bounded, which matters enormously in a technical deck: unanchored, `anal`
matches "root cause analysis", `cum` matches "document" and "accumulate", and
`sex` matches "sexism". Tests cover those exact false positives, assert no
shipped card matches the filter, and assert profanity *survives* it — so
widening the filter past what was asked for fails the build.

A short list of terms is matched as a substring instead, because boundaries
alone are not enough: `\bporn` does not match "Youporn", and one card slipped
through the first version of the filter that way. Those specific strings appear
in no ordinary English word, so substring matching is safe for them where it
would be catastrophic for `anal` or `cum`.

### Duplicate cards across decks

These decks borrow from each other: Cards Against Reliability is a fork of
Cards Against Cryptography, both descend from Cards Against Humanity, and even
the containers and sales decks in the same upstream repo share four answers.

Piles are therefore deduplicated **by card text when they are built**, not at
import. Which cards count as duplicates depends on which decks are switched
on, so dropping them from the JSON would leave a deck missing cards whenever it
was enabled on its own. A test asserts every deck is whole when enabled alone,
and that no text is ever dealt twice when several are enabled together.

## Running the container

```sh
podman build -t cards-against-containers:0.1.0 .
podman run -d --name cac -p 8080:3000 cards-against-containers:0.1.0
```

Then open http://localhost:8080. Docker works identically. Full walkthrough,
including testing with three players on one machine, is in
[docs/building.md](docs/building.md).

Base images are fully qualified (`docker.io/library/node:26-alpine`) so the
build works under Podman, which has no unqualified search registry by default.
`tini` runs as PID 1: as PID 1 the kernel discards signals Node has no handler
for yet, so without it a container stopped during startup ignores SIGTERM and
waits out the whole grace period before being killed.

The image is a two-stage build: the first installs everything and bundles the
client, the second keeps only what the server needs. There is deliberately no
server build step — TypeScript runs under Node's native type stripping, so the
runtime stage ships `.ts` sources and runs exactly what development runs.

`npm run check:strip` runs inside the build, so an image that Node cannot
execute fails the build rather than crash-looping in production.

React, React-DOM and socket.io-client are **devDependencies** of the client on
purpose: Vite compiles them into `dist/`, so the server never imports them and
they have no business in the runtime image. That alone is ~11 MB.

## Deploying on OpenShift

A Helm chart is in `deploy/helm/cards-against-containers`, with a walkthrough in
[docs/openshift.md](docs/openshift.md).

```sh
helm install cac deploy/helm/cards-against-containers -n happyhour \
  --set image.repository=image-registry.openshift-image-registry.svc:5000/happyhour/cards-against-containers
```

The chart targets the default `restricted-v2` SCC and needs no privileges. It
**refuses to render with more than one replica**, and uses the `Recreate`
strategy rather than `RollingUpdate`, because two pods would split players
across two separate games with nothing to tell them so.

OpenShift assigns an arbitrary high UID with gid 0 and no `/etc/passwd` entry.
The image is verified to run that way. Two things make that work:

- The Dockerfile uses `USER 1000`, not `USER node`. Kubernetes cannot resolve a
  username against an image to confirm it is non-root, so `runAsNonRoot: true`
  fails with `CreateContainerConfigError` against a named user.
- The chart sets no `runAsUser`, because the SCC wants to assign it.

The Route raises the router timeout to an hour. The default is 30s; Socket.IO
pings every 25s, so a game would probably survive it, but four seconds is not
much margin for the most visible failure this app has.

## Hosting

Runs as a single container on Fly.io with all game state in process memory.
See [ADR 001](docs/adr-001-hosting.md) for why this isn't on Vercel or Netlify.

## Card content and licence

Card text comes from the [cardsagainstcontainers/deck](https://github.com/cardsagainstcontainers/deck)
repository, © Sysdig and contributors, licensed
[CC BY-NC-SA 2.0](https://creativecommons.org/licenses/by-nc-sa/2.0/).

That licence carries through to this project:

- **Attribution** — credit stays visible in the app UI and here.
- **NonCommercial** — internal team use only. Do not charge for access.
- **ShareAlike** — derivative card content stays under the same licence.

Application code is separate from card content; see `LICENSE` once added.
