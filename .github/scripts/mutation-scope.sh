#!/usr/bin/env bash
# Print what the pull request's Mutation testing check mutates, as a
# comma-separated list for Stryker's --mutate option. Prints nothing if
# there is nothing to mutate. Decision 0013 explains the rules:
#
# - Changed broker source: its changed lines, from mutation-ranges.sh.
# - A changed unit test, such as src/keys.test.ts, whose module is in
#   stryker.config.json: the whole module, src/keys.ts.
# - A changed test with no module of the same name, such as an integration
#   test like src/login.test.ts, a changed test helper, or a changed
#   stryker.config.json: every module in stryker.config.json.
#
# Usage: mutation-scope.sh BASE
set -euo pipefail

base=$1
here=$(dirname "$0")

configured=$(node --print 'require("./stryker.config.json").mutate.join("\n")')
whole=()
everything=false

while IFS= read -r file; do
  case "$file" in
    "") ;;
    src/test-support/* | stryker.config.json) everything=true ;;
    *.test.ts)
      module=${file%.test.ts}.ts
      if [ ! -e "$module" ]; then
        everything=true
      elif grep -qxF "$module" <<< "$configured"; then
        whole+=("$module")
      fi
      ;;
  esac
done < <(git diff --name-only "$base...HEAD" -- 'src/*.test.ts' 'src/test-support/*' stryker.config.json)

if [ "$everything" = true ]; then
  mapfile -t whole <<< "$configured"
fi

# Changed lines in modules that aren't already mutated whole.
ranges=()
# mutation-ranges.sh ends without a newline, so read a last unterminated line too.
while IFS= read -r range || [ -n "$range" ]; do
  [ -n "$range" ] || continue
  module=${range%%:*}
  if [ "${#whole[@]}" -eq 0 ] || ! printf '%s\n' "${whole[@]}" | grep -qxF "$module"; then
    ranges+=("$range")
  fi
done < <("$here/mutation-ranges.sh" "$base" | tr ',' '\n')

if [ "${#whole[@]}" -gt 0 ]; then
  mapfile -t whole < <(printf '%s\n' "${whole[@]}" | sort -u)
fi
(
  IFS=,
  all=("${whole[@]}" "${ranges[@]}")
  echo "${all[*]}"
)
