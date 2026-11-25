# Changelog

All notable changes to this project are recorded here, in the format of [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). The project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Before 1.0.0, a minor version bump marks new functionality or a breaking change, and a patch bump marks fixes only. Breaking changes are marked **Breaking** with what to do when upgrading.

Each change adds its entry under Unreleased when it merges. A release moves those entries under a new version heading; [`docs/releasing.md`](docs/releasing.md) describes the process.

## [Unreleased]

### Changed

- Refresh tokens last 14 days from the consent that first issued them, and rotating one never extends that. The broker sets this itself instead of using `oidc-provider`'s default, which could let some clients refresh indefinitely, and no longer logs a warning about it at startup. See [decision 0014](docs/decisions/0014-refresh-tokens-last-as-long-as-the-grant.md).

## [0.1.0] - 2026-11-25

### Added

- A container image for `linux/amd64`, published to `ghcr.io/huwd/solid-oidc`, that runs as a non-root user and includes a healthcheck.
- Key rotation, with `node src/bin/keys.ts`: `rotate`, `promote` and `retire` replace the signing and cookie keys without logging anyone out, and `revoke --confirm` replaces every key and deletes every session and token if the keys may have leaked. `list` shows each key and what it does. The "Rotating keys" section of the README gives the procedure.
- The broker's startup log names the key that signs tokens and every key it publishes.
- A local sandbox, started with `docker compose --file sandbox/compose.yaml up --build`, that runs the full login journey against a stub upstream provider and a stub Solid app.
- `DEVELOPMENT_ALLOW_LOOPBACK_CLIENT_IDS`, which lets the broker fetch Client ID Documents from loopback addresses. It is off by default, for the sandbox only, and logs a warning when on.
- Sessions, grants, codes and tokens are stored in SQLite in `DATA_DIR/provider.sqlite`, so a restart no longer logs everyone out. The broker refuses a database with an unknown schema version, and removes expired records every five minutes.
- A backup command, `node src/bin/backup.ts <destination>`, that copies the database consistently while the broker runs.
- Solid-OIDC support. Solid apps identify themselves with Client ID Documents, including JSON-LD ones. Access tokens are DPoP-bound JWTs with `solid` in the audience and `webid` and `client_id` claims. Discovery advertises `solid_oidc_supported` and the `webid` scope. A token request without a DPoP proof is refused.
- Login through the upstream provider, using PKCE, `state` and `nonce`. The broker maps the upstream account to a WebID by exact issuer and subject, and asks the person to confirm each app. Register `<ISSUER_URL>/upstream/callback` as the callback URL at the upstream provider.
- An OpenID discovery document and the public signing keys, under the issuer URL. Endpoint URLs always start with `ISSUER_URL`, whatever host or protocol a request claims.
- A token-signing key and cookie keys, created in `DATA_DIR/keys.json` on first start and reused afterwards. The image's default `DATA_DIR` is `/data`. The file records when each key was added. A file written before key rotation is still read, and is rewritten in the new format by the first `keys` command.
- Access tokens and ID tokens last 1 hour, and sessions and grants 14 days. These were `oidc-provider`'s defaults, and are now set explicitly, because key rotation's waits depend on them.
- A health endpoint at `GET /health`.
- Configuration through environment variables, validated at startup with every problem reported at once: the broker's issuer, the upstream provider's issuer and client credentials, the accounts file and the data directory.
- An accounts file in JSON that maps each upstream issuer and subject to the WebID it may log in as. Accounts not listed are refused.

[Unreleased]: https://github.com/huwd/solid-oidc/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/huwd/solid-oidc/commits/v0.1.0
