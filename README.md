<picture><source media="(prefers-color-scheme: dark)" srcset="docs/brand/leeboard-lockup-dark.svg"><img src="docs/brand/leeboard-lockup.svg" alt="Leeboard" height="64"></picture>

Your agents share one memory. They stay on course.

Leeboard is a shared, explicit memory and coordination board for coding agents. It keeps
one central store of small markdown entries: rules, grants, holds, references,
handoffs and requests. Every agent harness (Claude Code, Pi, unattended runners, your
own tools) reads the store at session start with `lb brief` and again on demand with
`lb delta`. What one session learns, the next one knows, whichever tool it runs in. A
librarian, Bosun, keeps the store small and current.

- **Explicit, not extracted.** Entries are short instructions an agent or the owner (you,
  the person whose store it is) wrote on purpose. There is no transcript mining, embedding or per-turn recall.
- **Small on purpose.** An entry must change what an agent does, be unreadable from the
  repo at the moment it is needed, and have an end condition. The brief lists one line per
  entry and stays under 8,000 characters.
- **Coordination, not just memory.** A hold ("no deploys while the migration runs") can
  block an action: gates run `lb check --blocks deploy` and stop on exit 3.
- **Plain files.** One markdown file per entry, in a git repository you own. Nothing
  leaves your machine unless you push the store to a remote or run `lb bosun --full`,
  which sends entries and Claude Code memory notes to your model provider.

The command is `lb`; it is also installed as `leeboard`. TypeScript, Node 26 or later,
MIT licence. See [CHANGELOG.md](CHANGELOG.md) for what is in each release.

## Entry kinds

| Kind | For | Ends when |
|---|---|---|
| `rule` | Do / don't | Revoked or superseded |
| `grant` | Who may do what; ownership | Revoked or reassigned |
| `hold` | Don't do X while Y | Released, or `until` passes |
| `reference` | Where / how; environment facts | Superseded |
| `handoff` | Work passing to the next session | Acknowledged |
| `request` | A question or task for another agent | Replied to and closed |

Scopes are `global`, `machine` (this computer) and `project:<name>`. The full design,
including the admission test, the file format and Bosun, is in
[docs/design.md](docs/design.md).

## Install

You need Node 26 or later and git.

```bash
git clone https://github.com/zsoltborsos/leeboard.git
cd leeboard
npm ci
npm run build
```

Put the built CLI on your `PATH`, as `lb` and as `leeboard` (`~/.local/bin` must be on
your `PATH`; it is not by default on macOS and some Linux distributions):

```bash
mkdir -p ~/.local/bin
ln -s "$PWD/dist/cli.js" ~/.local/bin/lb
ln -s "$PWD/dist/cli.js" ~/.local/bin/leeboard
lb --help
```

Rebuild with `npm run build` after pulling changes; the links point into `dist/`.

**The name `lb` is taken elsewhere.** Debian and Ubuntu's live-build installs
`/usr/bin/lb`, and the old npm package `loopback-cli` also installs an `lb`. If another
`lb` comes first on your `PATH`, run `leeboard` instead, or choose another alias such as
`alias lbd=leeboard`. Everything below writes `lb`; substitute your name, and use the same
one in hooks and agent instructions.

## Create the store

The store lives in `~/.leeboard`. Set `LEEBOARD_HOME` to use another directory.

```bash
lb init
cd ~/.leeboard
git init -b main
git add -A
git commit -m "Initial store"
git remote add origin <your-private-remote>
git push -u origin main
```

`lb init` creates the layout and a `.gitignore` that keeps per-computer state (`state/`)
out of git. It does not run git for you.

**Keep the remote private.** The store holds instructions your agents will follow, plus
whatever context you put in entries. Anyone who can write to it can steer your agents, so
treat its remote like credentials. Leeboard rejects text that looks like a secret before
writing it (exit 2), but that is a backstop: never put secrets in entries, only where they
live.

## Register projects

A project is a name plus the directories (and optionally git remotes) it covers. Register
each repository you want project-scoped entries for:

```bash
lb project add webshop --path ~/code/webshop
lb project add api --path ~/code/api --remote git@example.com:acme/api.git
lb project list
```

A directory resolves to a project through its git repository's main checkout, so every
worktree of `webshop` counts as `webshop`. A repository that matches nothing is never
registered automatically; the brief tells you so and prints the command. Use
`lb project rename <old> <new>` to rename one, `lb project remove <name>` to drop one
with no entries left (or `--path <dir>` to drop a stale path), and see
[docs/design.md](docs/design.md#6-project-resolution) for the matching rules.

## Daily use

```bash
# A standing rule, in the user's words ($SESSION_ID: your harness's session id,
# e.g. $CLAUDE_CODE_SESSION_ID in Claude Code)
lb add rule --title "Set pipefail before chaining tests into git commit" \
  --body "tail returns its own status, so a red test run still commits." \
  --origin user-stated --harness claude-code --session "$SESSION_ID"

# A hold that blocks deploys until the migration is done
lb hold --title "No deploys while the schema migration runs" \
  --release "Migration finished, or the owner says so" --blocks deploy --scope project:webshop

# A gate: exit 3 if an active hold blocks the tag
lb check --blocks deploy --cwd ~/code/webshop || echo "blocked"

# Pass work to the next session
lb handoff --title "Continue the checkout refactor" --to project:webshop --body - <<'EOF'
Branch checkout-refactor; payment step done, tests red in the cart module.
EOF

lb brief --cwd ~/code/webshop     # what a session sees at start
lb show <id>                      # read one entry (a unique id prefix or the 4-character hash)
lb list --status lapsed           # active on disk, but past their until date
lb search pipefail                # find active entries (--all adds closed and lapsed ones)
lb delta --session "$SESSION_ID"  # what other sessions changed since your brief
lb review                         # the owner's digest of what changed
lb usage                          # how often briefs and checks actually ran
```

Active list/search views exclude entries past their `until`. All-status views and
`lb show` report them as `lapsed` without writing the store; Bosun later expires them.

Run `lb --help` for every command. `lb --version` (or `lb -v`) prints the installed
Leeboard package version. `lb release`, `ack`, `reply`, `close`, `revoke`,
`supersede` and `revise` change an existing entry. `lb purge` deletes entries for good,
on the owner's word (`lb purge --closed` clears entries closed over 30 days ago); the
[`memory` skill](skills/memory/SKILL.md) is the quick reference for agents.

## Harness integration

Leeboard has three integration layers. Use the first everywhere; add the others where
they help.

### 1. Agent instructions

Add a section like this to the instructions every agent loads (`AGENTS.md`,
`CLAUDE.md` or your harness's equivalent):

````markdown
## Leeboard

Leeboard (`lb`) is the shared store of standing rules, grants, holds, references,
handoffs and requests for every agent session.

- At session start and after `/clear`, run `lb brief` once before substantive work.
  After compaction, run it only if no Leeboard brief was injected into the new context.
  Pass your identity: `--harness claude-code --session "$CLAUDE_CODE_SESSION_ID"` in
  Claude Code, `--harness pi --session "$PI_SESSION_ID"` in Pi. With no session id, run
  it without `--session`.
- Rules, grants and holds stand until revoked. When one conflicts with what the user
  says now, the user wins: say so, and supersede the entry. Verify a reference against
  the current system before relying on it.
- Before a push, merge or deploy, run `lb check --blocks <push|merge|deploy>`. Exit 3
  means an active hold blocks it: stop, show the user the hold and its release
  condition, and continue only on their word.
- The brief lists titles. Run `lb show <id>` when a title bears on the work. Act on
  inbox handoffs and requests addressed to you, then `lb ack`, or `lb reply` and
  `lb close`.
- Read the `memory` skill before writing or changing an entry.
- If `lb` is missing or fails, continue normally and mention it once.
````

Tags after `--blocks` are free strings. `push`, `merge` and `deploy` are the convention;
use any tag your gates agree on. The identity variables above are the ones Claude Code and
Pi provide to their agents; you can also export `LEEBOARD_HARNESS` and `LEEBOARD_SESSION`
instead of passing flags. With neither, `lb` falls back to `CLAUDE_CODE_SESSION_ID` or
`PI_SESSION_ID`, so a write without flags is still attributed (not when both are set). The harness names Leeboard knows are `claude-code`, `pi`,
`helmraiser`, `funkyoctopus`, `bosun` and `user`. Any other name is refused (exit 1);
from another tool, omit `--harness` and pass only `--session`.

### 2. Claude Code hooks

Instructions are skipped most often after compaction and in sub-agents, so Claude Code
gets two hooks. They need `jq`. Save these two scripts, make them executable, and
register them in `~/.claude/settings.json`.

`~/.claude/hooks/leeboard-session-start.sh` re-briefs after compaction, with the session
id and directory from the hook's input:

```bash
#!/usr/bin/env bash
in=$(cat)
sid=$(printf '%s' "$in" | jq -r '.session_id // empty')
dir=$(printf '%s' "$in" | jq -r '.cwd // empty')
lb brief --harness claude-code ${sid:+--session "$sid"} ${dir:+--cwd "$dir"} 2>/dev/null || true
```

`~/.claude/hooks/leeboard-subagent-start.sh` injects the brief into every sub-agent's
context. It passes no session id on purpose: a sub-agent that reused its parent's id would
move the parent's `lb delta` cursor.

```bash
#!/usr/bin/env bash
in=$(cat)
dir=$(printf '%s' "$in" | jq -r '.cwd // empty')
{
  echo "Leeboard brief, run for you at sub-agent start. Do not run lb brief yourself."
  echo
  lb brief --harness claude-code ${dir:+--cwd "$dir"} 2>/dev/null
} | jq -Rs '{hookSpecificOutput: {hookEventName: "SubagentStart", additionalContext: .}}'
```

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "compact",
        "hooks": [{ "type": "command", "command": "~/.claude/hooks/leeboard-session-start.sh" }]
      }
    ],
    "SubagentStart": [
      {
        "hooks": [{ "type": "command", "command": "~/.claude/hooks/leeboard-subagent-start.sh" }]
      }
    ]
  }
}
```

Merge this into any `hooks` you already have. If your command is `leeboard` rather than
`lb`, change it in the scripts. Hooks run with the environment Claude Code gives them, so
`lb` and `jq` must be on that `PATH`. See the Claude Code hooks documentation for the
current settings format.

Claude Code's own auto-memory can stay on: Bosun mirrors its notes into the store (see
below), and nothing is written back.

### 3. Skills

Two skills ship in `skills/`. `memory` teaches an agent when and how to write, change and
look up entries. `catchup` answers "what should I do next?" from `TASKS.md`,
`CURRENT_STATE.md`, git history, the inbox and active holds. Link them where your
harnesses look for skills:

```bash
mkdir -p ~/.claude/skills ~/.pi/agent/skills
for skill in memory catchup; do
  ln -s "$PWD/skills/$skill" ~/.claude/skills/$skill
  ln -s "$PWD/skills/$skill" ~/.pi/agent/skills/$skill
done
```

Run this from the repository root.

### Unattended runners

An unattended task runner is a harness that no person watches. Set
`LEEBOARD_HARNESS=helmraiser` (and `LEEBOARD_SESSION` to the run id) for such workers.
They may write entries and acknowledge, reply to or close handoffs and requests, but they
cannot create, release, revoke or revise holds and grants, and they can revoke, supersede
or revise other entries only if their own session wrote them (exit 6 otherwise). The runner itself should gate its queue with
`lb check --blocks <tag> --cwd <worktree>` and render `lb brief --cwd <worktree>` into
each worker's directive. Helmraiser, a sibling project, is such a runner: it runs tasks
unattended over `pi`. Section 9.3 of [docs/design.md](docs/design.md) has the details.

## Bosun, the librarian

Agents write freely, so something has to keep the store small and consistent.

- `lb bosun` is the quick pass. It uses no LLM. It expires holds and handoffs past their
  `until` date and reports dead path references, entries citing superseded or missing
  entries, exact duplicates, holds untouched for a week, and files that cannot be parsed.
  `--dry-run` changes nothing.
- `lb bosun --full --runner <pi|claude> --model <id>` also runs an LLM agent that mirrors
  new Claude Code memory notes into entries, merges duplicates, resolves clear
  contradictions, fixes titles and scopes, and retires entries that fail the admission
  test, and writes a report listing everything it changed or left in doubt. Its prompt
  confines it to `lb`, and `lb` refuses to let Bosun purge or revoke an entry the owner
  wrote. The agent has a real shell, so use a runner and model you trust
  ([SECURITY.md](SECURITY.md)). `--if-changed` skips the agent when nothing is new.
- The runners: [Pi](https://github.com/earendil-works/pi) (`pi`, the default) needs a
  configured model provider. `claude` uses your Claude Code login and removes
  `ANTHROPIC_API_KEY` from its environment, so an API-key-only setup will not
  authenticate. Memory notes are read from `~/.claude/projects` (`--memory-root <dir>`
  to change); without Claude Code there are none to mirror.

Read what it did with `lb review`. Every change is a status change or a revision, logged
and kept in the store's git history.

### Run it daily

`deploy/` has a systemd user timer (Linux) that runs the pass every morning and then commits and
pushes the store. See [deploy/README.md](deploy/README.md).

## Environment

| Variable | Meaning |
|---|---|
| `LEEBOARD_HOME` | Store directory; default `~/.leeboard` |
| `LEEBOARD_HARNESS` | Default for `--harness` |
| `LEEBOARD_SESSION` | Default for `--session` |
| `CLAUDE_CODE_SESSION_ID` / `PI_SESSION_ID` | Fallback identity (`claude-code` / `pi`) when neither flags nor `LEEBOARD_*` give one |

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Success |
| 1 | Usage error, or `bosun --full` did not finish cleanly |
| 2 | Credential-like text rejected; nothing was written |
| 3 | `lb check` found an active hold that blocks the tag |
| 4 | Unknown or ambiguous id |
| 5 | Disallowed transition (for example releasing a rule) |
| 6 | Not permitted for this harness |

## Development

```bash
npm ci
npm run build       # compile to dist/
npm test            # vitest
npm run typecheck   # tsc --noEmit
```

Tests never touch a real store: they run with `LEEBOARD_HOME` and `HOME` pointing at
temporary directories. `LEEBOARD_PERF=1 npm test` also runs the opt-in timing tests. See
[CONTRIBUTING.md](CONTRIBUTING.md) for the contribution workflow and
[AGENTS.md](AGENTS.md) for the rules agents follow in this repository.

## Security

See [SECURITY.md](SECURITY.md) to report a vulnerability privately.

## Licence

[MIT](LICENSE).

---

Leeboard is one of the tools from [ZB Code Shipyard](https://zsoltborsos.net). Its tools
are Helmraiser, Leeboard and FunkyOctopus.

A decade of building software by hand. Now with a crew of AI agents.
