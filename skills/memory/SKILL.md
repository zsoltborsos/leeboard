---
name: memory
description: "Write, change or look up Leeboard entries (`lb`): rules, grants, holds, references, handoffs, requests. Use when the user states a standing rule, preference, ownership or restriction ('remember', 'from now on', 'never', 'X owns Y', 'don't … until …'); when you learn an environment fact the next session will need; when work must pass to another session or agent; or before releasing, revoking or superseding an entry."
---

# Leeboard entries

Leeboard is the shared memory every agent session reads at start (`lb brief`). Each entry
costs every future session a line of attention, so an entry is a **standing order**:
short, actionable, owned, and ending somewhere.

## The admission test

Write an entry only when all three hold:

1. **It changes what an agent does**: a do/don't, who may act, when not to act, or where/how.
2. **It cannot be read from the repo or a tool when it is needed.** Code facts, module
   layout, config defaults and `--help` output stay where they are. Project plans,
   status and scheduled fixes go in the repo's `TASKS.md` / `CURRENT_STATE.md`.
3. **It has an author and an end condition**: until revoked, until a date, until an
   event, or consumed once.

An entry about a tool, service or project that no longer exists fails the first test.
When something is retired or renamed, change or remove the entries about it; don't add
one saying it is gone, and don't keep the old name in a source line or a "formerly".

When the user states something that passes, write it in the same turn and say so in one
line. When you infer something yourself, write it only if you would bet the next session
needs it.

## Kinds

| Kind | For | Command |
|---|---|---|
| rule | do / don't | `lb add rule --title "…" --body "…why…"` |
| grant | who may do what, ownership, working agreement | `lb grant --title "…" --holder <who>` |
| hold | don't do X while Y | `lb hold --title "…" --release "<when it ends>" --blocks <tags> [--until <date>]` |
| reference | where / how: servers, accounts, procedures, environment facts | `lb add reference --title "…" --body "…"` |
| handoff | work passing to whoever picks it up next | `lb handoff --title "…" --to <target> --body -` |
| request | a question or task for another agent or role | `lb request --title "…" --to <target> --body "…"` |

- **Title**: the instruction itself, readable alone in the brief ("Set pipefail before
  chaining tests into git commit"), not a topic ("Git notes").
- **Body**: the why, and the evidence, in a few lines. `--body -` reads stdin.
- **Hold tags** (`--blocks`): `push`, `merge`, `deploy`, `helmraiser-run`, the same tags
  agents check before acting. Helmraiser refuses to start runs under a `helmraiser-run` hold.
- **Targets** (`--to`): `project:<name>`, `session:<id>`, `harness:<name>` (`claude-code`, `pi`, `helmraiser`, `funkyoctopus`, `bosun`, `user`), `any`.

## Scope

The default is the project the working directory resolves to (global outside a
registered project). Choose deliberately:

- `--scope global`: true in every project (a working preference, a tool habit).
- `--scope machine`: true of this computer (its services, ports, hardware limits).
- `--scope project:<name>`: true of one project, including when you are writing from
  another project's directory.

## Identity and origin

Pass who you are on every write: `--harness claude-code --session "$CLAUDE_CODE_SESSION_ID"`,
or `--harness pi --session "$PI_SESSION_ID"`. Mark the user's own words with
`--origin user-stated`; the default `agent-inferred` is for your own conclusions. Bosun,
the librarian, resolves conflicts in favour of `user-stated`.

## Changing entries

Read before you change: `lb show <id>` (ids accept a unique prefix).

- Fix wording, scope or kind-specific fields in place: `lb revise <id> --title "…"`
  (or `--body`, `--scope`, `--until`, `--release`, `--blocks`, `--holder`, `--to`).
  The entry must be active; its id and attribution stay unchanged, and omitted fields
  stay as they were. Kind-specific field fixes do not change the entry's kind:
  `lb revise` cannot change kind or origin; do not pass `--origin`.
- A different entry replaces an older one, or several entries merge: write the new
  entry, then `lb supersede <old> --by <new>` for each replaced entry.
- Wrong with no replacement: `lb revoke <id> --reason "…"`.
- Noise that should not stay even as history (wrong, about something that no longer
  exists, clutter): `lb purge <id>`, only on the user's word. `lb purge --closed` clears
  entries closed over 30 days ago. Use `--dry-run` first; a purge cannot be undone.
- A hold's condition has ended: `lb release <id> --note "…"`, on the user's word or when
  the release condition is plainly met. A hold someone else placed is theirs to release
  unless the user says otherwise.
- A handoff you have taken up: `lb ack <id>`. A request: `lb reply <id> --body "…"`,
  then `lb close <id>` when it is settled.

## Looking things up

The brief lists titles. Read a body with `lb show <id>` when its title bears on the work.
`lb search <text>` and `lb list [--kind] [--scope] [--status]` find the rest (active
entries; `--all` adds closed history);
`lb delta` shows what other sessions changed since your brief.

Text that looks like a credential is refused (exit 2). Point to where a secret lives,
never the secret.
