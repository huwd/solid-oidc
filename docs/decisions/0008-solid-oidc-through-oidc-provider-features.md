# 0008. Meet Solid-OIDC through oidc-provider's own features

- **Status:** Proposed
- **Decided by:** @huwd
- **Decided:** 2026-11-20
- **Recorded:** 2026-11-20
- **Discussion:** [#7](https://github.com/huwd/solid-oidc/issues/7)

## Summary

The broker meets Solid-OIDC's extra requirements by configuring features `oidc-provider` already has, rather than writing its own.
It resolves Client ID Documents with the library's experimental Client ID Metadata Document support. It issues JWT access tokens for a single resource, `urn:solid`, with the audience `solid`. It makes every client DPoP-bound by default.
This keeps the security-sensitive parts, fetching documents from addresses an app chooses and binding tokens to keys, in a library that is widely used and tested.

## Context

[Solid-OIDC](https://solidproject.org/TR/oidc) asks more of an issuer than OpenID Connect does:

- Apps aren't registered in advance. An app's `client_id` is an HTTPS URL to a Client ID Document, often JSON-LD, which the issuer fetches.
- Access tokens are JWTs, bound to the app's key with DPoP, with `solid` in the audience and `webid` and `client_id` claims.
- Discovery advertises `solid_oidc_supported` and a `webid` scope.

Fetching a document from a URL an app chooses is a server-side request forgery risk: a hostile `client_id` could point at the broker's own network. The fetch needs HTTPS only, a refusal of private and loopback addresses, a timeout, a size limit and a cache.

`oidc-provider` 9.15.0 implements [the Client ID Metadata Document draft, version 03](https://www.ietf.org/archive/id/draft-ietf-oauth-client-id-metadata-document-03.html). Its fetch accepts HTTPS URLs only, refuses private and loopback addresses, times out after 2.5 seconds, limits the body size, does not follow redirects, checks that the document names its own URL as `client_id`, and caches within set bounds. The feature is marked experimental.

The Community Solid Server also builds on `oidc-provider`, but predates this feature. It resolves Client ID Documents in its own storage adapter.

## Options considered

### Configure oidc-provider's features (chosen)

Turn on Client ID Metadata Document support and acknowledge its draft version, resource indicators with one Solid resource, and DPoP. Add the `webid` claim through `extraTokenClaims` and the account's claims.

- The protections on fetching are the library's, and are tested there.
- Little code of the broker's own: a custom `fetch` that asks for JSON-LD, a rule refusing `client_id` values on the broker's or the upstream provider's host, and cache bounds.
- The feature is experimental. A new draft can change it, and upgrading `oidc-provider` may need the acknowledged version changing. Pinned dependencies and the tests make that visible.
- The library parses the document as JSON and ignores `@context`. It does not interpret JSON-LD, which Solid apps don't need.

### Resolve Client ID Documents in a storage adapter, as the Community Solid Server does

- Proven in Solid deployments.
- The broker would carry its own fetch, size limit, timeout, address checks and cache, all security-sensitive, and their tests.
- It would mix fetching into storage, which [decision 0005](0005-sqlite-for-provider-state.md) keeps simple.

## Decision

The broker configures `oidc-provider`'s features to meet Solid-OIDC:

- Client ID Metadata Documents are on, with the draft-03 acknowledgement. The cache keeps a document for between one minute and one hour, within those bounds following the document's cache headers.
- The fetch asks for `application/ld+json` first, then `application/json`.
- A `client_id` on the broker's or the upstream provider's host is refused without fetching.
- Every access token is for the resource `urn:solid`: a JWT signed with ES256, with the audience `solid`. Any other `resource` is refused.
- Clients are DPoP-bound by default, so a token request without a DPoP proof is refused.
- The `webid` scope gives a `webid` claim in the ID token. Every access token carries `webid`, along with `client_id` and `cnf.jkt` from the library.

## Consequences

- Upgrading `oidc-provider` needs care while the feature is experimental: read its changelog for the Client ID Metadata Document draft, and update the acknowledgement if the draft changes.
- Tests inject `fetch`, so they serve Client ID Documents from memory, with no HTTPS server and no loopback exception. The library's address checks apply only to the real `fetch`, so they are covered by the library's tests, not the broker's.
- All Solid servers share one audience, `solid`. A token accepted by one Solid server is accepted by any other that trusts the broker, as Solid-OIDC intends.
- The cache is in memory for now. [Decision 0005](0005-sqlite-for-provider-state.md) moves it to SQLite in #8.
