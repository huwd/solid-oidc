# Changelog

All notable changes to this project are recorded here, in the format of [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). The project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Before 1.0.0, a minor version bump marks new functionality or a breaking change, and a patch bump marks fixes only. Breaking changes are marked **Breaking** with what to do when upgrading.

Each change adds its entry under Unreleased when it merges. A release moves those entries under a new version heading; [`docs/releasing.md`](docs/releasing.md) describes the process.

## [Unreleased]

### Added

- A container image for `linux/amd64`, published to `ghcr.io/huwd/solid-oidc`, that runs as a non-root user and includes a healthcheck.
- An OpenID discovery document and the public signing keys, under the issuer URL. Endpoint URLs always start with `ISSUER_URL`, whatever host or protocol a request claims.
- A token-signing key and cookie keys, created in `DATA_DIR/keys.json` on first start and reused afterwards. The image's default `DATA_DIR` is `/data`.
- A health endpoint at `GET /health`.
- Configuration through environment variables, validated at startup with every problem reported at once: the broker's issuer, the upstream provider's issuer and client credentials, the accounts file and the data directory.
- An accounts file in JSON that maps each upstream issuer and subject to the WebID it may log in as. Accounts not listed are refused.

[Unreleased]: https://github.com/huwd/solid-oidc/commits/main
