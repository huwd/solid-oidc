# 0002. Write the broker in TypeScript on Node.js, with oidc-provider and openid-client

- **Status:** Accepted
- **Decided by:** @huwd
- **Decided:** 2026-11-17
- **Recorded:** 2026-11-17
- **Discussion:** Repository set-up, 17 November 2026 (no issue)

## Summary

The broker is written in TypeScript on Node.js.
The deciding factor is [`oidc-provider`](https://github.com/panva/node-oidc-provider): an OpenID Certified provider library with DPoP and other features Solid-OIDC needs, which the Community Solid Server already uses.
Its companion, [`openid-client`](https://github.com/panva/openid-client), handles the upstream login.
The cost is a larger image and more memory than a compiled language would need.

## Context

An identity provider is security-critical.
The less protocol code the project writes itself, the less there is to get wrong.
The language matters mainly for the libraries it makes available for token issuance, DPoP, discovery and client handling.

The author's preference was TypeScript, and it was open to alternatives.
The broker runs on a Synology NAS with limited memory, alongside other services.

## Options considered

### TypeScript on Node.js (chosen)

`oidc-provider` is certified, actively maintained and covers DPoP, PKCE, custom claims, discovery metadata and pluggable storage.
The Community Solid Server builds its identity provider on it, which shows it can meet Solid-OIDC's needs, and gives working code to compare against.
`openid-client`, by the same author, is a certified relying-party library for the upstream side.
Both have MIT licences.

The costs are a larger image (254 MB for the first skeleton, mostly the Node runtime), more memory than a native binary, and the npm supply chain.
Pinned versions, a lockfile and a release-age delay reduce the supply-chain risk ([0003](0003-toolchain.md)).

### Go

A single static binary, a small image and low memory use, which would suit the NAS.
Go has good OpenID libraries, but none with ready-made support for everything Solid-OIDC needs. The project would write more of the security-sensitive code itself.
That is the wrong trade for an authentication component maintained by one person.

### Rust

Similar advantages and drawbacks to Go, with a smaller set of mature OpenID provider libraries.

## Decision

Write the broker in strict TypeScript on Node.js.
Use `oidc-provider` for the Solid-facing issuer and `openid-client` for the upstream login.
Use Koa as the HTTP framework, because `oidc-provider` is built on it.

## Consequences

- The project configures and extends a certified provider instead of implementing OAuth and OpenID Connect itself.
- Solid-specific behaviour, such as Client ID Documents and the `webid` claim, is added through `oidc-provider`'s extension points. The Community Solid Server is a reference for how.
- Major `oidc-provider` releases can change its configuration interface. Upgrades need care and tests.
- The image and memory footprint are larger than a native binary. Revisit if the NAS runs short of memory.
