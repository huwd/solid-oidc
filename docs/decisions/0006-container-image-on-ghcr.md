# 0006. Publish a distroless amd64 image to GitHub Container Registry from version tags

- **Status:** Accepted
- **Decided by:** @huwd
- **Decided:** 2026-11-17
- **Recorded:** 2026-11-17
- **Discussion:** Repository set-up, 17 November 2026 (no issue)

## Summary

Pushing a version tag, such as `v0.1.0`, publishes the broker as a public container image at `ghcr.io/huwd/solid-oidc`.
The image is built for `linux/amd64` only, on a distroless Node base, runs as a non-root user and includes a healthcheck that does not need a shell.
Publishing is the only CI job with write access, and only to packages.

## Context

The broker is deployed with Docker on a Synology DS923+ (AMD Ryzen R1600, so `amd64`), through the Composer homelab repository.
The author wants the image in a public registry so it can be deployed as a plain Docker image.

Composer's operational notes record that shell-based (`CMD-SHELL`) healthchecks can get stuck in uninterruptible sleep under I/O pressure on that host, and recommend exec-form checks with intervals of at least two minutes.

## Options considered

### Registry: GitHub Container Registry (chosen) or Docker Hub

GitHub Container Registry sits next to the source, and a workflow can publish to it with its own token and no stored secrets.
Docker Hub is more widely known, but needs an account token stored as a repository secret, and has pull rate limits.

### Base image: distroless Node (chosen) or Node slim

The distroless Node 26 `nonroot` image has no shell or package manager, which leaves less to exploit and less to patch.
The slim Node image is easier to debug, but carries a full Debian userland.
Without a shell, the healthcheck runs a small Node script in exec form, which also meets the Composer guidance.

### Platforms: amd64 only (chosen) or amd64 and arm64

The only target host is `amd64`.
Building `arm64` as well would slow every release for no current user. Add it if someone needs it.

### Trigger: version tags (chosen), every push to main, or manual

Tags give each image a version that matches the changelog and `package.json`.
Publishing every push to main would make untested images easy to pull by mistake.

## Decision

- A pushed `vX.Y.Z` tag runs the release workflow, which checks the tag matches `package.json`, then publishes `ghcr.io/huwd/solid-oidc` with tags `X.Y.Z` and `X.Y`, provenance and an SBOM.
- No `latest` tag is published, so deployments always name a version.
- The image is `linux/amd64`, based on `gcr.io/distroless/nodejs26-debian13:nonroot` pinned by digest, with an exec-form healthcheck every two minutes.
- CI builds and smoke-tests the image on every pull request without publishing it.
- Only the release job has `packages: write`. Every other workflow is read-only.

## Consequences

- Deployments pin an exact version or a minor line, and upgrade deliberately.
- Debugging inside the container needs a debug image or `docker cp`, since there is no shell.
- The package must be made public once, by hand, after the first publish.
- Dependabot proposes base image digest updates. The Node version in the builder tag and `.node-version` need updating by hand.
