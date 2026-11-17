# 0007. Keep development secrets in SOPS files and inject them with with-secrets

- **Status:** Accepted
- **Decided by:** @huwd
- **Decided:** 2026-11-17
- **Recorded:** 2026-11-17
- **Discussion:** Repository set-up, 17 November 2026 (no issue)

## Summary

Development secrets, such as an upstream client secret for testing against Pocket ID, are encrypted with SOPS and age.
They are injected into one command at a time with `with-secrets`, which decrypts them with an age key derived from the SSH agent after a Bitwarden approval.
This follows the approach the author already uses for the laptop configuration and the Composer repository. Nothing decrypted touches the disk, and the encrypted files can be committed.

## Context

Testing the broker against a real upstream provider needs a client ID and secret, and later possibly signing keys.
The author's laptop configuration provides `sops-age-derive`, `with-secrets` and `secrets-edit`, described in [laptop record 0013](https://huwd.github.io/declarative_laptop/decisions/0013-derive-age-key-from-ssh-agent/).
Composer uses them with a shared `~/.secrets/dev.sops.env` and an optional `secrets.sops.env` per repository, and forbids loading secrets through direnv or shell hooks, where every child process, including coding agents, would see them.

## Options considered

### SOPS with the derived age key and with-secrets (chosen)

The same tools and rules as the author's other repositories.
Each use needs an approval, and only the wrapped command sees the values.
It depends on the laptop's tooling, so another contributor would need their own age recipient added to `.sops.yaml`.

### Plaintext .env files, ignored by Git

Simple and common, but leaves secrets on disk in plain text, readable by any process.

### devenv's secret integrations

devenv can load secrets into the shell.
Every process in that shell would then see them, which breaks the rule against loading secrets through hooks.

## Decision

- `.sops.yaml` encrypts any `*.sops.env` file to the derived laptop identity and the recovery identity held in Bitwarden, the same recipients as Composer.
- Project secrets, when needed, go in `secrets.sops.env` at the repository root, edited with `secrets-edit`.
- Commands that need secrets run under `with-secrets`. devenv provides tools only and never loads secrets.
- Production secrets are not kept here. They belong to the deployment in Composer.

## Consequences

- Encrypted secrets can be committed and reviewed by key name without exposing values.
- Each command that needs secrets needs a Bitwarden approval, which slows repeated runs a little.
- Another contributor's key must be added as a recipient, and existing files re-encrypted, before they can decrypt them.
- A leaked secret stays in Git history even after deletion. It must be rotated with the provider that issued it.
