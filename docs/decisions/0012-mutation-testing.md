# 0012. Check the tests with StrykerJS mutation testing, gated on changed lines

- **Status:** Proposed
- **Decided by:** @huwd
- **Decided:** (when accepted)
- **Recorded:** 2026-11-21
- **Discussion:** [#22](https://github.com/huwd/solid-oidc/issues/22), [#25](https://github.com/huwd/solid-oidc/issues/25)

## Summary

The broker checks its tests with StrykerJS, which makes small changes to the code and reports each change no test noticed.
Every pull request is checked on the broker source lines it changes, and fails if any mutant survives. A weekly run checks the security-critical modules in full.
A mutant that no test could ever notice is recorded in the code, with the reason, rather than silenced by configuration.

## Context

The broker keeps 100% line, branch and function coverage, but coverage shows only that code ran, not that a test would fail if it were wrong.
Most of the code and tests were generated with an AI coding agent. Generated tests can look thorough while asserting little, and a reviewer reading both sides of a change can miss the same gap twice.

The first full run, over the nine modules where a missed bug could let someone log in as someone else or leak a token, scored 86%, with 130 surviving mutants.
They showed real gaps: no test checked the security headers on error pages, that cookies are signed with the newest key, that the development login pages are off, or that each key file limit holds on its own.

The tests use `node:test`, Node strips TypeScript types itself, and the project uses TypeScript 7.
[Decision 0003](0003-toolchain.md) aims for few dependencies.

## Options considered

### StrykerJS with its TAP runner (chosen)

The TAP runner for Stryker runs each `node:test` file as Node would, and reads the results from Node's TAP output.
It records which test files cover each mutant, so a mutant runs only the files that reach it. A full run of the nine modules takes about two minutes.

- It is the established mutation tester for JavaScript and TypeScript, and supports line ranges, which makes a gate on changed lines simple.
- It adds about 146 development packages, mostly Babel, which it uses to parse and mutate the code. None reach the image.
- Stryker rewrites `tsconfig.json` in its sandbox with TypeScript's compiler API, which TypeScript 7 lacks. The configuration names no tsconfig file, so Stryker skips the rewrite. Our `tsconfig.json` has nothing that needs rewriting.
- For the same reason, the Stryker TypeScript checker, which discards mutants that don't compile, can't run. Those mutants run anyway, which costs time, and one that doesn't compile but runs correctly with types stripped has to be judged by hand. [#25](https://github.com/huwd/solid-oidc/issues/25) tracks the upstream fix.

### StrykerJS with its command runner

- It needs no runner plugin.
- It runs the whole suite for every mutant, without knowing which tests cover it, so a run would take hours.

### Pinning Stryker to TypeScript 6

- It would let the tsconfig rewrite and the TypeScript checker run.
- It adds a second compiler, and a package override to maintain, for a checker that also makes each run much slower.

### No mutation testing

- It costs nothing to run.
- It leaves gaps like those above undetected, and gives no check on tests that are generated along with the code.

No other maintained mutation tester for TypeScript was found that runs `node:test` directly.

## Decision

The broker uses StrykerJS 10.1.1 with its TAP runner, configured in `stryker.config.json`, with a break threshold of 100.

- On a pull request, the Mutation testing workflow mutates only the broker source lines the pull request changed, and fails if any mutant survives. A pull request that changes no broker source passes at once.
- Every week, and on demand, it mutates every module in the configuration. This catches a test weakened without its source changing, which the lines a pull request changes can't show.
- A surviving mutant is killed with a test, or, when no test could tell it from the original code, recorded with a `// Stryker disable` comment giving the reason.

[`docs/testing.md`](../testing.md#mutation-testing) describes the practice.

## Consequences

- A pull request that changes code must also test it well enough to kill every mutant of the changed lines. That includes lines in modules the weekly run doesn't cover yet, where existing survivors on a touched line must be dealt with.
- Each `// Stryker disable` comment is a claim that no test could notice the mutant. Reviewers check those claims, since a wrong one hides a real gap.
- The Mutation testing check can become required once it has reported on `main`.
- When a StrykerJS release supports TypeScript 7, [#25](https://github.com/huwd/solid-oidc/issues/25) removes the tsconfig workaround and decides whether to use the TypeScript checker.
