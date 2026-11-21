#!/usr/bin/env bash
# Finish the current branch for review. Agents commit without a signature
# or a Signed-off-by line, because both are the maintainer's. This script:
#
# 1. adds the maintainer's sign-off and signature to every commit on the
#    branch that lacks a sign-off, leaving earlier commits as they are
# 2. merges main, signed and signed off, if the branch is behind it
# 3. checks every commit is signed and signed off
# 4. pushes the branch and marks its pull request ready for review
#
# Each new signature asks for a Bitwarden approval.
#
# Usage: scripts/sign-off.sh
set -euo pipefail

fail() {
  echo "sign-off: $*" >&2
  exit 1
}

branch=$(git branch --show-current)
[ -n "$branch" ] || fail "not on a branch"
[ "$branch" != main ] || fail "refusing to change main"
[ -z "$(git status --porcelain --untracked-files=no)" ] || fail "commit or stash your changes first"

sign_off="Signed-off-by: $(git config user.name) <$(git config user.email)>"
has_sign_off() {
  git log -1 --format=%B "$1" | grep -qxF "$sign_off"
}

git fetch --quiet origin main

# The oldest commit without a sign-off. Rebasing from its parent rewrites
# only it and the commits after it, keeping any merges.
first=""
for commit in $(git rev-list --reverse --no-merges origin/main..HEAD); do
  if ! has_sign_off "$commit"; then
    first=$commit
    break
  fi
done
if [ -n "$first" ]; then
  echo "Signing off $(git rev-list --count "$first^..HEAD") commits from $(git log -1 --format='%h %s' "$first")"
  git rebase --quiet --signoff --force-rebase --rebase-merges "$first^" ||
    fail "the rebase stopped. Finish it with git rebase --continue, then run this again"
fi

if ! git merge-base --is-ancestor origin/main HEAD; then
  echo "Merging main"
  git merge --signoff --no-edit origin/main ||
    fail "the merge has conflicts. Resolve them, run git commit -s, then run this again"
fi

for commit in $(git rev-list origin/main..HEAD); do
  summary=$(git log -1 --format='%h %s' "$commit")
  [ "$(git log -1 --format=%G? "$commit")" = G ] || fail "$summary has no good signature"
  has_sign_off "$commit" || fail "$summary has no sign-off"
done

git push --force-with-lease --set-upstream origin "$branch"
if gh pr view "$branch" --json isDraft --jq .isDraft | grep -qx true; then
  gh pr ready "$branch"
fi
gh pr view "$branch" --json url --jq .url
