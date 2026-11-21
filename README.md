# solid-oidc

A [Solid-OIDC](https://solidproject.org/TR/oidc) identity provider that brokers login to an existing OpenID Connect provider, such as [Pocket ID](https://pocket-id.org/).

Solid apps need an issuer that binds DPoP-bound tokens to a WebID, accepts Client ID Documents and advertises Solid-OIDC support. Most general-purpose OpenID providers do none of these. This broker is the Solid-facing issuer: it sends the person to the upstream provider to log in, maps the upstream identity to an approved WebID, and issues its own tokens.

```text
Solid app ──(Solid-OIDC, DPoP)──▶ solid-oidc ──(OpenID Connect + PKCE)──▶ upstream provider
```

It does not store Pod data or enforce access control. A separate Solid server, such as the Community Solid Server, does that.

## Status

Early development. The broker is a Solid-OIDC issuer: Solid apps can log in with it, and it issues DPoP-bound tokens carrying the person's WebID. It logs people in through the upstream provider. Sessions, grants and tokens are kept in SQLite in `DATA_DIR`, so they survive a restart.

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
| `DATA_DIR` | Yes (the image sets `/data`) | | Absolute path to a directory for persistent state. Mount a volume here. See [Persistent state](#persistent-state). |
| `HOST` | No | `0.0.0.0` | Interface to listen on. |
| `PORT` | No | `3000` | Port to listen on. |
| `DEVELOPMENT_ALLOW_LOOPBACK_CLIENT_IDS` | No | `false` | `true` lets the broker fetch Client ID Documents from `localhost`, `127.0.0.1` or `[::1]`, for the [sandbox](#sandbox). Never set it in production. [Decision 0009](docs/decisions/0009-loopback-client-ids-for-development.md) explains why. |

The issuer appears in tokens and in each user's WebID profile as `solid:oidcIssuer`, so choose it once and keep it.

### Registering the broker with the upstream provider

Register the broker at the upstream provider as a confidential client, with a client secret, and this callback URL:

```text
<ISSUER_URL>/upstream/callback
```

For example, `https://id.example.org/upstream/callback`. The broker also logs the URL when it starts.
It asks only for the `openid` scope, and always uses PKCE.
In Pocket ID, create an OIDC client that is not public, and give it that callback URL.

### How a login works

1. A Solid app sends the person to the broker. The app's `client_id` is the URL of its Client ID Document, which the broker fetches to learn the app's name and redirect URIs.
2. The broker sends them on to the upstream provider to log in.
3. The broker checks the upstream ID token and finds the WebID for its exact issuer and subject in the [accounts file](#accounts-file).
4. The broker asks the person to confirm the app may use that WebID. It names the app and shows its client ID, since an app chooses its own name.

The app then gets a DPoP-bound access token, a JWT with `solid` in its audience and the person's WebID as `webid`, which Solid servers accept.
[Decision 0008](docs/decisions/0008-solid-oidc-through-oidc-provider-features.md) explains how the broker meets Solid-OIDC.

If no WebID matches, the person sees the same page whatever the reason, so the page can't be used to discover who has an account. The broker logs the upstream subject, so an administrator can add it to the accounts file.

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

### Pointing a WebID at the broker

A Solid server trusts the broker for a WebID only if the WebID profile names it as the issuer:

```turtle
<#me> <http://www.w3.org/ns/solid/terms#oidcIssuer> <https://id.example.org> .
```

The object is `ISSUER_URL`, exactly.

### Persistent state

On first start, the broker creates two things in `DATA_DIR`:

| File | Holds |
| ---- | ----- |
| `keys.json` | The private token-signing keys and the cookie-signing keys, with the date each was added |
| `provider.sqlite`, with `-wal` and `-shm` files beside it | Sessions, grants, authorisation codes, access and refresh tokens |

Later starts reuse both, so people stay logged in and refresh tokens keep working across a restart.
[Decision 0005](docs/decisions/0005-sqlite-for-provider-state.md) explains the choice of SQLite.

- Both are created readable only by their owner (mode 600). The broker refuses to start if anyone else can read them.
- The database has a schema version. The broker refuses to start against a database with a version it doesn't know, such as one written by a newer release.
- Expired records are removed every five minutes, up to 1,000 at a time.
- Don't delete `keys.json` to replace the keys. [Rotate them](#rotating-keys) instead, or revoke them if they may have leaked.
- Client ID Documents are cached in memory only, so the broker fetches them again after a restart.

### Backing up and restoring

Back up `keys.json` and the database together: tokens in one backup need the keys from the same backup.

Don't copy `provider.sqlite` while the broker runs, because a copy taken during a write can be corrupt. Use the backup command, which takes a consistent copy while the broker keeps running:

```sh
docker exec solid-oidc /nodejs/bin/node src/bin/backup.ts /data/backups/provider-2026-11-20.sqlite
docker cp solid-oidc:/data/backups/provider-2026-11-20.sqlite .
docker cp solid-oidc:/data/keys.json .
```

The command writes a new file readable only by its owner, and refuses to overwrite one. It creates the directory if needed, readable only by its owner too.

To restore:

1. Stop the broker.
2. Replace `provider.sqlite` in `DATA_DIR` with the backup, and delete any `provider.sqlite-wal` and `provider.sqlite-shm` files beside it.
3. Replace `keys.json` with the one from the same backup.
4. Check both are mode 600 and owned by the broker's user, then start the broker.

Test a restore before relying on your backups.

### Rotating keys

The broker signs tokens with one key and publishes it, with any older keys, at its JWKS URL. Solid servers check tokens against those published keys. Cookies are signed with a separate cookie key.

The `keys` command changes `keys.json`. Run it in the container, and restart the broker after each change, since the broker reads its keys only when it starts:

```sh
docker exec solid-oidc /nodejs/bin/node src/bin/keys.ts list
docker restart solid-oidc
```

When the broker starts, its log names the key that signs tokens and every key it publishes.

#### Replace keys as routine

A planned rotation takes about 75 minutes and logs nobody out:

1. `rotate` publishes a new signing key without signing with it, and starts signing cookies with a new cookie key. Restart the broker straight away.
2. After 10 minutes, `promote` starts signing tokens with the new key. Solid servers cache the published keys, so the wait lets them see the new key first. Restart the broker.
3. After a further 65 minutes, `retire` removes the old signing key. By then every token it signed has expired. Restart the broker.
4. After 14 days, `retire` again removes the old cookie key, once every session it signed has expired. Restart the broker.

Each command refuses to run before it is safe to, and says when it can. `--skip-wait` overrides the wait for `promote` and `retire`, but tokens or sessions that depend on an old key stop working.

#### Revoke keys that may have leaked

If `keys.json` or a backup of it may have been copied, run `revoke --confirm`, then restart the broker:

```sh
docker exec solid-oidc /nodejs/bin/node src/bin/keys.ts revoke --confirm
docker restart solid-oidc
```

This:

- replaces every key, keeping none, so tokens signed with the old keys no longer verify
- deletes every session, grant and token from the database, because whoever copied `keys.json` has probably copied `provider.sqlite` beside it

Everyone has to log in again, and apps have to ask again for permission to use each WebID.

Solid servers cache the broker's published keys. The Community Solid Server keeps them for up to 2 minutes, so it may accept a token signed with a leaked key until then. Restart your Solid servers if you need the old keys refused at once.

Then find out how the file was copied, and check the file permissions in `DATA_DIR`.

## Running the image

Images are published to GitHub Container Registry for `linux/amd64`:

```sh
docker run --rm \
  --env ISSUER_URL=https://id.example.org \
  --env UPSTREAM_ISSUER_URL=https://auth.example.org \
  --env UPSTREAM_CLIENT_ID=solid-oidc \
  --env UPSTREAM_CLIENT_SECRET_FILE=/run/secrets/upstream-client-secret \
  --env ACCOUNTS_FILE=/config/accounts.json \
  --volume "$PWD/config:/config:ro" \
  --volume solid-oidc-data:/data \
  --publish 3000:3000 \
  ghcr.io/huwd/solid-oidc:0.1
```

The image runs as a non-root user on a distroless base, and has a built-in healthcheck. Its `/data` directory belongs to that user, so a named volume mounted there is writable. A bind mount must be writable by user ID 65532.

## Sandbox

The sandbox runs the whole login journey on your machine, in Docker, against stubs. It needs no Pocket ID, Solid server, accounts or secrets.

```sh
docker compose --file sandbox/compose.yaml up --build
```

Then open <http://localhost:5000> and choose **Log in with the broker**. You:

1. go to the stub upstream provider, which stands in for Pocket ID, and choose who to log in as
2. come back to the broker, which asks you to allow the app to use your WebID
3. land on the stub app, which shows the decoded access and ID tokens, and can refresh them

Log in as the stranger to see the page the broker shows when no WebID matches.

| Address | Service |
| ------- | ------- |
| <http://localhost:3000> | The broker, built from this repository |
| <http://localhost:4000> | The stub upstream provider |
| <http://localhost:5000> | The stub Solid app, and Alice's WebID profile at `/profile/card` |
| <https://localhost:5443/clientid.jsonld> | The app's Client ID Document |

### Changing the sandbox

Set these in your shell, or in a `.env` file in `sandbox/`, before `docker compose up`:

| Variable | Default | Meaning |
| -------- | ------- | ------- |
| `SANDBOX_APP_NAME` | `Sandbox Solid App` | The name in the app's Client ID Document, shown on the consent page |
| `SANDBOX_APP_SCOPE` | `openid webid offline_access` | The scopes the app asks for. Without `offline_access`, it gets no refresh token. |
| `SANDBOX_UPSTREAM_SUBJECTS` | Alice and a stranger | The subjects the stub upstream offers, as `label=subject` pairs separated by `;` |
| `SANDBOX_UPSTREAM_CLIENT_SECRET` | `sandbox-only-not-a-secret` | The secret the broker and the stub upstream share |

The stub upstream also accepts any subject typed into its page. To give a new subject a WebID, add it to [`sandbox/accounts.json`](sandbox/accounts.json) and restart.
The broker caches the app's Client ID Document for at least a minute, so a new name or scope can take that long to appear on the consent page.

### How the sandbox is put together

The stubs run in one container, and the broker shares its network, so the browser and every service reach each other at the same `localhost` addresses. Ports are published on `127.0.0.1` only.

Solid-OIDC needs a Client ID Document served over HTTPS. On first start, the stubs container creates a certificate authority and a certificate for `localhost`, in a volume that belongs to the sandbox. The broker trusts that authority through `NODE_EXTRA_CA_CERTS`. Your browser never needs to, because only the broker fetches the document.

The broker runs with `DEVELOPMENT_ALLOW_LOOPBACK_CLIENT_IDS=true`, since the document is on `localhost`, and logs a warning that says so.

`docker compose --file sandbox/compose.yaml down --volumes` removes the sandbox and its data.

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
- [`docs/testing.md`](docs/testing.md) explains how the broker is tested.
- [`docs/development-secrets.md`](docs/development-secrets.md) explains how to use secrets locally.
- [`docs/releasing.md`](docs/releasing.md) explains how releases are made.

## Licence

[MIT](LICENSE).
