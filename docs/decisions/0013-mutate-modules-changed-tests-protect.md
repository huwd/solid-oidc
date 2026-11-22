# 0013. Mutate the modules that changed tests protect

- **Status:** Accepted
- **Decided by:** @huwd
- **Decided:** 2026-11-22
- **Recorded:** 2026-11-22
- **Discussion:** [#22](https://github.com/huwd/solid-oidc/issues/22), following [decision 0012](0012-mutation-testing.md)

## Summary

When a pull request changes tests, the Mutation testing check also mutates the modules those tests protect.
A changed unit test, such as `keys.test.ts`, mutates its own module. A changed integration test, test helper or Stryker configuration mutates every configured module, because there is no reliable way to tell which modules it protects.
This catches a weakened test in the pull request that weakens it, rather than in the next weekly run.
It adds to [decision 0012](0012-mutation-testing.md), which stays in effect.

## Context

Under decision 0012, a pull request is checked only on the broker source lines it changes, and one that changes no broker source passes at once.
A pull request that only deletes an assertion changes no source, so it passed, and the mutants that assertion killed could survive unnoticed until the weekly full run.
That run reports after the change has merged, when the change is harder to connect to the gap.

Unit tests are named after their module, so `src/keys.test.ts` tests `src/keys.ts`.
Integration tests, such as `login.test.ts`, `restart.test.ts` and `rotation.test.ts`, have no module of their own, and test several at once. They hold many of the broker's security assertions, such as the headers and messages of every error page.
A full run of the nine configured modules takes about two minutes locally.

## Options considered

### Match unit tests to their module, and run everything for the rest (chosen)

- A changed unit test of a configured module mutates only that module, which is the lightest check that still covers the change.
- A changed integration test, test helper or `stryker.config.json` mutates every configured module, so a weakened integration test can't slip through.
- A changed unit test of a module outside the configuration mutates nothing, as that module isn't held to the threshold yet.

### Match tests to modules by name only

- It is the lightest option.
- A weakened integration test would never be checked on its pull request, and those hold many of the security assertions.

### Mutate every configured module whenever tests change

- It is the simplest rule.
- It runs the full set for the common case of editing one unit test.

### Mutate only the mutants the changed tests cover

Stryker's incremental mode reuses an earlier run's results, and runs again only the mutants whose code or covering tests changed.

- It is the most precise.
- It needs the results of a run on `main` stored between workflow runs, such as in a cache, which adds state to a read-only workflow. A stale or missing result gives a misleading pass, or a full run anyway.

## Decision

On a pull request, `.github/scripts/mutation-scope.sh` chooses what Stryker mutates:

- the changed lines of broker source, as decision 0012 describes
- the whole module of each changed unit test, when that module is in `stryker.config.json`
- every module in `stryker.config.json`, when the pull request changes a test with no module of the same name, a file in `src/test-support/`, or `stryker.config.json`

A pull request that changes none of these passes at once.

## Consequences

- Most pull requests that change tests run one module more, and those that change integration tests or helpers take a few minutes longer.
- A unit test's name must match its module for the light check to apply. Any other test counts as an integration test, and runs the full set.
- If the full run grows too slow, revisit Stryker's incremental mode.
