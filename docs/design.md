# Leeboard design

Leeboard is a shared, explicit memory and coordination board for coding agents. One
central store of small markdown entries is read by every agent harness at session start
and on demand. The CLI is `lb` (also installed as `leeboard`). Bosun is the librarian
that keeps the store small and current.

This document describes the current design. [README.md](../README.md) covers installing
and wiring it up; `lb --help` lists every command and flag.

## 1. Goals and non-goals

Goals:

1. One store of explicit, actionable notes that every harness reads and writes the same
   way, so what one session learns reaches the next, whichever tool it runs in.
2. Coordination between parallel sessions: holds, grants, handoffs and requests.
3. Agents write freely. A librarian (Bosun) keeps the store small, current and consistent,
   and the owner reviews a short "what changed" digest instead of approving every write.
4. Every harness stays fully functional without Leeboard. Claude Code auto-memory stays
   on and is mirrored in, not replaced.

Non-goals:

- No transcript ingestion, extraction pipeline, embeddings or per-turn recall.
- No project plans or status. Those live in each repository's `TASKS.md` and
  `CURRENT_STATE.md` (section 9).
- No code facts: anything an agent can read from the repository when it needs it.
- No real-time coordination of agents editing the same files. Worktrees and ownership
  grants cover that.

## 2. What earns an entry

An entry must pass all three:

1. **It changes what an agent does**: a do/don't, who may act, when not to act, or
   where/how.
2. **It cannot be read from the repository or a tool at the moment it is needed.** Code
   facts, module layout, config defaults and `--help` output stay where they are.
3. **It has an author and an end condition**: until revoked, until a date, until an
   event, or consumed once.

A defect whose fix is scheduled belongs in `TASKS.md` or a handoff, not in the store.

Every active entry costs every future session a line of attention, which is why the test
is strict and why Bosun enforces a line budget (section 10).

## 3. Entry kinds, scopes and targets

| Kind | Meaning | Ends when | Example |
|---|---|---|---|
| `rule` | Do / don't | Revoked or superseded | Set `-o pipefail` before chaining tests into `git commit` |
| `grant` | Who may do what; ownership; working agreement | Revoked or reassigned | `api-reviewer` owns review and merge for the `api` repository |
| `hold` | Don't do X while Y | Released, or `until` passes | No deploys while the database migration runs |
| `reference` | Where / how; environment and ops facts | Superseded; verified on use | Staging is reached through the VPN host in `~/.ssh/config` |
| `handoff` | One session passes work to whoever picks it up next | Acknowledged (consumed once) | Continue the checkout refactor from branch X; tests red in Y |
| `request` | Addressed to an agent or role; needs a reply | Replied to and closed | Review the diff on branch Z with fresh context |

**Scopes.** `global` applies everywhere, `machine` applies to this computer, and
`project:<name>` applies to one registered project. `machine` stays separate from
`global` so that facts about one computer do not become rules for another.

**Targets.** Handoffs and requests carry `to:`. A target is `project:<name>`,
`session:<id>`, `harness:<name>` or `any`.

**Statuses.** `active`, `released`, `revoked`, `superseded`, `done`, `retired`, `expired`.
An entry is *active* when its status is `active` and its `until`, if any, has not passed.
A date-only `until` runs to the end of that UTC day. No command sets `retired`; it is
accepted when a file is read. An entry still stored as `active` past its `until` displays
as `lapsed` until Bosun writes `expired`. `lapsed` is display-only, never a stored status.

## 4. Entry file

One markdown file per entry, so concurrent writers never touch the same file.

```markdown
---
id: rule-set-pipefail-before-chaining-tests-into-7f3a
kind: rule
scope: global
status: active
title: Set pipefail before chaining tests into git commit
author:
  harness: claude-code
  session: d58c4a89-0000-0000-0000-000000000000
  origin: user-stated
created: 2026-10-17T14:02:11Z
updated: 2026-10-17T14:02:11Z
---
`tail` returns its own status, so `npm test | tail && git commit` commits on red.
Use `set -o pipefail` (or check the test exit code) before committing.
```

Required: `id`, `kind`, `scope`, `status`, `title`, `created`, `updated`. Optional, by kind:

| Field | Used by | Meaning |
|---|---|---|
| `until` | hold, handoff | ISO date or date-time after which the entry stops being active |
| `release` | hold (required) | When the hold ends, in words |
| `blocks` | hold | Action tags a gate checks, for example `[push, deploy]` |
| `holder` | grant (required) | Who holds the grant |
| `to` | handoff, request (required) | Target (section 3) |
| `supersedes` | any | Ids this entry replaces |

Ids are `<kind>-<slug of the title, up to 40 characters>-<4 hex digits>`. The kind prefix
lets a scan select files by name alone. Every command accepts a unique prefix of an id,
or its four-character hash when no id starts with it.

`author.harness` is one of `claude-code`, `pi`, `helmraiser`, `funkyoctopus`, `bosun`,
`user`, or null. `author.origin` is `user-stated` (the owner's own words),
`agent-inferred` (the default) or `mirrored` (copied from a Claude memory note that is
not the owner's words). `user-stated` wins over `agent-inferred` when entries conflict.

The body is the note plus the why, a few lines. Lifecycle commands append dated,
attributed sections to it: `## Released (…)`, `## Reply (…)`, `## Revoked (…)`,
`## Expired (…)`.

**Writes** are atomic: a temp file in the same directory, then a rename. New entries are
linked into place without overwriting, so an id collision retries with a new suffix.
Nothing rewrites another entry's file except a lifecycle command on that entry.

**Credentials are rejected before anything is written** (exit 2). The check covers the
kind, scope, title, body, release, holder, target, blocks and until fields, and the text
of a reply, revoke reason or release note. Four patterns: provider-style tokens (`ghp_`,
`github_pat_`, `sk-`, `gsk_`, `hf_` prefixes), PEM private-key headers, URLs with an
embedded `user:password@`, and `Bearer` tokens. The error names the field, never the
value. Point to where a secret lives instead of writing it.

### 4.1 Lifecycle

| Command | Applies to | Result |
|---|---|---|
| `lb release <id> [--note]` | hold | status `released`; the note is appended |
| `lb ack <id>` | handoff | status `done` |
| `lb reply <id> --body` | request | appends a `Reply` section; stays active |
| `lb close <id>` | request | status `done` |
| `lb revoke <id> --reason` | any | status `revoked`; the reason is appended |
| `lb supersede <old> --by <new>` | any | old becomes `superseded`; new gains `supersedes: [old]` |
| `lb revise <id> …` | any | wording, scope or kind fields change in place; the id stays |
| Bosun expiry | hold, handoff | status `expired` once `until` has passed |
| `lb purge <id>…` / `lb purge --closed [--days <n>]` | any status | the entry is deleted (see Purge) |

Each applies only to an active entry; otherwise it exits 5. Purge is the exception.


**Revise.** `lb revise` changes the title, body, scope, `until`, `release`, `blocks`,
`holder` or `to` of an active entry. It needs at least one of these (exit 1 otherwise).
Omitted fields stay as they were. An empty body or block list clears that field; an empty
title or a missing required field is invalid. It keeps the id, kind, origin, author,
creation time and supersedes links. It refuses `--kind`, `--origin` and
`--status`. Merges and genuine replacements use supersede instead.

Each revision appends `{ts, harness, session, before}` to `revisions/<id>.jsonl`, where
`before` holds the previous mutable fields. The entry is then rewritten; a scope move
writes the new file before removing the old one. A body-free `revised` event goes to the
log with the history record's byte offset and the changed fields. `lb review` reads the
history; `brief` and `delta` never do.

**Locking.** Revisions, lifecycle changes, supersede, expiry and project rename share one
store-wide lock, the directory `state/revision.lock`, with an `owner.json` holding its
acquisition time. A waiter recovers a lock older than ten seconds and gives up after
fifteen seconds without changing anything. Process liveness is not used, because
sandboxed agents may live in another PID namespace. Creating an entry takes no lock, so a
busy lock never stops an agent adding one. Reads never lock.

**Superseded chains.** `lb show` on a superseded entry prints the successors and, if the
live replacement is further along the chain, `Current: <id>`. Current means live at the
caller's context clock, not merely stored as active. A direct or multihop chain ending
at a lapsed entry has `current: null` and a `chainEnd` with status `lapsed`; show prints
`Current: none — chain ends at <id> (lapsed)`. Other chains ending without a live entry
also say so. `lb delta` and `lb review` suffix superseded lines with ` → <current id>`,
falling back to the direct successor when there is no current replacement. The chain is
resolved at read time from the `supersedes` links across all scopes, cycle-safe, and
never stored; neither is the display-only `lapsed` status. JSON output for superseded
entries gains `supersededBy`; `show` also has `current` and `chainEnd`.

**Purge.** Closed entries are history, and history turns into noise: an entry about a
tool that no longer exists, or a closed entry that turns up in a search, only costs the
next agent attention. `lb purge <id>…` deletes entries for good, whatever their status;
`lb purge --closed` deletes every entry closed more than 30 days ago (`--days` changes
that; it counts from the entry's last change). The entry file and its
`revisions/<id>.jsonl` go, other entries' `supersedes` lists drop the id, and the log
gains one body-free `purged` line, so the deletion itself stays on record. The store's
git history still holds the text; nothing reads it. An id that an active entry still
cites in its title or body is refused by `lb purge <id>` (exit 5: revise the citing entry
first) and kept by `--closed`, which names it. `--dry-run` lists what would go. Purge
runs on the owner's word: Bosun and unattended runners may not purge (exit 6), so the
agents that write freely still never delete.

### 4.2 Who may change what

| Actor | Restriction |
|---|---|
| Unattended runner (`helmraiser`) | Cannot purge, remove projects or rename projects (exit 6). Cannot create a hold or grant (exit 6). Cannot release, revoke, supersede or revise a hold or grant. May revoke, supersede or revise another entry only if its own session wrote it. May write handoffs and requests, ack, reply and close. |
| Bosun | Cannot revoke a `user-stated` entry (exit 6). It may revise or supersede one while preserving the owner's meaning, or flag it in its report. Cannot purge, remove projects or rename projects (exit 6). |
| Everyone else | None beyond the entry's own state (section 4.1). |

Actor permissions are implemented in [`src/policy.ts`](../src/policy.ts).
Unattended workers run without a person to check a hold or grant, so they do not place
them. An interactive session or the owner does.

## 5. Store

A central store outside every project repository, versioned as its own private git
repository. In-repo files were rejected because holds and grants are live state (a hold
placed in one checkout would not reach another worktree until merged), because client
repositories should not carry coordination notes, and because many parallel sessions
committing notes would flood every repository's history.

The store location is `~/.leeboard`, or `$LEEBOARD_HOME`.

```
~/.leeboard/
  global/entries/<id>.md
  machine/entries/<id>.md
  projects/<name>/
    project.md                  registry: paths, git remotes
    entries/<id>.md
  log.jsonl                     append-only change log
  revisions/<id>.jsonl          previous versions; created on first revision
  state/                        local, git-ignored (see below)
  .gitignore                    contains `state/`
```

`lb init` creates the directories, an empty `log.jsonl` and the `.gitignore`. It is safe
to repeat and never overwrites. It does not run `git init`: making the store a private
repository with a remote is the owner's step (README).

**`log.jsonl`** is append-only: one JSON object per line, each under 4 KB, with no
bodies: `{ts, id, kind, scope, event, status, harness, session}` plus, for a revision, the
history offset and changed fields. `event` is `created`, `updated`, `status` or `revised`.
The log drives `lb delta`, `lb review` and Bosun's idle-day check. A corrupt line is
skipped without hiding later ones.

**`state/`** holds what is local to one computer and never committed: per-session cursors
(`state/cursors/<session>.json`, a byte offset into the log), the owner's review cursor
(`state/review.json`), the usage log (`state/usage.jsonl`), the revision lock, and Bosun's
run records and watermarks (`state/bosun/`).

## 6. Project resolution

A command resolves its working directory to at most one registered project, which
decides the project scope it reads and the default scope it writes.

1. Find the git repository containing the directory and its main checkout, using
   `git rev-parse --git-common-dir`, so every worktree of a repository resolves to the
   same project.
2. If the main checkout equals a registered path, that project wins.
3. Otherwise the longest registered path that contains the directory or the main
   checkout wins. A registered folder of repositories and notes therefore covers
   everything under it.
4. Otherwise, if any project has registered remotes, the repository's `origin` is
   normalised (scheme, credentials and `.git` stripped, lowercased) and compared with
   them.
5. Outside git, only the longest registered path containing the directory counts.

No match means only `global` and `machine` apply. Unknown repositories are never
registered automatically: the brief says the repository is unregistered and prints the
`lb project add` command.

`lb project add <name> --path <dir> [--remote url]…` registers a project or
adds paths and remotes to an existing one (`--path` is required every time).
`lb project rename <old> <new> [--path <dir>]` renames the project folder, rewrites `scope: project:<old>` and
`to: project:<old>` on every entry whatever its status, and makes `--path` the first
path. Ids, bodies and timestamps do not change. It is safe to run again after an
interruption. Bosun and Helmraiser may not run rename (exit 6, before any writes).
`lb project remove <name>` deletes the project folder from the registry; it
is refused while any entry, of any status, is scoped to the project or an active entry is
addressed to it, so purge or move those first. With `--path <dir>`… it drops only those
paths and keeps at least one. Like purge, it is the owner's call: Bosun and Helmraiser
may not run it.

## 7. CLI

Internally, command entry points follow `<name>Command(ctx, [positionals,] flags)` and
return their finished `RunResult` (exit code, stdout and stderr), with `json` in the
required flags object. Read-only entry views take `ReadCtx`; commands needing no
identity (`init`, `usage`) take `home`. A lazy context thunk is used only where flags
or arguments must be validated before identity (`add`, `revise`, `purge`, project
rename/remove, and Bosun's full-pass flags). The project context also carries `home` so
add/list remain identity-free; Bosun carries the startup environment and cwd for its full pass. `src/run.ts` retains
option parsing, shared usage text, identity and clock context, routing, help/version,
and thrown-error mapping. Entry writes and `init` live in `src/commands/write.ts`;
creation and revision share one flag-to-field mapping, and creation aliases use the
same create command with their kind. Write and project command modules load
only on their respective routes, not on the brief/delta/check hot path. Bosun's command
loads its full-pass module lazily, only for `--full`, keeping runner code off that path.
`src/result.ts` supplies `RunResult`, `result(code, stdout)`, `ok(stdout)` and
`jsonLine(data)`. Shared `usageError(message)` in `src/errors.ts` constructs usage
errors. Purge's command and help description live in `src/commands/purge.ts`;
`src/purge.ts` owns the store operation.
`reviewDetails` returns successor-enriched data; brief's digest keeps using lightweight `review()`.
Delta only builds a successor index when included superseded items need it.

Every command accepts `--json`. Identity comes from flags or environment:
`--harness` / `LEEBOARD_HARNESS`, `--session` / `LEEBOARD_SESSION`, and `--origin`
(`user-stated`, `agent-inferred` by default, `mirrored`). A session id may be up to 128
characters. With no harness or session from either, Leeboard takes the session id the
harness sets for its agents: `CLAUDE_CODE_SESSION_ID` as `claude-code`, `PI_SESSION_ID`
as `pi`. It also fills the session when only that matching harness was given, and guesses
nothing when both variables are set. `--cwd <dir>` overrides the working directory.

`--version` / `-v` prints the installed package version and exits successfully without
requiring a command. It takes precedence over a supplied command and remains plain text
with `--json`. If `--help` is also supplied, help takes precedence.

```
lb --version, -v                 installed package version
lb init
lb brief   [--cwd]               session-start orientation
lb delta   [--cwd]               entries changed since this session's cursor
lb check   --blocks <tag> [--cwd]  exit 3 if an active hold blocks the tag
lb review  [--peek]              owner digest of changes; marks it seen unless --peek
lb usage   [--since <ISO date>]  observed brief and check usage

lb add <rule|reference|grant|hold|handoff|request> --title <t> [--body <text>|-] [--scope <s>]
lb hold    --title <t> --release <text> [--blocks a,b] [--until <date>]
lb grant   --title <t> --holder <who>
lb handoff --title <t> --to <target> [--body <text>|-]
lb request --title <t> --to <target> [--body <text>|-]
lb release <id> [--note]     lb ack <id>     lb close <id>
lb reply <id> --body <text>|-     lb revoke <id> --reason <text>
lb revise <id> [--title] [--body] [--scope] [--until] [--release] [--blocks] [--holder] [--to]
lb supersede <old-id> --by <new-id>

lb show <id>
lb list [--kind] [--scope] [--status|--all] [--session] [--harness]
lb search <text> [--all]
lb purge <id>... [--dry-run]     lb purge --closed [--days <n>] [--dry-run]

lb project add|rename|remove|list
lb bosun [--quick] [--dry-run]
lb bosun --full --runner <pi|claude> --model <id> [--thinking <level>]
         [--memory-root <dir>] [--timeout <minutes>] [--if-changed]
```

`--body -` reads the body from standard input. A new entry's scope defaults to the
resolved project, else `global`. `lb search` is a case-insensitive substring match over
titles and bodies, across all scopes. `lb list` and `lb search` show active entries only;
`--all` adds closed and lapsed ones. Active views exclude lapsed entries;
`lb list --status lapsed` selects exactly those entries. `lb show` reports `lapsed` in
both text and JSON. These reads never expire entries or write the store or log.
A list filtered by author (`--session`, `--harness`) shows every status unless
`--status` is given, since it answers "what did this run write".

**Exit codes.** 0 success, 1 usage error, 2 credential rejected, 3 `check` blocked, 4
unknown or ambiguous id, 5 disallowed transition, 6 not permitted.

### 7.1 `lb check`

`lb check --blocks <tag>` reads only hold-prefixed files in the scopes covering the
directory (global, machine and the current project, when registered). It exits 3 and
prints one line per active hold whose `blocks` include the tag. Tags are free strings;
`push`, `merge` and `deploy` are the convention, and a runner may use its own, such as
`helmraiser-run`.

An unreadable file whose name begins `hold-` in those scopes blocks every tag with exit 3
and is named in the output: fix or remove the file. Unreadable non-hold files do not
block. With `--json` the output is always an array: blocking holds first, then one
synthetic hold per unreadable file, with `id`, `kind: "hold"`, a `title` that names the
path and the parse error, `release: "fix or remove this file"` and `unreadable: true`.

`check` needs no identity. It records a usage line (section 11).

### 7.2 `lb delta` and `lb review`

`lb delta` prints entries changed since this session's cursor that apply to the directory:
scopes in play, or handoffs and requests addressed to the project, session or harness. It
skips the session's own changes and keeps the latest event per entry. It needs a session
id; the first call with a new id sets the cursor to the end of the log and prints
nothing. With nothing new it prints nothing.

`lb review` is the owner's view: everything new, changed or closed across the whole store
since the owner last looked, with who created it (new entries) or who made the latest
change (changed and closed ones), its origin, and what a revision
changed. It moves the owner's cursor unless `--peek` is given.

## 8. Delivery to harnesses

Leeboard injects nothing per turn. It loads a small, high-signal index up front and lets
the agent fetch anything else when it judges it useful.

| Moment | What the agent gets | Triggered by |
|---|---|---|
| Session start, after `/clear`, after compaction | The **brief** | An instruction in the shared agent instructions, or a hook |
| Before a guarded action (push, merge, deploy, queueing unattended work) | Nothing unless an active hold blocks it | The instruction to run `lb check --blocks <tag>` |
| Whenever the agent judges it useful | Full entry text, search, what changed since its brief | `lb show`, `lb search`, `lb delta` |
| Learning something that passes the admission test | A new entry | The agent, guided by the `memory` skill |

**The brief** is Markdown of at most 8,000 characters. It names the project (or says none
is registered, with the registration command) and lists active entries as one line each
with ids: holds first (a hold untouched for seven days is marked), then grants, rules and
references, then the inbox of handoffs and requests addressed to this project, session,
harness or `any`. Then it points at `TASKS.md` and `CURRENT_STATE.md` in the repository,
with the date each was last committed and the number of commits since. In sessions of
`claude-code`, `pi`, `funkyoctopus` or `user` it adds one line when the owner has
unreviewed changes. If entry files cannot be parsed it ends with a count and the pointer
`lb bosun --quick`. When the text is too long the longest section is trimmed and ends
with `… N more — lb list`; the unreadable-files warning is always kept.

A brief with a session id moves that session's `delta` cursor to the end of the log.
Passing no session id (as a sub-agent brief should) leaves every cursor alone.

**Hot path.** `brief`, `delta` and `check` make no network call, no LLM call, and run no
subprocess except `git` for project resolution. They should answer well under 200 ms.
There is no daemon.

**Accepted trade-off.** A hold placed by another session after your brief is not pushed
to you. You meet it when you run `lb check` before the guarded action, or at your next
brief. Holds are about actions, and the check sits at action time. Holds are advisory in
interactive sessions; an unattended runner that gates on `lb check` makes them binding
for its own queue.

## 9. Harness integration

### 9.1 Instructions and skills

The base integration needs no harness code:

- **Shared agent instructions** (`AGENTS.md`, `CLAUDE.md` or equivalent): run `lb brief`
  at session start and after `/clear`, and after compaction only if no brief was
  injected; run `lb check --blocks <tag>` before a push, merge, deploy or queueing
  unattended work; pass the harness and session id. README has a ready-to-paste section.
- **Skill `memory`** (`skills/memory`): the admission test, which kind to write, scopes,
  and how to release, ack, reply, revoke, supersede and revise.
- **Skill `catchup`** (`skills/catchup`): answers "what next?" from `TASKS.md` and
  `CURRENT_STATE.md`, cross-checked against git history, the inbox and active holds.

### 9.2 Claude Code hooks

Instructions alone are skipped most often at two moments, so Claude Code gets two hooks
(README has the commands):

- A `SessionStart` hook with matcher `compact` runs `lb brief` after every compaction,
  with the session id and directory from the hook's input.
- A `SubagentStart` hook runs `lb brief` **without** a session id and injects the output
  as `additionalContext`, telling the sub-agent not to run the brief itself. Without
  this, sub-agents rarely briefed, and those that did reused the parent's session id and
  moved the parent's `delta` cursor.

### 9.3 Unattended runners

Helmraiser, a sibling project that runs tasks unattended over `pi`, is the one place
where delivery can be deterministic, because the runner, not the agent, decides what the
agent sees. A runner integrates directly:

1. **Gate.** Run `lb check --blocks <tag> --cwd <worktree>` before dispatch. Exit 3 means
   skip the task until the hold is released.
2. **Brief.** Run `lb brief --cwd <worktree>` in the runner process and render it into the
   worker's directive, so the worker does not run it again.
3. **Identity.** Set `LEEBOARD_HARNESS=helmraiser` and `LEEBOARD_SESSION=<run id>`. The
   restrictions in section 4.2 apply.
4. **Review.** `lb list --session <run id>` lists the entries a run created.

A runner's own `lb` reads should not carry the worker's session id, so they write no
cursor.

### 9.4 FunkyOctopus

FunkyOctopus, a sibling agent shell, is a thin consumer: it shows the brief, inbox and
review digest by calling the CLI. It owns no memory of its own, and its embedded sessions
get the same instructions as any other.

### 9.5 Claude Code auto-memory

Auto-memory stays on. Bosun's full pass mirrors the memory notes in (section 10.3).
Nothing writes back into Claude's memory directory.

## 10. Bosun, the librarian

Agents write freely; Bosun keeps that safe. It never deletes: every change is a status
change or a revision, logged, with previous versions kept in `revisions/` and the store's
git history. Deleting is the owner's `lb purge` (section 4.1).

### 10.1 Quick pass

`lb bosun` is deterministic, reads the whole store, and uses no LLM. It reports:

- **Expired**: active holds and handoffs past `until` become `expired`.
- **Dead references**: active references naming an absolute or `~/` path that does not
  exist. A path is checked only if the reference is machine-scoped, or the path is under
  the home directory or a registered project path; paths on other hosts and API routes
  are not "missing".
- **Stale entry references**: an active entry's body cites an id that is superseded,
  revoked or missing. It names the current replacement where one exists. Self-citations,
  ids in the entry's own `supersedes` and naturally ended targets are ignored.
- **Exact duplicates**: same scope and the same title after lowercasing and removing
  punctuation and extra whitespace.
- **Stale holds**: holds untouched for seven days or more.
- **Unreadable files**: path, scope and parse error. Report only; nothing is repaired,
  expired or logged for a failed file.

Only expiry changes the store. `--dry-run` shows what would expire. Other findings are
for the owner, or for the full pass.

The quick pass does not run on its own: active views simply ignore lapsed entries;
list/search all-status views and show display them as `lapsed`. Run the quick pass
from the daily job (`deploy/README.md`) or by hand to persist `expired`.

### 10.2 Full pass

`lb bosun --full --runner <pi|claude> --model <id>` runs an LLM agent as harness `bosun`
(session = the run id), with `bosun/prompt.md` as its instructions plus a context block.
`--thinking <level>` sets reasoning effort (pi: `off`, `minimal`, `low`, `medium`,
`high`, `xhigh`, `max`; claude: `low` to `max`), `--timeout <minutes>` defaults to 30,
`--memory-root <dir>` defaults to `~/.claude/projects`. It cannot be combined with
`--quick` or `--dry-run`.

The agent works in the store directory and changes it only through `lb`, with two tools
(bash and read). The prompt tells it to change only what is defective, to retire only
what fails the admission test, to leave anything it doubts alone and list it, and to end
with a report in fixed sections. In order:

1. **Mirror** new, changed and deleted Claude memory notes (section 10.3).
2. **Consolidate**: merge near-duplicates into one survivor with a `supersedes` link;
   resolve contradictions only when recency and authorship decide cleanly (`user-stated`
   beats `agent-inferred`), otherwise list them for the owner.
3. **Tighten and re-scope**: `lb revise` fixes topic-style titles and misplaced scopes
   in place; entries failing the admission test are revoked (`agent-inferred`,
   `mirrored`) or flagged (`user-stated`).
4. **Budget**: each scope's index (active rules, grants, holds and references) stays
   within 40 lines, folding or retiring the weakest agent-written entries first. A
   `user-stated` entry is never retired for budget.
5. **Report**: Mirrored, Merged, Re-scoped, Tightened, Retired, Contradictions for the
   owner, Left alone with doubt; each line cites ids. The owner sees the changes in
   `lb review`.

Runner specifics:

| Runner | Command | Notes |
|---|---|---|
| `pi` | `pi -p --mode json --no-session --no-context-files --no-skills --no-extensions --tools bash,read` | The prompt is passed as a file |
| `claude` | `claude -p --output-format stream-json --permission-mode bypassPermissions --tools Bash,Read --no-session-persistence` | `ANTHROPIC_API_KEY` is removed so the login is used; `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` stops the run writing memory notes it would mirror next time; the prompt must be under 120,000 bytes |

Each run writes `state/bosun/<run id>/` with `prompt.md`, `transcript.jsonl`,
`stderr.log`, `report.md` (when the agent produced a final message) and `run.json`
(runner, requested and reported model, usage, cost, wall time, outcome, counts). A run is
*clean* when the process exited 0 without timing out, the stream reported no error, and a
final message exists. An unclean run exits 1. `lb bosun --full --json` prints the run
record, quick report and change counts.

`--if-changed` skips the agent (exit 0, quick pass still runs) unless there has never
been a clean full pass, a memory note is new, changed or deleted, or a session other than
Bosun changed an entry since the last clean pass. This makes an idle day cost nothing.

### 10.3 The Claude memory mirror

Claude Code auto-memory keeps notes under `<memory root>/<encoded-project-dir>/memory/*.md`
(`MEMORY.md` and dotfiles are ignored). Before each full pass Bosun hashes every note
(SHA-256) and compares with a watermark in `state/bosun/mirror.json`. The prompt receives
new and changed notes (capped at 4 KB each), the deleted ones, and the list of revoked
entries so a note that outlived a deliberate revocation does not bring the entry back.

For each note the agent decides: already represented, new entry, update (new entry plus
supersede), skip (fails the admission test), or skip as revoked. An entry written from a
note ends its body with `Source: claude-memory <encoded-dir>/<file>`, takes a scope by
content rather than by where the note was written, and uses origin `user-stated` only when
the note records the owner's own words, otherwise `mirrored`.

The watermark advances only after a clean run, so a failed run's input is offered again.
A memory root that does not exist is an error, not an empty root.

### 10.4 Trials

`scripts/bosun-trial.mjs` runs `lb bosun --full` for each runner/model against a fresh
copy of a fixture and scores the result with `src/bosun/score.ts`. A fixture directory
holds `store/`, `memory/` and `expected.json`; the scorer checks protected entries,
duplicate merges, decidable and undecidable contradictions, re-scoping, retirements,
flags, tightened titles, stale entry references, mirroring (including deleted notes),
the line budget and the report format, and penalises false retirements and
changes nobody asked for. The script aborts if Bosun writes to the real store.

The shipped fixture is `trials/bosun/` (the script's default `--fixture`): a made-up
store of 80 entries in two invented projects, a mirror watermark, and seven memory notes.
It has a case for every key in `expected.json`, a `global` scope over the line budget,
bystander entries that measure churn, and a dead-path reference that must not be
retired. `trials/bosun/README.md` lists the cases and how to
run a trial; results go to `trials/bosun/results/`, which git ignores. The trial tests
run the fixture through a fake runner, where the ideal changes score 100.

## 11. Owner review and measurement

**Review.** Nothing waits on review. Interactive briefs carry one line when something is
new since the owner last looked; `lb review` lists it with ids. The owner replies in
plain words ("drop 3, fix 5") and the agent applies it.

**Measurement.** There is no "was this helpful?" prompt. `lb brief` and `lb check` each
append one record (time, harness, session, project, directory, and entry count and size
or tag and outcome) to `state/usage.jsonl`. The write is best-effort and never changes
the command's output or exit code; a record containing credential-like text is dropped.
`lb usage [--since <ISO date or timestamp>]` reports, for brief and check separately:
calls, distinct sessions, anonymous calls (no session id), sessions by harness, calls by
project or by tag, and for checks how many blocked. Every figure carries its sample size
`n`, and a sample under 10 is marked.

The usage log alone cannot show compliance, because it has no denominator: it counts
sessions that briefed, not sessions that started. Compare it with the harness's own
session records for that.

## 12. Decisions

1. `machine` scope stays separate from `global`.
2. The store's git repository pushes to a private remote.
3. A hold untouched for seven days is flagged.
4. No per-turn injection, no plugin, no extension. Session-start and pre-action steps are
   instruction-driven and measured, with hooks only where measurement showed an agent
   skipping a step (after compaction, and at sub-agent start).
5. The line budget is 40 index lines per scope. Revisit when a scope passes about 35.
6. Bosun may revise or supersede an owner's entry but never revoke it.
