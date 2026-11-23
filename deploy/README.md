# Daily Bosun job

Linux only: a systemd user timer runs Bosun once a day and then commits and pushes the store, so each
day's changes, yours and Bosun's, are one reviewable commit. Read them with `lb review`.

Daily at 06:30, with a random delay of up to 10 minutes. `Persistent=true` makes the timer
run a missed pass at the next opportunity, for example after the computer was off.

## What it runs

`deploy/bosun-daily.sh`, from this checkout's `dist/`:

1. With a model configured (below), `lb bosun --full --if-changed --runner <runner>
   --model <model> [--thinking <level>] --timeout 30`. The LLM pass runs only when a
   Claude Code memory note is new, changed or deleted, or another session changed an
   entry since the last clean pass; otherwise only the deterministic quick pass runs.
2. With no model configured, `lb bosun`: the deterministic quick pass only (expires
   lapsed holds and handoffs and reports problems; no LLM).
3. In the store (`$LEEBOARD_HOME`, default `~/.leeboard`): `git add -A`, and if anything
   changed, one commit named `Daily Bosun pass <date>` and `git push`. This happens even
   after a failed pass, because the store is the record. The script then exits with the
   pass's own exit status, so a failed pass shows up as a failed unit.

The job runs from `dist/`, so rebuilding (`npm run build`) changes the next run's code.

## Requirements

- The store is a git repository with a remote and an upstream branch, so a bare
  `git push` works (the README's `git push -u origin main` does this). Git needs a commit
  identity for that repository.
- `node` is on the `PATH` of the systemd user manager. For `--full` the chosen runner
  (`pi` or `claude`) must be too, and logged in. `claude` uses the Claude Code login and
  ignores `ANTHROPIC_API_KEY`.
- `git push` can authenticate without a prompt, for example through an SSH agent whose
  socket is in the user manager's environment.

Check what the user manager sees with `systemctl --user show-environment`. If something
is missing, set it in the environment file below (for example `PATH=...`), or import it
with `systemctl --user import-environment SSH_AUTH_SOCK`.

## Configure

The units read optional settings from `~/.config/leeboard/bosun.env`
(`EnvironmentFile`; the file may be absent). Plain `KEY=value` lines, no `export`, no
variable expansion:

```bash
mkdir -p ~/.config/leeboard
cat > ~/.config/leeboard/bosun.env <<'EOF'
LEEBOARD_BOSUN_RUNNER=pi
LEEBOARD_BOSUN_MODEL=<a model id your runner accepts>
LEEBOARD_BOSUN_THINKING=high
EOF
```

| Variable | Meaning |
|---|---|
| `LEEBOARD_BOSUN_RUNNER` | `pi` or `claude`; default `pi` |
| `LEEBOARD_BOSUN_MODEL` | Model id. If unset or empty, only the quick pass runs |
| `LEEBOARD_BOSUN_THINKING` | Optional reasoning level (pi: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`; claude: `low`, `medium`, `high`, `xhigh`, `max`) |
| `LEEBOARD_HOME` | Optional; the store, if it is not `~/.leeboard` |

Bosun's quality decides what every future session reads, so choose the model by trying it
(`scripts/bosun-trial.mjs`, see `trials/bosun/README.md`), not by price alone. Try a candidate with a
manual run before you schedule it:

```bash
lb bosun --full --runner pi --model <id> --thinking high
```

## Install

From the repository root, after `npm run build`:

```bash
deploy/install-units.sh
systemctl --user enable --now leeboard-bosun.timer
```

`install-units.sh` writes `leeboard-bosun.service` and `leeboard-bosun.timer` into
`~/.config/systemd/user` (or `$XDG_CONFIG_HOME/systemd/user`), with this checkout's path
filled in, and reloads systemd. Run it again if you move the checkout.

## Run once now

```bash
systemctl --user start leeboard-bosun.service
```

The unit is a one-shot, so the command returns when the run ends and shows its result.
Confirm the schedule with `systemctl --user list-timers leeboard-bosun.timer`.

## Logs

```bash
journalctl --user -u leeboard-bosun.service            # all runs
journalctl --user -u leeboard-bosun.service -n 50 -f   # follow a run
systemctl --user status leeboard-bosun.service         # last result
```

Each full pass also leaves a record in the store under `state/bosun/<run id>/`:
`report.md` (what it changed and what it left in doubt), `run.json`, the prompt, the
transcript and `stderr.log`. That directory is git-ignored and stays on this computer.

## Stop and remove

```bash
systemctl --user disable --now leeboard-bosun.timer     # stop the schedule
rm ~/.config/systemd/user/leeboard-bosun.{service,timer}
systemctl --user daemon-reload                          # forget the units
```

Stopping the timer does not interrupt a run in progress; stop that with
`systemctl --user stop leeboard-bosun.service`.
