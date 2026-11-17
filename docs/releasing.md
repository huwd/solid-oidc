# Releasing

This guide explains how to release a new version of the broker and publish its container image. It is for maintainers with push access.

Changes ship separately from releases. Each change adds its entry under `## [Unreleased]` in [`CHANGELOG.md`](../CHANGELOG.md) when it merges, so `main` can run ahead of the latest release.

## Prepare the release

1. Start from an up-to-date `main` with CI passing.
2. Choose the version from the Unreleased entries. Before 1.0.0, use a minor bump for new functionality or a breaking change, and a patch bump for fixes only.
3. On a release branch, change only:
   - `version` in `package.json`
   - `CHANGELOG.md`: add `## [X.Y.Z] - YYYY-MM-DD` below an empty `## [Unreleased]` heading, move the entries across unchanged and update the comparison links
4. Run `pnpm run check`.
5. Commit as `Prepare vX.Y.Z release`, and merge the change through a pull request.

## Publish

Once the release commit is on `main` and CI has passed on it, tag that commit and push the tag:

```sh
git tag --sign vX.Y.Z --message "vX.Y.Z"
git push origin vX.Y.Z
```

The [Release workflow](../.github/workflows/release.yml) checks that the tag matches `package.json`, then builds and pushes the image to `ghcr.io/huwd/solid-oidc` with the tags `X.Y.Z` and `X.Y`, provenance and an SBOM.

Never move or delete a pushed tag. If publishing fails after the image reaches the registry, fix forward with a new patch version.

## Check the result

- The workflow run succeeded.
- `docker buildx imagetools inspect ghcr.io/huwd/solid-oidc:X.Y.Z` shows the new image.
- The image starts with the settings from "Running the image" in the README, and its healthcheck reports healthy.

The first published package is private by default. Make it public once in the package settings on GitHub.
