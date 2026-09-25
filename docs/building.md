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
podman build -t cards-against-containers:0.3.0 .
```

That is the whole build. First run takes a couple of minutes because it pulls
the base image and installs dependencies; later builds reuse cached layers and
finish in seconds.

Expect a ~210 MB image, most of which is the Node base.

## 2. Run it

```sh
podman run -d --name cac -p 8080:3000 cards-against-containers:0.3.0
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
podman run --rm -p 8080:3000 cards-against-containers:0.3.0
```

**Change the published port** — the left-hand number is the host port and can
be anything:

```sh
podman run -d --name cac -p 9000:3000 cards-against-containers:0.3.0
```

**Change the port inside the container** with `PORT`. It must be **1024 or
above**: the container runs as a non-root user and a privileged port fails with
`listen EACCES: permission denied`.

```sh
podman run -d --name cac -p 8080:9999 -e PORT=9999 \
  cards-against-containers:0.3.0
```

**Change the log level:**

```sh
podman run -d --name cac -p 8080:3000 -e LOG_LEVEL=warn \
  cards-against-containers:0.3.0
```

**Check it behaves like it will on OpenShift**, which runs containers as an
arbitrary high UID with no `/etc/passwd` entry:

```sh
podman run --rm --user 60000:0 -e HOME=/ -p 8080:3000 \
  cards-against-containers:0.3.0
```

It should start normally. Rootless Podman cannot map a UID as high as the ones
OpenShift actually uses, so 60000 is the closest stand-in; what matters is that
the UID is unknown to the image and the group is 0.

## Custom CA certificates

Behind a TLS-inspecting corporate proxy, drop the CA into `certs/` and rebuild:

```sh
cp /path/to/corp-root-ca.crt certs/
podman build -t cards-against-containers:0.3.0 .
```

That is all. The certificate is installed into the system trust store in both
the build stage and the runtime stage. The directory is empty by default and
the build works fine that way.

Requirements: **PEM format** (`-----BEGIN CERTIFICATE-----`) even though the
extension is `.crt`, and the extension must be `.crt` since that is what the
build globs for. Convert DER with
`openssl x509 -inform der -in ca.der -out ca.crt`.

### Why not `apk add ca-certificates`

Alpine's package repositories are HTTPS. Behind a TLS-inspecting proxy `apk`
cannot connect until the corporate CA is already trusted, so
`apk add ca-certificates && update-ca-certificates` cannot be what installs
it — the command that would establish trust needs trust to run. That ordering
was the first version of this Dockerfile and it failed exactly that way.

The build instead appends the certificates to the bundle the base image already
ships, with plain shell: no package manager, no network, no proxy access. That
step is verified to build under `--network none`. Only afterwards does the
runtime stage `apk add tini`, by which point the proxy is trusted.

### Node ignores the system trust store

This is the part that wastes an afternoon. Installing a CA with
`update-ca-certificates` is **not enough** for a Node application: Node ships
its own bundled root store and ignores the system one unless told otherwise.

Measured against a private CA, with the certificate correctly installed in
`/etc/ssl/certs/ca-certificates.crt`:

| Configuration | Result |
| --- | --- |
| CA in system store, Node defaults | **rejected** — `UNABLE_TO_VERIFY_LEAF_SIGNATURE` |
| CA in system store, `NODE_OPTIONS=--use-system-ca` | trusted |
| CA in system store, `NODE_OPTIONS=--use-openssl-ca` | trusted |
| `NODE_EXTRA_CA_CERTS=/path/ca.crt`, nothing installed | trusted |
| Nothing (control) | rejected |

The image sets `NODE_OPTIONS=--use-system-ca`, so certificates in `certs/` are
trusted by Node, not just by `apk` and `curl`. Public TLS is unaffected: the
Alpine bundle is the same Mozilla root list Node ships.

### When you actually need this

Almost always at **build time**, not runtime. `npm ci` and `apk add` go through
the proxy and fail with `UNABLE_TO_VERIFY_LEAF_SIGNATURE` or
`SELF_SIGNED_CERT_IN_CHAIN`. The running game makes no outbound HTTPS calls at
all — it serves HTTP, with TLS terminated at the route or ingress — so a
runtime CA matters only if you later add something that calls out.

### Without rebuilding

To trust a CA at runtime only, mount it and point Node at it:

```sh
podman run -d --name cac -p 8080:3000 \
  -v /path/to/corp-ca.crt:/certs/corp-ca.crt:ro \
  -e NODE_EXTRA_CA_CERTS=/certs/corp-ca.crt \
  cards-against-containers:0.3.0
```

On OpenShift, the cluster's trusted bundle can be injected by labelling a
ConfigMap with `config.openshift.io/inject-trusted-cabundle: "true"`, mounting
it at `/etc/pki/ca-trust/extracted/pem/`, and setting `NODE_EXTRA_CA_CERTS` to
the injected file.

## Pushing to Docker Hub

Replace `YOURUSER` throughout with your Docker Hub username.

### 1. Create an access token

On <https://hub.docker.com> go to **Account settings → Personal access tokens**
and create one with **Read & Write** scope. Use that instead of your password —
it is required if you have 2FA on, and it can be revoked without changing your
password.

### 2. Log in

```sh
podman login docker.io -u YOURUSER
```

Paste the token when prompted for a password.

### 3. Tag the image

Docker Hub requires the repository name to start with your username:

```sh
podman tag cards-against-containers:0.3.0   docker.io/YOURUSER/cards-against-containers:0.3.0
```

Tagging `latest` as well is convenient, but pin the version in deployments —
`latest` makes it impossible to tell what is actually running.

```sh
podman tag cards-against-containers:0.3.0   docker.io/YOURUSER/cards-against-containers:latest
```

### 4. Push

```sh
podman push docker.io/YOURUSER/cards-against-containers:0.3.0
podman push docker.io/YOURUSER/cards-against-containers:latest
```

### 5. Verify it pulls

```sh
podman rmi docker.io/YOURUSER/cards-against-containers:0.3.0
podman pull docker.io/YOURUSER/cards-against-containers:0.3.0
```

### Public or private?

Docker Hub repositories are **public by default**, and a free account gets only
one private repository. A public image means anyone can pull the card decks.

The licences allow this — all four decks are Creative Commons, the app displays
attribution, and giving it away is not commercial use. But it is a deliberate
choice, so make it deliberately. Set visibility on the repository page after
the first push.

## Deploying the pushed image on OpenShift

```sh
helm install cac deploy/helm/cards-against-containers -n happyhour   --set image.repository=docker.io/YOURUSER/cards-against-containers   --set image.tag=0.3.0
```

### You will probably need a pull secret

Docker Hub rate-limits anonymous pulls, and a cluster pulling unauthenticated
shares one limit across everything behind its egress IP. On a work cluster that
budget is usually already spent, and the symptom is a pod stuck in
`ImagePullBackOff` with `toomanyrequests`.

```sh
oc create secret docker-registry dockerhub   --docker-server=docker.io   --docker-username=YOURUSER   --docker-password=<your access token>   -n happyhour

helm upgrade cac deploy/helm/cards-against-containers -n happyhour   --set image.repository=docker.io/YOURUSER/cards-against-containers   --set image.tag=0.3.0   --set 'imagePullSecrets[0].name=dockerhub'
```

### Check the cluster can reach Docker Hub at all

Plenty of corporate clusters cannot, or route everything through an internal
mirror. If pulls fail with a timeout rather than an auth error, that is what has
happened — use the integrated registry instead, which is covered in
[openshift.md](openshift.md) and avoids Docker Hub entirely.

## Building for more than one architecture

The image built above is **amd64 only**. That is fine for a typical OpenShift
cluster and an Intel laptop, but not for an arm64 cluster or a teammate on
Apple Silicon.

```sh
podman manifest create cac-multi

podman build --platform linux/amd64,linux/arm64   --manifest cac-multi .

podman manifest push --all cac-multi   docker.io/YOURUSER/cards-against-containers:0.3.0
```

Cross-architecture builds run under emulation and are markedly slower; on
Fedora you need `qemu-user-static` installed for the foreign architecture to
build at all.

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
