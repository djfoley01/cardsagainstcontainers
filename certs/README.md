# Custom CA certificates

Drop any corporate root or intermediate CA certificates here as `.crt` files
and rebuild the image. They are installed into the system trust store in both
the build stage and the runtime stage.

```
certs/
  corp-root-ca.crt
  corp-issuing-ca.crt
```

Requirements:

- **PEM format** (`-----BEGIN CERTIFICATE-----`), even though the extension is
  `.crt`. A DER file silently fails to load. Convert with:
  `openssl x509 -inform der -in ca.der -out ca.crt`
- **One certificate per file**, and the extension must be `.crt` —
  `update-ca-certificates` ignores anything else, including `.pem`.

This directory is empty by default and the build works fine that way, so
nothing here is required.

## Why this exists

A TLS-inspecting corporate proxy re-signs every HTTPS connection with an
internal CA. Without that CA in the trust store, `npm ci` and `apk add` fail
during the build with `UNABLE_TO_VERIFY_LEAF_SIGNATURE` or
`SELF_SIGNED_CERT_IN_CHAIN`.

Note that the *running* game needs no outbound HTTPS at all — it serves HTTP
and TLS is terminated at the route or ingress — so this is almost always a
build-time problem, not a runtime one.

## The Node trap

Node does **not** use the system trust store by default. Installing a CA with
`update-ca-certificates` is not enough on its own: Node ships its own bundled
root store and ignores the system one unless told otherwise.

This image sets `NODE_OPTIONS=--use-system-ca` so that certificates placed here
are actually trusted by Node, not just by `apk` and `curl`. Verified against a
private CA: with the certificate installed but that flag absent, Node still
rejects the connection.
