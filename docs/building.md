# Building the container

Step by step, from a clean checkout to a running game.

## What you need

- **Podman or Docker.** The commands below use `podman`; `docker` works
  identically — substitute the word.
- **Nothing else.** Node, npm and the client build all happen inside the
  image. You do not need a local Node install to build or run it.
- Network access to pull `docker.io/library/node:26-alpine` the first time.

## 1. Build the image

From the repository root:

```sh
podman build -t cards-against-containers:0.1.0 .
```

That is the whole build. First run takes a couple of minutes because it pulls
the base image and installs dependencies; later builds reuse cached layers and
finish in seconds.

Expect a ~210 MB image, most of which is the Node base.

## 2. Run it

```sh
podman run -d --name cac -p 8080:3000 cards-against-containers:0.1.0
```

- `-d` runs it in the background
- `-p 8080:3000` maps host port 8080 to the container's 3000
- The app always listens on 3000 inside; change only the left-hand number

## 3. Check it came up

```sh
curl http://localhost:8080/healthz
```

You should get JSON listing the four decks and their card counts:

```json
{"ok":true,"rooms":0,"decks":[{"id":"containers","prompts":103,"responses":271}, ...]}
```

If `curl` returns nothing, the server is probably still starting. Wait a second
and try again — see the note at the bottom about retrying.

## 4. Play

Open <http://localhost:8080>.

You need **three players minimum**. To test on one machine, open three windows
with a `?seat=` parameter so each gets its own identity — browser profiles share
`localStorage`, so without this all three windows are treated as the same
player rejoining:

```
http://localhost:8080/?seat=1
http://localhost:8080/?seat=2
http://localhost:8080/?seat=3
```

Start a room in seat 1, then join from 2 and 3 with the four-letter code.

## 5. Stop it

```sh
podman stop cac && podman rm cac
```

It stops in well under a second. Anything slower means signals are not reaching
the process.

## Useful extras

**Watch the logs:**

```sh
podman logs -f cac
```

**Run in the foreground** (Ctrl-C to quit):

```sh
podman run --rm -p 8080:3000 cards-against-containers:0.1.0
```

**Change the port or log level:**

```sh
podman run -d --name cac -p 9000:3000 \
  -e LOG_LEVEL=warn \
  cards-against-containers:0.1.0
```

**Check it behaves like it will on OpenShift**, which runs containers as an
arbitrary high UID with no `/etc/passwd` entry:

```sh
podman run --rm --user 60000:0 -e HOME=/ -p 8080:3000 \
  cards-against-containers:0.1.0
```

It should start normally. Rootless Podman cannot map a UID as high as the ones
OpenShift actually uses, so 60000 is the closest stand-in; what matters is that
the UID is unknown to the image and the group is 0.

## How the build works

Two stages. The first installs all dependencies and bundles the client with
Vite. The second starts fresh and copies in only what the server needs: the
production dependencies, the server and shared sources, the deck JSON, and the
built client.

There is deliberately **no server build step**. TypeScript runs directly under
Node's native type stripping, so the image ships `.ts` sources and runs exactly
what runs in development.

Two guards are baked into the build:

- `npm run check:strip` runs during the build, so code that `tsc` accepts but
  Node cannot execute — parameter properties, enums, namespaces — fails the
  build instead of crash-looping in production.
- Test files are deleted from the runtime stage, so they never ship.

`tini` runs as PID 1 and forwards signals to Node. This is not decoration: as
PID 1, Node's own process would have signals *discarded* by the kernel during
the moment before it registers handlers, so a container stopped mid-startup
would ignore SIGTERM entirely and wait out the full grace period before being
killed.

## Troubleshooting

**`short-name "node:26-alpine" did not resolve`** — Podman with no unqualified
search registry configured. The Dockerfile already uses the fully-qualified
`docker.io/library/node:26-alpine`, so this means the file was edited; put the
registry prefix back.

**`curl` returns nothing immediately after `podman run`** — the server takes a
moment to bind, and Podman's port forwarder may return a connection *reset*
rather than *refused* in the meantime. `curl --retry-connrefused` does not retry
a reset. Use this instead:

```sh
curl --retry 10 --retry-all-errors http://localhost:8080/healthz
```

**Port already in use** — pick another host port: `-p 8081:3000`.

**All three browser windows show the same player** — you left off `?seat=`. See
step 4.
