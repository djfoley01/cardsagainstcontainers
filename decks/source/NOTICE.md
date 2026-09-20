# Vendored upstream deck content

Each subdirectory holds card text copied verbatim from an upstream project,
pinned to the commit in its `.upstream-sha`. Sources are vendored rather than
fetched at build time so builds are reproducible and upstream changes cannot
alter a running game's deck.

| Directory | Upstream | Licence |
| --- | --- | --- |
| `containers/` | [cardsagainstcontainers/deck](https://github.com/cardsagainstcontainers/deck) | CC BY-NC-SA 2.0 |
| `reliability/` | [dastergon/CardsAgainstReliability](https://github.com/dastergon/CardsAgainstReliability) | CC BY-NC-SA 2.0 |
| `developers/` | [crashtest-security/CardsAgainstDevelopers](https://github.com/crashtest-security/CardsAgainstDevelopers) | CC BY-NC-SA 2.0 |

`containers/` supplies two decks: the containers deck itself and the sales
expansion that ships in the same repository.

All three carry the same NonCommercial ShareAlike terms, which pass through to
this project: credit stays visible in the app, do not charge for access, and
derivative card content stays under the same licence.

Do not edit these files by hand. To pick up upstream changes, re-copy them,
update the relevant `.upstream-sha`, and re-run `npm run deck:import`.
