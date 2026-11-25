# 0014. Refresh tokens last 14 days from consent, however often they are used

- **Status:** Proposed
- **Decided by:** @huwd
- **Decided:** 2026-11-25
- **Recorded:** 2026-11-25
- **Discussion:** to be added with the pull request

## Summary

An app that asks for `offline_access` gets a refresh token, which lets it get new access tokens without the person.
The broker now sets how long that lasts, rather than leaving it to `oidc-provider`'s default: 14 days from the consent that first issued it.
Using or rotating the token never extends that, so an app needs the person to log in again at least every 14 days.

## Context

`oidc-provider` logged `default ttl.RefreshToken function called, you SHOULD change it` at startup: the broker had never chosen a refresh token lifetime.

The default is 14 days. When the provider rotates a token, the new one keeps the old expiry only for some clients: public web clients, and tokens already a year old. For any other client, each rotation could start a fresh 14 days, so an app could stay logged in indefinitely.

Solid apps are public clients, their refresh tokens are DPoP-bound, and the grant behind each token lasts 14 days. Apps such as Penny ask for `offline_access`.

Refresh tokens are stored in the database, not signed, so key rotation ([0011](0011-key-rotation.md)) doesn't depend on their lifetime.

## Options considered

### 14 days from consent, never extended (chosen)

The same as the session and grant lifetimes, so one number describes how long an app can act without the person.
It matches the default for the clients the broker serves today, so nothing changes for them, and it closes the gap for any other kind of client.

### The default

It works for Solid apps today, but the lifetime would depend on client metadata and on `oidc-provider`'s choices in future releases.

### Shorter, such as 1 day

Safer if a refresh token leaks, but DPoP already binds each token to the app's key, and apps would ask the person to log in again every day.

### Sliding, extended on each use

Apps that are used regularly would never need the person again. That removes the regular point where someone can notice an app they no longer want.

## Decision

`ttl.RefreshToken` is `refreshTokenTtl` in `src/provider.ts`. A new refresh token lasts `refreshTokenLifetimeSeconds` from `src/lifetimes.ts`, which equals the session lifetime. A rotated token keeps the expiry of the token it replaces.

## Consequences

- Every app that uses refresh tokens needs a fresh login, with consent, at least every 14 days.
- Removing a person's account mapping still stops their refresh tokens working straight away, because the provider looks up the account on every refresh.
- Changing the session lifetime in `src/lifetimes.ts` changes the refresh token lifetime with it.
