# Code style

This is the TypeScript style guide for this repository, for anyone changing its code, including coding agents. It adopts the [GOV.UK One Login TypeScript style guide](https://github.com/govuk-one-login/agent-skills/blob/eb779fd0319c18e92060cfade3678a8aed3bff14/skills/typescript-development/references/typescript-style-guide.md) (version from [pull request 11](https://github.com/govuk-one-login/agent-skills/pull/11)), and records where this repository applies it differently.

Read the upstream guide for the rationale and examples. The checklist below summarises it, and the tools enforce what they can.

## Differences from the upstream guide

| Upstream | Here | Reason |
| -------- | ---- | ------ |
| Prettier or ESLint | [Biome](https://biomejs.dev/) formats and lints, through `pnpm run format` and `pnpm run lint` | One fast tool with no plugin dependencies. See [decision 0003](decisions/0003-toolchain.md). |
| Coverage ignore pragma: `/* v8 ignore … */` | `/* node:coverage ignore next N */`, with the reason on the next line | The built-in test runner reads `node:coverage` comments. |
| Coverage exceptions in code only | `src/bin/` is excluded from coverage in the `test` script | Process entry points cannot run under the test runner without replacing process globals. They hold no logic of their own. |
| Zod for runtime validation | Zod, as upstream | |

## Checklist

### Types

- Never use `any`. Use `unknown` at a boundary and narrow it.
- Make invalid states impossible to construct: discriminated unions, literal and branded types.
- Make `switch` statements exhaustive with a `never` check in the default branch.
- Constrain generics with `extends`. Use `satisfies` to check a value without widening it.
- Keep return types simple: prefer `void`, then `boolean`, then a value, then `T | null`.
- Write only erasable TypeScript: no enums, namespaces or parameter properties. Node strips types at runtime and `tsconfig.json` enforces `erasableSyntaxOnly`.

### Runtime validation

- Parse everything that crosses a boundary (environment variables, HTTP bodies, files, database rows, upstream responses) with a schema.
- Validate at ingestion, and again before use, egress or persistence.
- Assert relationships between configuration values at startup.
- Check what must not happen as well as what must.

### Errors

- Handle every error. No empty `catch`, no unhandled promise rejections.
- Chain errors with `cause`.
- Return a `{ ok: true, … } | { ok: false, … }` result for expected failures, and throw only for unexpected ones. Keep custom error classes minimal.

### Control flow and functions

- Prefer simple, explicit control flow. No recursion for unbounded work.
- Bound every loop and queue.
- Write conditions positively, such as `index < length`.
- Brace every `if`, unless the whole statement fits on one line.
- Keep functions short, with few parameters and a simple return type. Push branching up into the caller and loops down into pure helpers.
- Treat every `await` as a point where shared state can change.
- Pair acquisition with clean-up in one place, using `try`/`finally` or `await using`.
- Use a named options object when parameters could be swapped. Put callbacks last.
- Pass options explicitly instead of relying on defaults.

### Names and layout

- Choose precise nouns and verbs. Don't abbreviate, except short-lived callback parameters.
- Put units and qualifiers last, most significant first: `timeoutMs`, `latencyMsMax`.
- Use long-form flags in scripts, such as `--frozen-lockfile`.
- Order a module for a reader: types, then the main export, then helpers.
- Sort alphabetically where no other order matters.
- Declare variables in the smallest scope, close to their use.

### Comments

- Say why, not what. Write comments as sentences, with a capital letter and a full stop.
- Write commit messages that record the reasoning.

### Tests

- Use `node:test` and `node:assert/strict`. Put tests next to the code as `*.test.ts`.
- Test valid and invalid input, and every failure path.
- Never monkey-patch modules or globals. Inject dependencies instead.
- Make each test readable on its own, with a clear name and specific assertion messages.
- Keep 100% line, branch and function coverage. The `test` script fails below it.

### Performance and dependencies

- Optimise I/O before CPU. Batch requests, and bound concurrency.
- Don't block the event loop.
- Add a dependency only when it is clearly worth its supply-chain risk.
- Write tooling and automation in TypeScript rather than shell, where practical.
