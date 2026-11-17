# 0003. Run TypeScript directly on Node 26, with pnpm, Biome and the built-in test runner

- **Status:** Accepted
- **Decided by:** @huwd
- **Decided:** 2026-11-17
- **Recorded:** 2026-11-17
- **Discussion:** Repository set-up, 17 November 2026 (no issue)

## Summary

Node 26 runs the TypeScript sources directly by stripping types, so the project has no build step, and the TypeScript compiler only type-checks.
pnpm manages dependencies, Biome formats and lints, and Node's built-in `node:test` runner tests with 100% coverage.
This keeps the toolchain to a few dependencies, with the same commands locally and in CI.
devenv provides the tools, and the code follows an adopted style guide, [`docs/code-style.md`](../code-style.md).

## Context

Every development dependency is supply-chain risk for a project that issues identity tokens.
Node 26 can run `.ts` files directly, as long as they use only syntax that can be erased, and includes a test runner with coverage thresholds.
These remove the need for a bundler, a transpiler and a test framework.

The author asked for Node 26, pnpm, strict TypeScript and Biome, with the built-in test runner instead of Vitest.
Other repositories by the same author use devenv for their toolchains.

## Options considered

### Node type stripping with no build step (chosen)

Node runs `src/**/*.ts` as written.
`tsconfig.json` sets `noEmit` and `erasableSyntaxOnly`, so `tsc` checks types and rejects syntax Node cannot strip, such as enums and parameter properties.
The image runs the same files the tests run.

Node refuses to strip types inside `node_modules`, which does not affect an application.
Erasable syntax rules out some TypeScript features. The style guide already favours unions over enums.

### Compile with tsc or a bundler

An extra step, extra output to keep in sync, and source maps to get readable stack traces.
It brings nothing the broker needs.

### Test runner: node:test (chosen) or Vitest

`node:test`, with `node:assert` and the built-in coverage, needs no dependencies.
The test script fails when line, branch or function coverage falls below 100%.
Vitest has a richer interface and watch mode, but adds a large dependency tree.

### Formatter and linter: Biome (chosen) or ESLint with Prettier

Biome is one tool with no plugins, and is fast.
ESLint with typescript-eslint has more type-aware rules, but needs several packages and their configuration.
Biome's type-aware rules, such as `noFloatingPromises`, are still in its nursery group and are enabled as errors.

### Package manager: pnpm (chosen) or npm

pnpm's `minimumReleaseAge` setting refuses package versions published less than seven days ago, matching the Dependabot cooldown.
Its strict `node_modules` layout catches undeclared dependencies.

## Decision

- Node 26, pinned in `.node-version`, runs TypeScript sources directly. `tsc` only type-checks, with `strict` and the further strictness flags in `tsconfig.json`.
- pnpm, pinned through `packageManager` in `package.json`, installs exact versions and waits seven days before accepting a new release.
- Biome formats and lints. Lint warnings fail CI.
- `node:test` runs `src/**/*.test.ts` with 100% coverage thresholds. Process entry points in `src/bin/` are excluded from coverage, and hold no logic of their own.
- devenv provides Node, pnpm, actionlint, shellcheck and sops.
- `pnpm run check` runs every check, and each CI job runs one of its parts.
- The code follows the [GOV.UK One Login TypeScript style guide](https://github.com/govuk-one-login/agent-skills/pull/11), adapted in [`docs/code-style.md`](../code-style.md).

## Consequences

- Fewer dependencies to audit and update, and no build output to drift from the sources.
- Local imports use the `.ts` extension.
- Newly published versions of tools and libraries are unavailable for a week, including urgent fixes. Override deliberately, and record why, if a security fix cannot wait.
- Biome and Node's coverage reporting are younger than the alternatives. Revisit if a missing lint rule or a coverage bug causes real problems.
