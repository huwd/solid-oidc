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
| `ISSUER_URL` | Yes | | The issuer identifier Solid clients see, such as `https://id.example.org`. Must use HTTPS (HTTP only on a loopback host), have no query, fragment or trailing slash, and be written in canonical form. |
| `UPSTREAM_ISSUER_URL` | Yes | | The upstream provider's issuer identifier, exactly as its discovery document publishes it, such as `https://auth.example.org`. |
| `UPSTREAM_CLIENT_ID` | Yes | | The client ID registered for the broker at the upstream provider. |
| `UPSTREAM_CLIENT_SECRET` | One of these two | | The client secret for that registration. |
| `UPSTREAM_CLIENT_SECRET_FILE` | One of these two | | Path to a file holding the client secret, such as a Docker secret. One trailing newline is ignored. |
| `ACCOUNTS_FILE` | Yes | | Path to the [accounts file](#accounts-file). |
| `DATA_DIR` | Yes | | Absolute path to a directory for persistent state, such as signing keys. Mount a volume here. |
| `HOST` | No | `0.0.0.0` | Interface to listen on. |
| `PORT` | No | `3000` | Port to listen on. |

The issuer appears in tokens and in each user's WebID profile as `solid:oidcIssuer`, so choose it once and keep it.

### Accounts file

The accounts file lists who may log in, and with which WebID. It is JSON:

```json
{
  "accounts": [
    {
      "upstreamIssuer": "https://auth.example.org",
      "upstreamSubject": "8c1f6d2e-5a1b-4c3d-9e8f-0a1b2c3d4e5f",
      "webId": "https://example.org/profile#me"
    }
  ]
}
```

- `upstreamIssuer` must equal `UPSTREAM_ISSUER_URL` exactly.
- `upstreamSubject` is the `sub` claim the upstream provider issues for that person. In Pocket ID, it is the user's internal ID, not their username or email address.
- `webId` must be an HTTPS URL (HTTP only on a loopback host).

The broker matches only the exact issuer and subject. It never uses an email address, username or other claim to choose a WebID, and it refuses anyone not listed.
One person can have more than one entry with the same WebID, but the same issuer and subject can only appear once.
[Decision 0004](docs/decisions/0004-static-user-mapping.md) explains why the mapping is static.

## Running the image

Images are published to GitHub Container Registry for `linux/amd64`:

```sh
docker run --rm \
  --env ISSUER_URL=https://id.example.org \
  --env UPSTREAM_ISSUER_URL=https://auth.example.org \
  --env UPSTREAM_CLIENT_ID=solid-oidc \
  --env UPSTREAM_CLIENT_SECRET_FILE=/run/secrets/upstream-client-secret \
  --env ACCOUNTS_FILE=/config/accounts.json \
  --env DATA_DIR=/data \
  --volume "$PWD/config:/config:ro" \
  --volume solid-oidc-data:/data \
  --publish 3000:3000 \
  ghcr.io/huwd/solid-oidc:0.1
```

The image runs as a non-root user on a distroless base, and has a built-in healthcheck.

## Development

Development uses [devenv](https://devenv.sh/) for the toolchain: Node 26, pnpm, actionlint, shellcheck, sops, zizmor and Vale.

```sh
devenv shell
pnpm install
pnpm run check      # lint, typecheck, test with coverage, docs lint
pnpm run format     # apply Biome formatting and safe fixes
pnpm run docs:prose # advisory prose and British spelling check
pnpm run dev        # run with reload; set the variables under Configuration first
```

Node runs the TypeScript sources directly, so there is no build step.

- [`CLAUDE.md`](CLAUDE.md) covers working conventions for people and coding agents.
- [`docs/code-style.md`](docs/code-style.md) is the TypeScript style guide.
- [`docs/development-secrets.md`](docs/development-secrets.md) explains how to use secrets locally.
- [`docs/releasing.md`](docs/releasing.md) explains how releases are made.

## Licence

[MIT](LICENSE).
