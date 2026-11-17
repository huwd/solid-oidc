# Changelog

All notable changes to this project are recorded here, in the format of [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). The project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Before 1.0.0, a minor version bump marks new functionality or a breaking change, and a patch bump marks fixes only. Breaking changes are marked **Breaking** with what to do when upgrading.

Each change adds its entry under Unreleased when it merges. A release moves those entries under a new version heading; [`docs/releasing.md`](docs/releasing.md) describes the process.

## [Unreleased]

### Added

- A container image for `linux/amd64`, published to `ghcr.io/huwd/solid-oidc`, that runs as a non-root user and includes a healthcheck.
- A health endpoint at `GET /health`.
- Configuration through the `ISSUER_URL`, `HOST` and `PORT` environment variables, validated at startup.

[Unreleased]: https://github.com/huwd/solid-oidc/commits/main
