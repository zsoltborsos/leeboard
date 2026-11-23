# Leeboard

Shared, explicit memory and coordination board for coding agents (Claude Code, Pi,
FunkyOctopus, and unattended runners such as Helmraiser). One central store (`~/.leeboard`, a
private git repository) of small markdown entries — rules, grants, holds, references,
handoffs, requests — that every harness reads at session start (`lb brief`) and on demand
(`lb delta`). Bosun is the librarian that keeps it small and current.

**This is the doctrine file.** Vendor files (`CLAUDE.md`) hold harness rules only.

## Canonical references

Current state and next moves: [CURRENT_STATE.md](CURRENT_STATE.md) and [TASKS.md](TASKS.md).

- `docs/design.md` — the design: entry kinds, admission test, entry format, store layout,
  project resolution, CLI, delivery, harness integration, Bosun. Read the section
  covering what you change.
- `README.md` — install, store setup, harness integration, exit codes.

## Rules that bind every turn

- **The store is data, this repo is code.** Tests never touch `~/.leeboard`; they set
  `LEEBOARD_HOME` to a temporary directory.
- **Entries are one file each and written atomically** (temp file + rename in the same
  directory). Nothing rewrites another entry's file except a lifecycle command on it,
  and `lb purge`, which drops a purged id from other entries' `supersedes` lists.
- **`log.jsonl` is append-only.** One JSON object per line, each line under 4 KB.
- **Credential-like text is rejected before anything is persisted.**
- **`brief` and `delta` are on every session's hot path:** no network, no LLM, no
  subprocess other than `git` for project resolution; keep them well under 200 ms.
  `check` follows the same rule.
- **Empty output is correct output.** `delta` with nothing new prints nothing.
- **No speculative features.** Build what the current task in `TASKS.md` asks for.

## Build and test

```bash
npm ci
npm run build
npm test
npm run typecheck
```

Node ≥ 25, TypeScript (strict, ESM), Vitest. The CLI binary is `lb` (`dist/cli.js`),
also installed as `leeboard`.
