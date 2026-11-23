---
name: pipefail-before-commit
description: Set pipefail before chaining tests into a commit
metadata:
  type: feedback
---

Set `-o pipefail` before chaining tests into `git commit`.

**Why:** `npm test | tee log && git commit` committed with failing tests once; the pipe hid the exit code.
**How to apply:** any time a test command is piped and then chained with `&&`.
