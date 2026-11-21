#!/usr/bin/env bash
# Print the broker source lines changed since a base commit, as a
# comma-separated list of Stryker mutate ranges, such as
# src/keys.ts:120-140,src/solid.ts:12-12. Prints nothing if no broker source
# changed. Tests, test helpers and entry points are left out, as they are of
# the full run.
#
# Usage: mutation-ranges.sh BASE
set -euo pipefail

base=$1

git diff --unified=0 --no-color "$base...HEAD" -- 'src/*.ts' \
  ':!src/*.test.ts' ':!src/test-support/*' ':!src/bin/*' |
  awk '
    # "+++ b/src/keys.ts", or "+++ /dev/null" for a deleted file.
    /^\+\+\+ / { file = ($2 == "/dev/null") ? "" : substr($2, 3); next }
    # "@@ -old,count +start,count @@": a count of 0 means lines were only removed.
    /^@@ / {
      count = split($3, added, ",")
      start = substr(added[1], 2)
      lines = (count == 2) ? added[2] : 1
      if (file != "" && lines > 0) {
        printf "%s%s:%d-%d", separator, file, start, start + lines - 1
        separator = ","
      }
    }
  '
