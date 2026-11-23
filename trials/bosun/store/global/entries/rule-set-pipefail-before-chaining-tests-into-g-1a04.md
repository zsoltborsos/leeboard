---
id: rule-set-pipefail-before-chaining-tests-into-g-1a04
kind: rule
scope: global
status: active
title: Set -o pipefail before chaining tests into git commit
author:
  harness: bosun
  session: bosun-2026-10-30
  origin: mirrored
created: 2026-10-30T06:00:00Z
updated: 2026-10-30T06:00:00Z
---
Without it, `npm test | tee log && git commit` commits even when the tests fail.

Source: claude-memory -home-dev-src-blog/pipefail-before-commit.md
