# Decision records

Significant decisions about this repository, one per file, with the context and the options that lost.
[0000](0000-record-decisions.md) explains why they exist and why they take this form.

## When to write one

Write a record when a decision:

- is costly or awkward to reverse, such as the issuer URL format or the storage engine
- chooses between real alternatives, and the losing options are worth remembering
- would leave a future reader asking "why is it like this?"

Routine changes don't need one.
When unsure, ask whether the reasoning would otherwise only live in a closed issue or a pull request description.

## How to write one

1. Copy [`template.md`](template.md) to `NNNN-short-slug.md`, using the next free number.
2. Fill in every section, starting with a short, plain-language summary of the problem, the choice and why it matters.
3. List the options that lost and why.
   This is often the most useful part.
4. Link the discussion, if there was one in an issue or pull request.
5. Add the record to the index below, then check it with `pnpm run docs:lint`.

### Voice

Name the people who made the decision in the "Decided by" line, by GitHub handle, such as @huwd.
In records, avoid first-person pronouns ("I" and "we").
Use concrete subjects and verbs, such as "The broker stores grants in SQLite".
Anyone can propose a record, and it should read the same whoever wrote it.

### Dates

**Decided** gives the date of the decision; **Recorded** gives the date of writing.

### Status

| Status | Meaning |
| ------ | ------- |
| Proposed | Written, not yet agreed |
| Accepted | In effect |
| Deprecated | No longer applies, and nothing replaced it |
| Superseded by NNNN | Replaced by a later record |

Don't rewrite an accepted record when a decision changes.
Write a new record, set the old one's status to "Superseded by" with a link, and keep the rest unchanged.
Editorial improvements, such as clearer wording, typo corrections and link fixes, are fine if they preserve the decision and its reasoning.

## Index

| Number | Decision | Status |
| ------ | -------- | ------ |
| [0000](0000-record-decisions.md) | Record decisions in lightweight decision records | Accepted |
| [0001](0001-broker-to-an-upstream-provider.md) | Build a Solid-OIDC broker in front of any standard OpenID provider | Accepted |
| [0002](0002-typescript-on-node.md) | Write the broker in TypeScript on Node.js, with oidc-provider and openid-client | Accepted |
| [0003](0003-toolchain.md) | Run TypeScript directly on Node 26, with pnpm, Biome and the built-in test runner | Accepted |
| [0004](0004-static-user-mapping.md) | Map upstream accounts to WebIDs in static configuration, behind a replaceable interface | Accepted |
| [0005](0005-sqlite-for-provider-state.md) | Store provider state in SQLite through node:sqlite | Accepted |
| [0006](0006-container-image-on-ghcr.md) | Publish a distroless amd64 image to GitHub Container Registry from version tags | Accepted |
| [0007](0007-development-secrets.md) | Keep development secrets in SOPS files and inject them with with-secrets | Accepted |
| [0008](0008-solid-oidc-through-oidc-provider-features.md) | Meet Solid-OIDC through oidc-provider's own features | Accepted |
| [0009](0009-loopback-client-ids-for-development.md) | Allow loopback Client ID Documents only behind a development setting | Accepted |
| [0010](0010-test-against-real-implementations.md) | Test against real protocol implementations, not scripted stubs | Accepted |
| [0011](0011-key-rotation.md) | Rotate keys in timed steps, and revoke them separately | Accepted |
| [0012](0012-mutation-testing.md) | Check the tests with StrykerJS mutation testing, gated on changed lines | Accepted |
| [0013](0013-mutate-modules-changed-tests-protect.md) | Mutate the modules that changed tests protect | Accepted |
