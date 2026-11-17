# solid-oidc

A Solid-OIDC identity provider that brokers login to an upstream OpenID Connect provider, with Pocket ID as the reference upstream. It is the broker only: Pod storage and access control live in separate Solid servers. [`README.md`](README.md) gives the overview.

## Commands

Run everything inside `devenv shell`, or prefix a command with `devenv shell --`.

| Command | Does |
| ------- | ---- |
| `pnpm run check` | Everything CI runs, except the image build |
| `pnpm run format` | Biome formatting and safe fixes |
| `pnpm run lint` / `typecheck` / `test` / `docs:lint` | One check each |
| `ISSUER_URL=http://localhost:3000 pnpm run dev` | Run with reload |
| `docker build --tag solid-oidc:dev .` | Build the image |

Node runs `.ts` files directly, by stripping types. There is no build step, so import local files with their `.ts` extension.

## Conventions

- Follow [`docs/code-style.md`](docs/code-style.md) for TypeScript. Call out any deviation and its reason.
- Keep 100% test coverage. Use `node:test`, not Vitest or Jest.
- Write documentation in plain British English in the GOV.UK style.
- Record significant decisions in [`docs/decisions/`](docs/decisions/README.md).
- Add a user-facing change to `## [Unreleased]` in [`CHANGELOG.md`](CHANGELOG.md) in the same commit. [`docs/releasing.md`](docs/releasing.md) covers releases.
- Pin dependencies exactly. pnpm refuses versions published less than 48 hours ago.
- Keep deployment-specific values, such as real domains, out of the repository. They belong in environment variables or the deployment configuration in Composer.

## Secrets

Follow [`docs/development-secrets.md`](docs/development-secrets.md). In short:

- Run a command that needs a secret under `with-secrets`. Each call needs a Bitwarden approval from the user.
- Never write, print or echo a secret value, and never load secrets through direnv or devenv.
- The user edits secrets with `! secrets-edit secrets.sops.env`. To list key names only, use `grep --only-matching '^[A-Z_]*=' secrets.sops.env`.

## Git

- `PLAN.md` is a local planning note, excluded through `.git/info/exclude`. Do not commit it.
- Commits are signed through the Bitwarden SSH agent.
- CI workflows stay read-only. Only the release job may write, and only to packages. Run `gh actions-lock` after changing any `uses:` line.
