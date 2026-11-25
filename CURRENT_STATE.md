# Leeboard — Current State

Leeboard 0.1.0 is feature-complete for its first public release and not yet tagged.

## What works

- **Store and entries.** Six entry kinds (rule, grant, hold, reference, handoff, request)
  in `global`, `machine` and `project:<name>` scopes, one atomically written markdown
  file each, with an append-only `log.jsonl`. Credential-like text is rejected before
  writing on every field a command writes. See `docs/design.md` sections 2–5.
- **CLI.** `lb` / `leeboard`: `init`, `add`, `hold`, `grant`, `handoff`, `request`,
  `release`, `ack`, `reply`, `close`, `revoke`, `supersede`, `revise`, `show`, `list`,
  `search`, `purge`, `brief`, `delta`, `check`, `review`, `usage`, `bosun`, and
  `project add|rename|remove|list`. Every command takes `--json`. `list` and `search` show
  active entries unless `--all` (an author-filtered `list` shows every status).
  Active views exclude lapsed entries; all-status views and `show` display them as
  `lapsed`, without changing the stored entry or log. Reads use the context clock;
  supersede chains ending at lapsed entries have no current replacement.
  `lb --version` / `lb -v` prints the installed package version.
- **Command modules.** Every command entry point owns its finished `RunResult` through
  a flags-object interface. `src/run.ts` retains parsing, help/version, identity and
  clock context, routing and thrown-error mapping. `src/result.ts` supplies `RunResult`,
  `result`, `ok` and `jsonLine`; command usage errors share `usageError` in `src/errors.ts`.
  Entry writes and `init` live in `src/commands/write.ts`, with one field mapping for
  creation and revision; projects live in `src/commands/project.ts`. Both modules load
  only on their routes, never for brief/delta/check. Bosun lazily loads its full-pass
  module only for `--full`. Review's enriched query is `reviewDetails`;
  purge's command remains separate from its store operation.
- **Revision.** `lb revise` changes an active entry in place and archives the previous
  version in `revisions/<id>.jsonl`. Revisions and lifecycle changes share a store-wide
  lock (`state/revision.lock`).
- **Purge.** `lb purge <id>…` and `lb purge --closed [--days <n>]` (default 30) delete
  entries for good, logging one body-free `purged` line; refused to Bosun and Helmraiser,
  and for ids an active entry still cites (`docs/design.md` section 4.1).
  `lb project remove <name>` unregisters a project with no entries left; `--path` drops
  stale paths.
- **Actor policy.** Permissions live in `src/policy.ts`; project rename, like purge
  and project remove, is refused to Bosun and Helmraiser before writes.
- **Delivery.** `brief` (at most 8,000 characters), `delta` and `check` are on the hot
  path: no network, no LLM, only `git` as a subprocess. `check` exits 3 for a blocking
  hold, and for an unparseable hold file in scope.
- **Harness integration.** Instructions plus the `memory` and `catchup` skills
  (`skills/`), and two Claude Code hooks documented in the README: a `compact`
  `SessionStart` re-brief and a `SubagentStart` brief injection. The `helmraiser` harness
  has the unattended-runner restrictions in `docs/design.md` section 4.2.
- **Bosun.** The quick pass (`lb bosun`) and the full pass (`lb bosun --full`, through
  `pi` or `claude -p`, with `--if-changed` to skip idle days) including the Claude memory
  mirror. `deploy/` has a systemd user timer that runs it daily and commits and pushes
  the store (`deploy/README.md`).
- **Trials.** `scripts/bosun-trial.mjs` and the scorer `src/bosun/score.ts` compare
  models on the synthetic fixture in `trials/bosun/` (80 entries, a mirror watermark, a
  `global` scope over budget; see its README). On 2026-11-23, 2 runs each:
  `pi:opencode-go/deepseek-v4.1-flash:high` 98.8 ± 1.8, missing
  the semantic duplicate once; `claude:claude-sonnet-5-5:high` 95.0, putting uncited
  lines in its report both times. Neither made a false retirement or an unasked change.

## Gates

```bash
npm run build && npm test && npm run test:future && npm run typecheck
```

Build, typecheck and all 1,617 tests pass after the command-module migration, including
cold-process checks of route-only module loading; the future-clock suite passes
(1,615 tests, 2 skipped). The router-shape and CLI smoke
acceptance checks also pass. `LEEBOARD_PERF=1 npm test` runs the opt-in timing tests;
they were not rerun for this refactor.
