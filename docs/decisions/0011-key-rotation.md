# 0011. Rotate keys in timed steps, and revoke them separately

- **Status:** Accepted
- **Decided by:** @huwd
- **Decided:** 2026-11-20
- **Recorded:** 2026-11-20
- **Discussion:** [#12](https://github.com/huwd/solid-oidc/issues/12)

## Summary

The broker's keys are replaced with a command that changes `DATA_DIR/keys.json`, followed by a restart.
A planned rotation has three timed steps, so no token or session stops working: publish a new signing key, start signing with it, then remove the old one.
A separate command revokes keys that may have leaked, replacing every key at once and deleting every session and token.

## Context

The broker signs access tokens and ID tokens with an ES256 key, and publishes it at its JWKS URL. A JWKS can hold several keys: the `kid` header of each token names the key that signed it. `oidc-provider` signs with the first key in its list and publishes them all.
It signs cookies with a separate cookie key, and verifies cookies signed by any older cookie key it is given.

Until #12, the broker created one key of each kind on first start and never replaced them. The only way to replace them was to delete `keys.json`, which invalidated every token and session at once.

Two situations need different answers:

- **Planned rotation**, as routine hygiene. Nothing should stop working.
- **A leak.** A copy of `keys.json` lets someone forge an access token for any WebID until Solid servers stop accepting the key. The database beside it holds sessions and refresh tokens, so a copy of one probably means a copy of both.

How Solid servers fetch the broker's keys decides the timing. The Community Solid Server 7.3 verifies tokens with `@solid/access-token-verifier` 2.1, which uses `jose` 5's remote key set:

| Behaviour | Time |
| --------- | ---- |
| The cache in the verifier of an issuer's key set expires | 2 minutes |
| `jose` fetches the key set again on an unknown `kid`, unless it fetched within | 30 seconds |
| `jose`'s own default cache, for other verifiers built on it | 10 minutes |
| Clock tolerance on token times in the verifier | 2 minutes |

## Options considered

### Publish, then promote, then retire (chosen)

`rotate` adds a signing key at the end of the list, where it is published but doesn't sign. `promote` moves it first, after 10 minutes. `retire` removes old signing keys 65 minutes after that: the 1-hour token lifetime and a 5-minute margin for clock tolerance.

A new cookie key goes first straight away, because older cookie keys keep verifying. Old cookie keys are removed 14 days later, the session lifetime.

- No token or session stops working, whatever the Solid server's cache.
- A planned rotation takes 75 minutes and three restarts, then a fourth after 14 days.

### Sign with the new key at once, then retire

- One fewer step and restart.
- `jose` fetches the key set again on an unknown `kid`, so this mostly works. But a Community Solid Server that fetched the key set less than 30 seconds before the first new-key token arrives rejects that token. Verifiers that don't fetch again on an unknown `kid` would reject tokens for longer.

### Rotate automatically on a schedule

- No operator steps.
- Out of scope for #12, which asks for manual rotation first. The timed steps here are what an automatic rotation would run.

## Decision

`node src/bin/keys.ts` has five commands, each followed by a broker restart:

- `list` shows each key and what it does
- `rotate` publishes a new signing key and starts a new cookie key
- `promote` starts signing with the new key, from 10 minutes after `rotate`
- `retire` removes old signing keys from 65 minutes after `promote`, and old cookie keys from 14 days after `rotate`
- `revoke --confirm` deletes every session, grant, code and token, then replaces every key, keeping none

`promote` and `retire` accept `--skip-wait`, for an operator who accepts that dependent tokens or sessions stop working.

The key file records when each key was added and when each signing key started signing, so the commands can refuse to run early. The token, session and grant lifetimes the waits depend on are set explicitly in the provider configuration, in `src/lifetimes.ts`, rather than left to `oidc-provider`'s defaults.

## Consequences

- A planned rotation logs nobody out.
- `revoke` logs everyone out, and apps must ask again for permission to use each WebID. It deletes the database's contents before replacing the keys, so stolen refresh tokens can't be used to get tokens signed with the new key.
- After `revoke`, a Solid server may accept tokens signed with the leaked key until its cache expires: 2 minutes for the Community Solid Server. The broker can't shorten that, so the README tells operators to restart their Solid servers if they need an immediate cut-off.
- The broker reads its keys only at startup, so each step needs a restart. A broker that isn't restarted after `rotate` hasn't published the new key, and `promote`'s wait can't detect that. The README says to restart straight away.
- Changing a lifetime in `src/lifetimes.ts` changes the waits with it.
- The key file's format is now version 2. The broker still reads version 1 files, treating their keys as added when the file was last written.
