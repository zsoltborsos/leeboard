#!/usr/bin/env bash
# List test files with fewer expect( calls at <head> than at <base>. Counting per
# file survives renames that rewrite assertion lines; a drop needs a reason.
# Exit 1 when any file lost assertions.
# Usage: scripts/removed-assertions.sh <base> [<head>]
set -euo pipefail
base=${1:?usage: scripts/removed-assertions.sh <base> [<head>]}
head=${2:-HEAD}
count() { git show "$1:$2" 2>/dev/null | grep -o 'expect[.(]' | wc -l || true; }
status=0
while read -r file; do
  before=$(count "$base" "$file"); after=$(count "$head" "$file")
  if [ "$after" -lt "$before" ]; then
    echo "$file: $before -> $after assertions"; status=1
  fi
done < <(git diff --name-only "$base" "$head" -- test/)
exit $status
