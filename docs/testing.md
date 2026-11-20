# Testing

This guide explains how the broker is tested and where each kind of test belongs. It is for anyone adding or changing code in the broker.

The broker is tested against real OpenID implementations wherever a protocol is involved, with injected fakes for the network and small stubs for failures. [Decision 0010](decisions/0010-test-against-real-implementations.md) explains why.

Run every automated test, with coverage, with:

```sh
pnpm run test
```

Coverage must stay at 100% for lines, branches and functions, or the command fails. The [style guide](code-style.md#tests) covers how to write each test.

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

### Compatibility tests

Planned in [#9](https://github.com/huwd/solid-oidc/issues/9). They will check the broker against the real Pocket ID and a Community Solid Server, including token checks with `@solid/access-token-verifier`, which needs a served WebID profile.

## Shared helpers

Helpers shared between test files live in `src/test-support/`. The test script leaves that directory out of coverage, and `.dockerignore` leaves it out of the image.

| Helper | Use it to |
| ------ | --------- |
| `login-harness.ts` | Start the broker, the stand-in upstream and a browser together, start an app's login, exchange a code with DPoP, and restart the broker |
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
