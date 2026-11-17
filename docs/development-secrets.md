# Development secrets

This guide explains how to use secrets, such as an upstream OpenID client secret, when developing the broker locally. [Decision 0007](decisions/0007-development-secrets.md) explains why it works this way.

Secrets are encrypted at rest with [SOPS](https://getsops.io/) and age. Nothing decrypted is written to disk. The tools come from the [laptop configuration](https://huwd.github.io/declarative_laptop/decisions/0013-derive-age-key-from-ssh-agent/), not from this repository:

- `with-secrets` decrypts `~/.secrets/dev.sops.env`, then `secrets.sops.env` at the repository root if it exists, and runs one command with the values in its environment. Values from the repository file override the shared file.
- `secrets-edit` edits an encrypted file through a temporary file on tmpfs.

Each call asks for one Bitwarden approval.

## Run the broker with secrets

```sh
devenv shell -- with-secrets pnpm run dev
```

To pass only the variables a command needs:

```sh
with-secrets --only UPSTREAM_CLIENT_SECRET -- pnpm run dev
```

## Add or change a secret

```sh
secrets-edit secrets.sops.env
```

[`.sops.yaml`](../.sops.yaml) encrypts any `*.sops.env` file to two recipients: the identity derived from the SSH agent, and the recovery identity held in Bitwarden. Commit the encrypted file.

## Rules

- Never write a decrypted value to a file, `.env`, `/tmp`, a log or an issue.
- Never load secrets through direnv or a devenv hook. Every child process would see them, including coding agents.
- Never run `with-secrets` under `set -x`, which prints the values.
- Deleting a leaked secret from the repository does not remove it from Git history. Rotate it with the provider that issued it.
- Multi-line values arrive with literal `\n` sequences. Convert them in the code that reads them.
