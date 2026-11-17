# 0004. Map upstream accounts to WebIDs in static configuration, behind a replaceable interface

- **Status:** Accepted
- **Decided by:** @huwd
- **Decided:** 2026-11-17
- **Recorded:** 2026-11-17
- **Discussion:** Repository set-up, 17 November 2026 (no issue)

## Summary

The broker decides which WebID a login gets from a static mapping in configuration.
Each entry pairs an upstream issuer and subject with one WebID, and any account without an entry is refused.
The code reads the mapping through a small interface, so a database-backed version can replace the file later without changing the login flow.
Static mapping suits a broker with one or a few users, and keeps the security-critical decision in reviewed configuration.

## Context

After the upstream login, the broker has the upstream issuer (`iss`) and subject (`sub`) and must decide which WebID, if any, to put in its tokens.
A wrong mapping lets one person act as another across every Solid server that trusts the broker.

The first deployment has one user.
The planning notes require that an email address or other user-supplied claim must never select a WebID, and that refused mappings are tested as well as successful ones.

## Options considered

### Static configuration, keyed by upstream issuer and subject (chosen)

A JSON configuration file lists the allowed accounts, for example:

```json
{
  "accounts": [
    {
      "upstreamIssuer": "https://auth.example.org",
      "upstreamSubject": "8c1f…",
      "webId": "https://example.org/profile#me"
    }
  ]
}
```

JSON needs no parser dependency. YAML would be easier to edit by hand, but would add one.

The mapping is reviewed, versioned with the deployment and needs no admin interface.
Pocket ID's subject is a stable identifier, unlike a username or email address, which can change or be reused.
Adding a user means editing configuration and restarting.

### A database with an admin interface or self-registration

Needed for many users, but brings an admin interface, account lifecycle and the security work that goes with them.
None of that is needed for one user.

### Derive the WebID from an upstream claim

For example, a custom claim containing the WebID, or a WebID built from the username.
This trusts the upstream provider, and anyone able to edit that claim, to choose the identity. That breaks the rule that user-supplied claims never select a WebID.

## Decision

- The broker reads accounts from static configuration at startup and validates them with a schema. It refuses to start if the configuration is invalid.
- Each account maps one exact pair of upstream issuer and subject to one WebID. Duplicate pairs are a configuration error.
- A login with no matching account is refused. The broker never matches on email, username or any other claim.
- The login flow looks accounts up through an interface, for example `AccountStore.findByUpstream(issuer, subject)`, so a database-backed implementation can replace the static one.

## Consequences

- Adding, changing or removing a user needs a configuration change and a restart.
- Tests cover a refused account, a near-miss on subject, and a matching subject from a different issuer.
- Moving to a database means writing a new implementation of the interface and a record that supersedes this one. [0005](0005-sqlite-for-provider-state.md) already provides SQLite, which is a natural home for accounts later.
- The upstream subject must be looked up once, for example from Pocket ID's user details, and copied into configuration. The documentation needs to explain how.
