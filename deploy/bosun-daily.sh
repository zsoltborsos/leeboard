#!/usr/bin/env bash
# Daily Bosun pass (run by leeboard-bosun.timer), then commit and push the store so each
# day's changes are one reviewable commit.
#
# The LLM pass needs a runner and model, normally from ~/.config/leeboard/bosun.env:
#   LEEBOARD_BOSUN_RUNNER=pi|claude  LEEBOARD_BOSUN_MODEL=<id>  LEEBOARD_BOSUN_THINKING=<level>
# Without a model it runs only the deterministic quick pass.
set -euo pipefail

store="${LEEBOARD_HOME:-$HOME/.leeboard}"
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
lb=(node "$repo/dist/cli.js")

status=0
if [ -n "${LEEBOARD_BOSUN_MODEL:-}" ]; then
  "${lb[@]}" bosun --full --if-changed --runner "${LEEBOARD_BOSUN_RUNNER:-pi}" --model "$LEEBOARD_BOSUN_MODEL" \
    ${LEEBOARD_BOSUN_THINKING:+--thinking "$LEEBOARD_BOSUN_THINKING"} --timeout 30 || status=$?
else
  "${lb[@]}" bosun || status=$?
fi

# Commit whatever is in the store, including other sessions' entries, even after a failed
# pass: the store is the record, and the failed run's report sits in the git-ignored state/.
cd "$store"
git add -A
if ! git diff --cached --quiet; then
  git commit -q -m "Daily Bosun pass $(date -u +%Y-%m-%d)"
  git push -q
fi
exit "$status"
