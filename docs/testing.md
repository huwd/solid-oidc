# Testing

This guide explains how the broker is tested and where each kind of test belongs. It is for anyone adding or changing code in the broker.

The broker is tested against real OpenID implementations wherever a protocol is involved, with injected fakes for the network and small stubs for failures. [Decision 0010](decisions/0010-test-against-real-implementations.md) explains why.

Run every automated test, with coverage, with:

```sh
pnpm run test
```

Coverage must stay at 100% for lines, branches and functions, or the command fails. The [style guide](code-style.md#tests) covers how to write each test.

Coverage shows that code ran, not that a test would notice it being wrong. [Mutation testing](#mutation-testing) checks that.

## Layers

| Layer | Runs | Upstream provider | Solid side |
| ----- | ---- | ----------------- | ---------- |
| Unit | Every pull request | Injected fakes | Injected fakes |
| In-process integration | Every pull request | A real `oidc-provider` instance configured like Pocket ID | `openid-client` with DPoP as the app, and Client ID Documents from an injected `fetch` |
| Compatibility | On demand, in Docker ([#9](https://github.com/huwd/solid-oidc/issues/9)) | The real Pocket ID image | A Community Solid Server and a Solid client library |

The [sandbox](../README.md#sandbox) is not a test layer. It runs the same journey for a person to watch in a browser.

### Unit tests

Test a module on its own, with its dependencies passed in. Examples:

- `load-config.test.ts` reads files through an in-memory reader.
- `pending-logins.test.ts` and `database.test.ts` take a clock, so expiry needs no waiting.
- `database.test.ts` uses `mock.timers` from `node:test` for the cleanup schedule.

### In-process integration tests

Test a whole flow through the broker's HTTP interface, with real implementations on either side, all in the test process on free loopback ports. Examples:

- `login.test.ts` logs in through the stand-in upstream provider and checks every refusal.
- `solid.test.ts` checks discovery, DPoP, the claims and signature of the access token, and Client ID Documents.
- `restart.test.ts` restarts the broker and checks sessions and refresh tokens survive.
- `rotation.test.ts` rotates and revokes keys between restarts, and checks which tokens and sessions still work.

### Compatibility tests

Planned in [#9](https://github.com/huwd/solid-oidc/issues/9). They will check the broker against the real Pocket ID and a Community Solid Server, including token checks with `@solid/access-token-verifier`, which needs a served WebID profile.

## Shared helpers

Helpers shared between test files live in `src/test-support/`. The test script leaves that directory out of coverage, and `.dockerignore` leaves it out of the image.

| Helper | Use it to |
| ------ | --------- |
| `login-harness.ts` | Start the broker, the stand-in upstream and a browser together, start an app's login, exchange a code with DPoP, and restart the broker, optionally with new keys |
| `tokens.ts` | Decode a token, list the broker's published keys, and check a signature as a Solid server does |
| `upstream-provider.ts` | Run an `oidc-provider` instance configured like Pocket ID, which logs in whichever subject the test chooses |
| `browser.ts` | Follow redirects and keep cookies per origin, post forms, and stop at or rewrite a redirect |
| `client-documents.ts` | Serve Client ID Documents from memory through a fake `fetch`, and see each request |
| `loopback.ts` | Listen on a free loopback port before the handler exists, and swap the handler later |
| `broker-app.ts` | Build the broker's app with an upstream it never calls, and open an in-memory database |

Name a helper after what it provides, such as `upstream-provider.ts`, not after the test that first needed it. Add one when a second test file needs the same set-up.

The stand-in upstream provider imitates Pocket ID:

- the issuer has no trailing slash
- `sub` is an internal ID, not a username or email address
- the client authenticates with a secret, and PKCE is required
- ID tokens are signed with RS256
- it also returns email and username claims, which the broker must ignore

Like Pocket ID, it keeps its own session. If the broker loses a session, the stand-in logs the same person straight back in, so a test that only checks the login reaches the app can't tell. To check that the broker's own session answered, use `visitUsingBrokerSession`, which stops if the login goes to the upstream provider.

## Injected fetch

Code that calls the network takes a `fetch` function, rather than calling the global one. Tests pass a fake, so timeouts, size limits and bad responses need no slow or misbehaving servers.

The broker passes `globalThis.fetch` in production. `oidc-provider` then adds its own timeout and refuses private and loopback addresses. That refusal applies only to the real `fetch`, so the broker's tests don't cover it: `oidc-provider`'s own tests do.

Never detect a test environment to change behaviour. The development setting `DEVELOPMENT_ALLOW_LOOPBACK_CLIENT_IDS` exists for the sandbox, not for tests, which don't need it. [Decision 0009](decisions/0009-loopback-client-ids-for-development.md) explains it.

## Hand-written stubs

Use a stub only for a failure a real implementation won't produce on demand. Keep it to a few lines, in the test that needs it:

- a `fetch` that returns a 404, a redirect, a body that isn't JSON or a document over the size limit, or never answers
- an object standing in for the provider whose method rejects, to check an unexpected error isn't mistaken for an expired login
- an upstream issuer on a closed port, to check the broker reports the upstream as unavailable

Don't intercept Node's `http` module or `fetch`, for example with `nock`. The style guide forbids monkey-patching.

## Coverage exemptions

A `/* node:coverage ignore next N */` comment is allowed only for code that can't run, with a comment saying why on the next line. Examples are a check that a library already guarantees, or a file system that lacks hard links. Prefer restructuring the code so the branch disappears.

The entry points in `src/bin/` are left out of coverage, because they need real process signals and exit codes. Keep logic out of them.

## Mutation testing

Mutation testing checks that the tests would fail if the code were wrong. StrykerJS makes small changes to the code, called mutants, such as flipping a comparison or removing a call, and runs the tests that cover each one. A mutant that no test fails on has survived. [Decision 0012](decisions/0012-mutation-testing.md) explains the choice.

The Mutation testing check runs on every pull request, and fails if any mutant survives. It mutates:

- the broker source lines the pull request changed
- the whole module of each changed unit test, such as `src/keys.ts` for `src/keys.test.ts`, when that module is listed in `stryker.config.json`
- every listed module, when the pull request changes an integration test, which has no module of the same name, a helper in `src/test-support/`, or `stryker.config.json`

A weakened test can let mutants survive in code the pull request didn't touch, so changed tests are checked too. [Decision 0013](decisions/0013-mutate-modules-changed-tests-protect.md) explains the rules. Every week, the check also mutates every listed module.

Run every module locally with:

```sh
pnpm run test:mutation
```

This takes about two minutes. To check one module, or some of its lines, as the pull request check does, name them:

```sh
pnpm exec stryker run --mutate src/keys.ts
pnpm exec stryker run --mutate src/keys.ts:120-140
```

Stryker prints each surviving mutant, with the change it made. Its full report is in `reports/mutation/mutation.json`.

### Dealing with a surviving mutant

Kill it, if you can, with a test that fails on the changed code. A survivor usually means a test checks that something happened but not what, such as a status code without the page's message or headers.

Sometimes no test could ever tell the mutant from the original. Examples are a setting equal to the library's default, or a check that another check already makes. Simplify the code if the mutant shows a line does nothing. Otherwise record it on the line before, naming the mutator and giving the reason:

```ts
// Stryker disable next-line OptionalChaining: PRAGMA user_version always returns a row.
return Number(row?.["user_version"]);
```

For a block, put `// Stryker disable all: <reason>` before it and `// Stryker restore all` after it. A comment just before `} else if` applies to the previous block, so put it inside the condition instead. Don't leave mutators or files out in `stryker.config.json` to hide survivors.

The break threshold is 100, so every mutant must be killed or recorded. Mutants that crash a test file as it loads, such as broken key generation, show as errors. They are detected, and don't count against the score.

Stryker can't yet use its TypeScript checker with TypeScript 7, so some mutants that wouldn't compile still run. If one survives only because types are stripped, record it as above. [#25](https://github.com/huwd/solid-oidc/issues/25) tracks the fix.
