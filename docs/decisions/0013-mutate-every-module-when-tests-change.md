# 0013. Mutate every configured module when a pull request changes tests

- **Status:** Accepted
- **Decided by:** @huwd
- **Decided:** 2026-11-22
- **Recorded:** 2026-11-22
- **Discussion:** [#22](https://github.com/huwd/solid-oidc/issues/22), following [decision 0012](0012-mutation-testing.md)

## Summary

When a pull request changes a test, a test helper or the Stryker configuration, the Mutation testing check mutates every module in `stryker.config.json`, as well as the source lines the pull request changed.
This catches a weakened test in the pull request that weakens it, rather than in the next weekly run.
It adds to [decision 0012](0012-mutation-testing.md), which stays in effect.

## Context

Under decision 0012, a pull request is checked only on the broker source lines it changes, and one that changes no broker source passes at once.
A pull request that only deletes an assertion changes no source, so it passed, and the mutants that assertion killed could survive unnoticed until the weekly full run.
That run reports after the change has merged, when the change is harder to connect to the gap.

A full run of the nine configured modules takes about two minutes locally.

## Options considered

### Mutate every configured module when tests change (chosen)

- It catches a weakened test before it merges, at the cost of a full run on pull requests that change tests.
- It needs no record of earlier runs.

### Mutate only the mutants the changed tests cover

Stryker's incremental mode reuses an earlier run's results, and runs again only the mutants whose code or covering tests changed.

- It would be faster on a large codebase.
- It needs the results of a run on `main` stored between workflow runs, such as in a cache, which adds state to a read-only workflow, and a stale or missing result gives a misleading pass or a full run anyway.

### Rely on the weekly run

- It costs nothing on pull requests.
- A weakened test is found only after it merges.

## Decision

On a pull request that changes `src/**/*.test.ts`, `src/test-support/` or `stryker.config.json`, the Mutation testing check mutates every module listed in `stryker.config.json`, plus the changed lines of any module outside that list.
Other pull requests are checked on their changed source lines, as decision 0012 describes.

## Consequences

- Pull requests that change tests take a few minutes longer to check.
- A test helper change runs the full set even when no test changes, because helpers can weaken many tests at once.
- If the full run grows too slow, revisit Stryker's incremental mode.
