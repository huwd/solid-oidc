# Rulesets

The repository rulesets, defined as JSON so that changes to them go through review.
The approach follows [huwd/immurok-nix](https://github.com/huwd/immurok-nix/tree/main/.github/rulesets).

GitHub doesn't apply these files by itself.
After a change merges, a maintainer applies it with the API.

## What `protect_main.json` enforces

- `main` can't be deleted or force-pushed.
- Commits must be signed.
- Changes arrive through a pull request, merged with a merge commit.
  Squash and rebase merges aren't allowed, because they break commit signatures.
- No approving review is required, because the repository has one maintainer.
- These CI jobs must pass, and the branch must be up to date with `main` before merging:
  - from the CI workflow: `Lint`, `Typecheck`, `Test`, `Docs lint`, `Workflow audit` and `Image`
  - from the Verify pins workflow: `Verify lockfile` and `Verify SHA pins`

  Each check is tied to the GitHub Actions app, so another app can't report a pass.
  Add a new job here only after it has reported on `main`, since a required check that never reports blocks every merge.

## Applying a change

The API call needs administration access to the repository, so CI doesn't do it.
Either use the GitHub CLI, signed in as a repository administrator, or a fine-grained personal access token limited to this repository, with:

- read access to metadata
- read and write access to administration

Create the ruleset the first time:

```sh
gh api --method POST repos/huwd/solid-oidc/rulesets --input .github/rulesets/protect_main.json
```

Find the ruleset ID with `gh api repos/huwd/solid-oidc/rulesets`.
Update an existing ruleset with the same file:

```sh
gh api --method PUT repos/huwd/solid-oidc/rulesets/{id} --input .github/rulesets/protect_main.json
```

Afterwards, compare the result in the repository's settings under Rules.
