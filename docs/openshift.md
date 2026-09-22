# Deploying on OpenShift

A Helm chart lives in `deploy/helm/cards-against-containers`. This walks
through getting it running on an internal OpenShift cluster.

## Before you start

Read this bit, because it is the one thing that will bite you:

**This application must run as exactly one pod.** Every game room lives in that
pod's memory — the deliberate design choice that means there is no database to
run (see [ADR 001](adr-001-hosting.md)). With two replicas, players joining the
same room code can be routed to different pods and end up in different games,
and **nothing tells them that has happened**. The game just quietly behaves as
though half the room is missing.

The chart refuses to render with `replicaCount > 1` rather than let that happen.
The Deployment also uses the `Recreate` strategy, not `RollingUpdate`, because a
rolling update briefly runs two pods.

The corollary: **a restart ends every game in progress.** Redeploys, liveness
restarts and node drains all wipe the rooms. Players see a message and are sent
back to the join screen, but their game is over. Deploy before the happy hour,
not during it.

## 1. Build and push the image

The cluster needs to pull the image from somewhere it can reach. The integrated
registry is usually easiest on an internal cluster.

```sh
oc new-project happyhour

# Build locally and push to the integrated registry.
podman build -t cards-against-containers:0.2.0 .

oc registry login
REGISTRY=$(oc get route default-route -n openshift-image-registry \
  -o jsonpath='{.spec.host}')
podman tag cards-against-containers:0.2.0 \
  "$REGISTRY/happyhour/cards-against-containers:0.2.0"
podman push "$REGISTRY/happyhour/cards-against-containers:0.2.0"
```

If the registry route isn't exposed, build in-cluster instead — this needs no
local container tooling at all:

```sh
oc new-build --name cards-against-containers --binary --strategy docker
oc start-build cards-against-containers --from-dir . --follow
```

That produces an ImageStream you can reference as
`image-registry.openshift-image-registry.svc:5000/happyhour/cards-against-containers:latest`.

## 2. Install the chart

The chart points at the published image by default, so this is enough:

```sh
helm install cac deploy/helm/cards-against-containers --namespace happyhour
```

That pulls `docker.io/djfoley01/cards-against-containers` at the chart's
`appVersion`. To use the image you built into the integrated registry in step 1
instead — which avoids Docker Hub's rate limits entirely — override it:

```sh
helm install cac deploy/helm/cards-against-containers \
  --namespace happyhour \
  --set image.repository=image-registry.openshift-image-registry.svc:5000/happyhour/cards-against-containers \
  --set image.tag=0.2.0
```

Leave `route.host` empty and OpenShift generates a hostname. To pin one:

```sh
  --set route.host=cards.apps.your-cluster.example.com
```

## 3. Get the URL

```sh
oc get route cac-cards-against-containers \
  -o jsonpath='{"https://"}{.spec.host}{"\n"}'
```

Share that with the team. One person starts a room, everyone else joins with the
four-letter code. Minimum three players.

## Security context

The chart is built for the `restricted-v2` SCC, which is the default and needs
no special privileges or an SCC grant.

OpenShift assigns an **arbitrary high UID** from the namespace's range, with
gid 0 and no `/etc/passwd` entry. The image is verified to work that way: it
writes nothing to disk at runtime, game state is in memory, the decks are
read-only, and it binds port 3000 so it needs no privileged port. `/app` is
group-owned by root and group-readable, the documented pattern for it.

Two details that matter:

- The chart sets **no `runAsUser`**. Hardcoding one is rejected by the SCC,
  which wants to assign the UID itself.
- The Dockerfile uses **`USER 1000`, not `USER node`**. Kubernetes cannot
  resolve a username against the image to confirm it is non-root, so
  `runAsNonRoot: true` fails with `CreateContainerConfigError` against a named
  user.

## WebSockets through the router

OpenShift routes proxy WebSockets natively — no annotation is needed to permit
the upgrade, and nothing special is required to carry the TCP connection.

Timeouts are where it gets easy to get wrong, because **two different ones
apply** and the obvious-looking annotation is not the one that matters:

| Annotation | HAProxy setting | Applies to | Cluster default |
| --- | --- | --- | --- |
| `haproxy.router.openshift.io/timeout` | `timeout server` | Ordinary HTTP requests | `30s` (`ROUTER_DEFAULT_SERVER_TIMEOUT`) |
| `haproxy.router.openshift.io/timeout-tunnel` | `timeout tunnel` | Connections **after** they upgrade to a WebSocket | `1h` (`ROUTER_DEFAULT_TUNNEL_TIMEOUT`) |

The game's socket lives under `timeout-tunnel`. Once the connection upgrades,
`timeout server` no longer governs it, so the 30-second HTTP default was never
a threat to a game in progress — a point this document previously got wrong.

The chart sets both explicitly:

```yaml
haproxy.router.openshift.io/timeout: 30s
haproxy.router.openshift.io/timeout-tunnel: 1h
```

Not because the defaults are wrong, but because they are only defaults: a
platform team that lowered `ROUTER_DEFAULT_TUNNEL_TIMEOUT` cluster-wide would
otherwise disconnect every player on a schedule nobody deploying this app would
think to look for.

**Do not set the tunnel timeout low.** A five- or ten-minute value does not
degrade gracefully, it churns: every player is disconnected on that cycle,
reconnects, and rejoins. The game survives — seats, hands and scores are held
across a reconnect, and the client rejoins automatically — but it is visible and
buys nothing. An hour comfortably outlasts a happy hour.

One related wrinkle: the tunnel timeout resets whenever HAProxy reloads, which
happens when routes change anywhere on the cluster. That works in your favour
here rather than against it.

The client also falls back to HTTP long-polling if a proxy refuses the upgrade
entirely, so players behind a strict egress proxy still get in.

## Settings worth changing

| Value | Default | Notes |
| --- | --- | --- |
| `image.repository` | `docker.io/djfoley01/cards-against-containers` | Override for the integrated registry, or to avoid Docker Hub rate limits |
| `image.tag` | chart `appVersion` | Pinned deliberately; `latest` exists on the registry but floating it hides what is running |
| `route.host` | `""` | Empty means OpenShift generates one |
| `resources.limits.memory` | `512Mi` | Plenty for a dozen players |
| `env.logLevel` | `info` | `warn` if the request logging is noisy |
| `containerPort` | `3000` | Must be >= 1024; the pod runs non-root. Sets the listener, the declared port and the probes together |
| `ingress.enabled` | `false` | Use instead of `route` on plain Kubernetes |

## Access

There is no authentication. Anyone who can reach the route and knows a
four-letter room code can join a game. On an internal cluster that is usually
what you want. If the route is reachable more widely than you intend, put it
behind whatever your cluster uses for internal-only routes, or use
`oc port-forward` for a one-off.

## Troubleshooting

**Pod restarts forever with failing probes** — usually a port mismatch. Change
`containerPort` rather than setting `PORT` through `extraEnv`: the declared
port and the probes are derived from `containerPort`, so overriding the
variable alone leaves the probes pointing at a port nothing is listening on.
The chart now refuses to render that combination, and refuses a port below
1024, which the non-root pod cannot bind.

**Pod is `CreateContainerConfigError`** — almost always the numeric-UID problem
above. Check `oc describe pod` for "container has runAsNonRoot and image has
non-numeric user".

**Players get disconnected every ~30 seconds** — the route timeout annotation
didn't apply. Check with
`oc get route cac-cards-against-containers -o jsonpath='{.metadata.annotations}'`.

**"That room has ended — the server restarted"** — the pod restarted. Check
`oc get pods` for restart counts; if liveness is firing, the probe thresholds
in `values.yaml` are deliberately generous because a restart wipes every game.

**Everyone sees a different game** — you are running more than one pod. The
chart prevents this, so it means replicas were scaled up directly with
`oc scale`. Set it back to 1.

## Uninstalling

```sh
helm uninstall cac -n happyhour
```
