# Changelog

Image tags on Docker Hub match these versions, so rolling back is a matter of
pinning the previous tag:

```sh
helm upgrade cac deploy/helm/cards-against-containers --set image.tag=0.1.0
```

Older tags are never overwritten. `latest` follows the newest release, which is
why the Helm chart pins `appVersion` instead of tracking it.

## 0.2.0

Custom decks, a builder for writing them, and three new decks.

### Added

- **Three decks written for this project**, all off by default:
  *Cards Against Terraform* (50/125), *Cards Against OpenShift* (52/126) and
  *Cards Against Nutanix* (50/128). Each holds enough answers to be played on
  its own at a full table. Cards live as plain text in
  `decks/source/<deck>/`, so adding one means editing a text file and running
  `npm run deck:import`.

- **Custom decks** load from any directory listed in `CAC_DECK_DIRS`
  (colon-separated, like `PATH`), alongside the decks built into the image.
  Mount a folder locally, or a ConfigMap or PVC on Kubernetes. See
  [docs/custom-decks.md](docs/custom-decks.md).
- **Decks reload without a restart.** The directories are watched, so a deck
  added mid-evening appears in lobbies in place. A restart would have ended
  every game in progress.
- **Deck builder at `/decks`**, linked from the landing page. Validates as you
  type and emits the deck JSON plus ready-to-apply ConfigMap YAML. It shares
  its validation module with the server, so a deck that is clean in the builder
  is guaranteed to load.
- **Helm**: `customDecks.configMap` and `customDecks.persistentVolumeClaim`,
  mounted `optional: true` so the ConfigMap may be created after the app.
- The lobby shows the **combined card pool** for the selected decks and whether
  it is enough for the players present.

### Fixed

- **A game could wedge when the deck ran short.** With fewer answer cards than
  `players × handSize`, the deal ran dry part-way through the seat order; the
  players at the end were dealt nothing, could not submit, and the round waited
  on them forever. With timers off nothing would ever advance it. Starting a
  game now fails fast with the actual numbers, and a player holding too few
  cards is no longer waited on. Latent before this release — the built-in decks
  are all large enough — but custom decks make it easy to hit.
- Route timeouts were set on the wrong annotation. WebSockets are governed by
  `haproxy.router.openshift.io/timeout-tunnel`, not `.../timeout`; both are now
  set explicitly. Previously documented incorrectly as well.
- The chart hardcoded the container port in three places, so overriding `PORT`
  through `extraEnv` left the probes pointing at a port nothing listened on and
  the pod restarted forever. There is now a single `containerPort` value, plus
  guards refusing a privileged port or an override through `extraEnv`.

### Notes

- Custom deck card ids are regenerated as `<deck-id>-p-001`. The engine keys
  cards by id, so a custom deck reusing `c-r-001` would otherwise silently
  replace a built-in card — wrong text on the table, no error anywhere.
- A custom deck cannot reuse a built-in deck's id.
- Bad deck files are skipped with a logged reason rather than stopping the
  server.

## 0.1.0

First release. Playable end to end.

- Four decks: Cards Against Containers, Sales, Reliability and Developers —
  321 prompts and 803 answers, all Creative Commons BY-NC-SA 2.0.
- Rooms by four-letter code, rotating Card Czar, anonymous judging, reveal,
  scoreboard and round history.
- Reconnect handling: seats, hands and scores survive a dropped connection.
- Pause, host overrides, kick, host hand-off.
- Container image, Helm chart for OpenShift, and a deployment guide.
