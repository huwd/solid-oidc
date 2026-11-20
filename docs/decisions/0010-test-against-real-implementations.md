# 0010. Test against real protocol implementations, not scripted stubs

- **Status:** Accepted
- **Decided by:** @huwd
- **Decided:** 2026-11-20
- **Recorded:** 2026-11-20
- **Discussion:** [#11](https://github.com/huwd/solid-oidc/issues/11)

## Summary

The broker's tests run it against real OpenID implementations: an `oidc-provider` instance standing in for Pocket ID, and `openid-client` acting as the Solid app.
Hand-written stubs are kept for failures a real implementation won't produce on demand, and dependencies such as `fetch` are injected rather than intercepted.
This tests the broker against how the protocols behave, not against a script's reading of the specifications.

## Context

The broker sits between two protocols: OpenID Connect towards the upstream provider, and Solid-OIDC towards Solid apps and servers.
Both rely on signed tokens, published keys, PKCE, nonces and, for Solid-OIDC, a fresh DPoP proof on every token request.
A test of a login has to produce and check all of these.

[Decision 0003](0003-toolchain.md) aims for few dependencies, and the [style guide](../code-style.md) rules out monkey-patching modules or globals.

## Options considered

### Real implementations, with stubs for failures (chosen)

Run `oidc-provider` as the upstream provider and `openid-client` as the app, each on a free loopback port, in the test process.
Use a few lines of `node:http`, or an injected `fetch`, for responses a real implementation won't give, such as a Client ID Document over the size limit.

- Tokens, keys and proofs are made and checked by the same libraries other deployments use, so a disagreement with them shows up in the tests.
- Both libraries are already dependencies of the broker, so the tests add none.
- Tests start real servers, so they are slower than pure unit tests. A full login takes tens of milliseconds.

### Stub servers, such as Imposter, WireMock or Mockoon

- Good at replaying fixed responses.
- Faking a stateful, signed protocol would mean scripting a small OpenID provider inside the stub, and the tests would check the broker against that script.
- They add a runtime, often Java, and another configuration language.

### HTTP interception libraries, such as `nock`

- Little set-up.
- They work by patching Node's `http` module or `fetch`, which the style guide forbids, and they hide whether a request would really have been sent.

## Decision

The broker's automated tests use real `oidc-provider` and `openid-client` instances for every protocol exchange, injected fakes for code that calls the network, and small hand-written stubs only for failures.
[`docs/testing.md`](../testing.md) describes the practice.

## Consequences

- Shared helpers in `src/test-support/` start the stand-in upstream provider, drive a browser and serve Client ID Documents. They are part of the codebase, and are left out of coverage and of the image.
- Pocket ID's own behaviour is tested only by imitation. The compatibility tests in [#9](https://github.com/huwd/solid-oidc/issues/9) run the real Pocket ID image and a Community Solid Server to close that gap.
- The block on private and loopback addresses belongs to `oidc-provider` and applies only to the real `fetch`, so the broker's tests don't cover it.
