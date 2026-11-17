# 0001. Build a Solid-OIDC broker in front of any standard OpenID provider

- **Status:** Accepted
- **Decided by:** @huwd
- **Decided:** 2026-11-17
- **Recorded:** 2026-11-17
- **Discussion:** Repository set-up, 17 November 2026 (no issue)

## Summary

Solid apps need an issuer that speaks Solid-OIDC, and Pocket ID, the existing login, does not.
This repository builds a separate broker. It is the Solid-facing issuer, and it delegates the login itself to an upstream OpenID Connect provider.
The upstream is configurable and generic, with Pocket ID as the reference provider used in testing.
The broker does nothing else: Pod storage and access control belong to separate Solid servers.

## Context

The author runs [Pocket ID](https://pocket-id.org/) as the login for self-hosted services, with passkeys.
A planned personal Solid deployment needs Solid apps to log in with an identity tied to a WebID such as `https://example.org/profile#me`.

[Solid-OIDC](https://solidproject.org/TR/oidc) asks more of an issuer than ordinary OpenID Connect:

- access tokens bound to the client's key with DPoP
- a `webid` claim, and `solid` in the token audience
- client identifiers that are URLs to Client ID Documents, instead of pre-registered clients
- `solid_oidc_supported` and the `webid` scope in the discovery document

Pocket ID supports none of these.
Supporting ordinary OpenID Connect is not enough to list a provider as `solid:oidcIssuer` in a WebID profile.

## Options considered

### A standalone broker for any OpenID provider (chosen)

The broker acts as a Solid-OIDC issuer towards apps, and as an ordinary OpenID relying party towards the upstream provider.
After the upstream login, it maps the upstream issuer and subject to an approved WebID and issues its own tokens.

It keeps the existing login, passkeys and account management in Pocket ID.
Because the upstream only needs standard OpenID Connect with PKCE, the broker works with other providers too. This makes a public image useful beyond one deployment, at little extra cost.
The cost is another service to run, and an issuer whose signing keys and state need backing up.

### A broker specific to Pocket ID

The same design, but calling Pocket ID's own API or relying on its specific claims.
This would save little, since the standard flow already provides what the broker needs, and it would tie the project to one provider.
Pocket ID-specific behaviour is limited to configuration defaults and documentation.

### A login extension for the Community Solid Server

The Community Solid Server has its own identity provider and a mechanism for adding login methods.
An extension could delegate to Pocket ID there.
That ties identity to one Pod server's account model and release cycle.
A separate issuer lets the WebID, the issuer and the Pod servers change independently.

### A Solid-capable identity provider instead of Pocket ID

Run an identity provider with Solid support and stop using Pocket ID for this.
This would split logins across two providers and give up passkey support already in place.

## Decision

Build a broker that is a Solid-OIDC issuer towards apps and an OpenID Connect relying party towards one configured upstream provider.
The upstream is chosen by configuration and must support the authorisation code flow with PKCE.
Pocket ID is the reference upstream.
The broker does not store Pod resources or evaluate access policies.

## Consequences

- WebID profiles list the broker's issuer URL, not Pocket ID's, as `solid:oidcIssuer`.
- The mapping from upstream account to WebID is security-critical. An email address or any other user-supplied claim must never select a WebID. [0004](0004-static-user-mapping.md) covers how mapping works.
- The broker holds signing keys and session state that need backing up and restoring. [0005](0005-sqlite-for-provider-state.md) covers storage.
- Pod servers, such as Community Solid Server instances, must be configured to trust tokens from the broker.
- Deployment-specific values, such as domain names, stay in configuration, not in the repository.
