# Changelog

All notable changes to Leeboard are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - Unreleased

First public release.

### Added

- A central store of small markdown entries (`~/.leeboard`, or `LEEBOARD_HOME`) in six
  kinds: rule, grant, hold, reference, handoff and request, scoped `global`, `machine` or
  `project:<name>`. One file per entry, written atomically, with an append-only change
  log and credential-like text rejected before anything is written.
- `lb` (also installed as `leeboard`): `init`, `add`, `hold`, `grant`, `handoff`,
  `request`, `release`, `ack`, `reply`, `close`, `revoke`, `supersede`, `revise`, `show`,
  `list`, `search`, and `project add|rename|remove|list`. Every command accepts `--json`.
- `lb --version` (alias `-v`) prints the installed package version.
- `lb brief`, a session-start orientation of at most 8,000 characters, and `lb delta`,
  what other sessions changed since this session's brief.
- `lb check --blocks <tag>`, a gate that exits 3 while an active hold blocks the tag.
- `lb purge <id>…` and `lb purge --closed [--days <n>]`: delete entries for good, on the
  owner's word, logging one `purged` line. Bosun and unattended runners cannot purge.
- `lb list` and `lb search` show active entries only; `--all` adds closed ones. A list
  filtered by `--session` or `--harness` still shows every status.
- Entries still active on disk past `until` are excluded from active list/search views
  and displayed as `lapsed` in all-status views and show (text/JSON).
  `lb list --status lapsed` selects them. This is display-only; reads change neither
  entries nor log, and Bosun still persists `expired`.
- `lb review`, the owner's digest of new, changed and closed entries, and `lb usage`, a
  count of observed brief and check calls with sample sizes.
- In-place revision of entries with archived previous versions, and a store-wide lock for
  revisions and lifecycle changes.
- Project resolution through the git main checkout (so worktrees share a project),
  registered paths and git remotes.
- Harness identities `claude-code`, `pi`, `helmraiser`, `funkyoctopus`, `bosun` and
  `user`, with restrictions for unattended runners: no holds or grants, and changes only
  to their own entries.
- Bosun, the librarian: a deterministic quick pass (`lb bosun`) and an LLM full pass
  (`lb bosun --full`, through `pi` or `claude -p`) that mirrors Claude Code memory notes,
  merges duplicates, re-scopes and tightens entries, and writes a report.
  `scripts/bosun-trial.mjs`, a scorer and a synthetic fixture (`trials/bosun/`) for
  comparing models.
- A systemd user timer for a daily Bosun pass that commits and pushes the store
  (`deploy/`).
- The `memory` and `catchup` agent skills (`skills/`).
