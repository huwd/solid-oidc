# solid-oidc

A [Solid-OIDC](https://solidproject.org/TR/oidc) identity provider that brokers login to an existing OpenID Connect provider, such as [Pocket ID](https://pocket-id.org/).

Solid apps need an issuer that binds DPoP-bound tokens to a WebID, accepts Client ID Documents and advertises Solid-OIDC support. Most general-purpose OpenID providers do none of these. This broker is the Solid-facing issuer: it sends the person to the upstream provider to log in, maps the upstream identity to an approved WebID, and issues its own tokens.

```text
Solid app ──(Solid-OIDC, DPoP)──▶ solid-oidc ──(OpenID Connect + PKCE)──▶ upstream provider
```

It does not store Pod data or enforce access control. A separate Solid server, such as the Community Solid Server, does that.

## Status

Early development. The service starts, validates its configuration and answers a health check. It does not issue tokens yet.

[`docs/decisions/`](docs/decisions/README.md) records the design decisions made so far.

## Configuration

The service reads its configuration from environment variables at startup. It stops with a list of every problem if any value is invalid.

| Variable | Required | Default | Meaning |
| -------- | -------- | ------- | ------- |
| `ISSUER_URL` | Yes | | The issuer identifier Solid clients see, such as `https://id.example.org`. Must use https (http only on a loopback host), have no query, fragment or trailing slash, and be written in canonical form. |
| `HOST` | No | `0.0.0.0` | Interface to listen on. |
| `PORT` | No | `3000` | Port to listen on. |

The issuer appears in tokens and in each user's WebID profile as `solid:oidcIssuer`, so choose it once and keep it.

## Running the image

Images are published to GitHub Container Registry for `linux/amd64`:

```sh
docker run --rm \
  --env ISSUER_URL=https://id.example.org \
  --publish 3000:3000 \
  ghcr.io/huwd/solid-oidc:0.1
```

The image runs as a non-root user on a distroless base, and has a built-in healthcheck.

## Development

Development uses [devenv](https://devenv.sh/) for the toolchain: Node 26, pnpm, actionlint, shellcheck and sops.

```sh
devenv shell
pnpm install
pnpm run check      # lint, typecheck, test with coverage, docs lint
pnpm run format     # apply Biome formatting and safe fixes
ISSUER_URL=http://localhost:3000 pnpm run dev
```

Node runs the TypeScript sources directly, so there is no build step.

- [`CLAUDE.md`](CLAUDE.md) covers working conventions for people and coding agents.
- [`docs/code-style.md`](docs/code-style.md) is the TypeScript style guide.
- [`docs/development-secrets.md`](docs/development-secrets.md) explains how to use secrets locally.
- [`docs/releasing.md`](docs/releasing.md) explains how releases are made.

## Licence

[MIT](LICENSE).
