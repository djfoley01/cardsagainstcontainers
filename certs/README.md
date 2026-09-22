# Custom CA certificates

Drop any corporate root or intermediate CA certificates here as `.crt` files
and rebuild the image. They are trusted in both the build stage and the runtime
stage.

```
certs/
  corp-root-ca.crt
  corp-issuing-ca.crt
```

Requirements:

- **PEM format** (`-----BEGIN CERTIFICATE-----`), even though the extension is
  `.crt`. A DER file will be concatenated in as binary and silently break the
  trust bundle. Convert with:
  `openssl x509 -inform der -in ca.der -out ca.crt`
- **The `.crt` extension**, since that is what the build globs for. A `.pem`
  file is ignored without comment.
- One certificate per file is tidiest, though a file containing a chain works.

This directory is empty by default and the build works fine that way, so
nothing here is required.

## Why this exists

A TLS-inspecting corporate proxy re-signs every HTTPS connection with an
internal CA. Without that CA in the trust store, the build fails with
`UNABLE_TO_VERIFY_LEAF_SIGNATURE` or `SELF_SIGNED_CERT_IN_CHAIN`.

Note that the *running* game needs no outbound HTTPS at all — it serves HTTP
and TLS is terminated at the route or ingress — so this is almost always a
build-time problem, not a runtime one.

## How it is installed, and why not `apk add ca-certificates`

Alpine's package repositories are themselves HTTPS. Behind a TLS-inspecting
proxy `apk` cannot connect until the corporate CA is already trusted, so
`apk add ca-certificates && update-ca-certificates` is a chicken-and-egg: the
command that would install trust cannot run until trust exists. That ordering
was the first version of this and it failed exactly that way.

Instead the build appends these certificates to the bundle the base image
already ships at `/etc/ssl/certs/ca-certificates.crt`, using plain shell. That
needs no package manager, no network and no proxy access — verified by building
that step with `--network none`. Only afterwards does the runtime stage run
`apk add tini`, by which point the proxy is trusted.

A newline is written before each certificate. If the existing bundle does not
end in one, concatenating straight onto it fuses two PEM blocks together and
the entire file silently stops parsing.

## The Node trap

Node does **not** use the system trust store by default; it ships its own
bundled root store. Measured against a private CA with the certificate
correctly installed:

| Configuration | Result |
| --- | --- |
| CA in system store, Node defaults | **rejected** |
| CA in system store, `NODE_OPTIONS=--use-system-ca` | trusted |
| CA in system store, `NODE_OPTIONS=--use-openssl-ca` | trusted |
| `NODE_EXTRA_CA_CERTS=/path/ca.crt` | trusted |

The image sets `NODE_OPTIONS=--use-system-ca` for this reason. Public TLS is
unaffected: the Alpine bundle is the same Mozilla root list Node ships.
