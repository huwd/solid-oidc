# solid-oidc

A Solid-OIDC identity provider that brokers login to an upstream OpenID Connect provider, with Pocket ID as the reference upstream. It is the broker only: Pod storage and access control live in separate Solid servers. [`README.md`](README.md) gives the overview.

## Commands

Run everything inside `devenv shell`, or prefix a command with `devenv shell --`.

| Command | Does |
| ------- | ---- |
| `pnpm run check` | Everything CI runs, except the image build |
| `pnpm run format` | Biome formatting and safe fixes |
| `pnpm run lint` / `typecheck` / `test` / `docs:lint` | One check each |
| `pnpm run workflows:audit` | zizmor security audit of the workflows, also run in CI |
| `pnpm run docs:prose` | Vale prose and British spelling check: advisory, local only |
| `ISSUER_URL=http://localhost:3000 pnpm run dev` | Run with reload |
| `docker build --tag solid-oidc:dev .` | Build the image |

Node runs `.ts` files directly by stripping types, with no build step, so import local files with their `.ts` extension.

## Conventions

- Follow [`docs/code-style.md`](docs/code-style.md) for TypeScript. Call out any deviation and its reason.
- Keep 100% test coverage. Use `node:test`, not Vitest or Jest.
- Write documentation in plain British English in the GOV.UK style, and run `pnpm run docs:prose` on changed Markdown. Fix its errors; judge its warnings. Add genuine project terms to `.vale/styles/config/vocabularies/House/accept.txt`.
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
- Commits are signed through the Bitwarden SSH agent. Commit with `git commit -s` so Git adds a `Signed-off-by` line naming the maintainer; never write that line yourself.
- Attribute AI help with trailers, in this order, following the [laptop repository's record 0016](https://huwd.github.io/declarative_laptop/decisions/0016-ai-attribution-trailers/):

  ```text
  Generated-by: Claude Code:<model-id>
  Co-Authored-By: <model name> <noreply@anthropic.com>
  Signed-off-by: (added by git commit -s)
  ```

  Use `Generated-by` when the agent produced most of the change from prompts, and `Assisted-by` when the maintainer did most of the work. Say which you chose when committing.
- CI workflows stay read-only. Only the release job may write, and only to packages. Run `gh actions-lock` after changing any `uses:` line.
