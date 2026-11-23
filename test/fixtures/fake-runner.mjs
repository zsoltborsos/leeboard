// Stands in for `pi` and `claude` in tests: records how it was called, runs scripted `lb`
// commands (as the agent would, through bash), then replays the runner's recorded stream
// with the final assistant text replaced by the scripted report.
//
//   node fake-runner.mjs <pi|claude> [runner args...]
//
// Environment:
//   FAKE_RUNNER_LOG        append {runner, args, cwd, env} as one JSON line
//   FAKE_LB_SCRIPT         JSON file: [{ "args": [...], "input"?: "..." }, ...] run as `lb <args>`
//   FAKE_REPORT_FILE       final assistant text (default: the recorded "done")
//   FAKE_RUNNER_SLEEP_MS   sleep this long after the first half of the stream
//   FAKE_RUNNER_EXIT       exit code (default 0)
//   FAKE_RUNNER_WRITE_REAL append a bosun-attributed line to ~/.leeboard/log.jsonl (the trial safety check must catch it)
//   FAKE_RUNNER_WRITE_REAL_OTHER append another session's line (the safety check must allow it)
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const [runner, ...args] = process.argv.slice(2);
const env = process.env;

if (env.FAKE_RUNNER_LOG) {
  appendFileSync(env.FAKE_RUNNER_LOG, JSON.stringify({
    runner,
    args,
    cwd: process.cwd(),
    env: {
      LEEBOARD_HOME: env.LEEBOARD_HOME ?? null,
      LEEBOARD_HARNESS: env.LEEBOARD_HARNESS ?? null,
      LEEBOARD_SESSION: env.LEEBOARD_SESSION ?? null,
      ANTHROPIC_API_KEY: 'ANTHROPIC_API_KEY' in env,
    },
  }) + '\n');
}

if (env.FAKE_RUNNER_WRITE_REAL) {
  mkdirSync(join(homedir(), '.leeboard'), { recursive: true });
  appendFileSync(join(homedir(), '.leeboard', 'log.jsonl'), JSON.stringify({ id: 'rule-x', harness: 'bosun', session: env.LEEBOARD_SESSION ?? 'bosun-x', event: 'created' }) + '\n');
}

if (env.FAKE_RUNNER_WRITE_REAL_OTHER) {
  // Another live session writing to the real store at the same time: allowed.
  mkdirSync(join(homedir(), '.leeboard'), { recursive: true });
  appendFileSync(join(homedir(), '.leeboard', 'log.jsonl'), JSON.stringify({ id: 'rule-y', harness: 'claude-code', session: 'other', event: 'created' }) + '\n');
}

if (env.FAKE_LB_SCRIPT) {
  for (const step of JSON.parse(readFileSync(env.FAKE_LB_SCRIPT, 'utf8'))) {
    const result = spawnSync('lb', step.args, { input: step.input ?? '', encoding: 'utf8' });
    process.stderr.write(`$ lb ${step.args.join(' ')} -> ${result.status}\n${result.stderr ?? ''}`);
  }
}

const report = env.FAKE_REPORT_FILE ? readFileSync(env.FAKE_REPORT_FILE, 'utf8') : 'done';
const replace = (value) =>
  value === 'done' ? report
    : Array.isArray(value) ? value.map(replace)
    : value !== null && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, replace(v)]))
    : value;

const recorded = readFileSync(join(import.meta.dirname, 'streams', `${runner}.jsonl`), 'utf8').trimEnd().split('\n');
const lines = recorded.map((line) => JSON.stringify(replace(JSON.parse(line))));
const half = Math.floor(lines.length / 2);
process.stdout.write(lines.slice(0, half).join('\n') + '\n');
if (env.FAKE_RUNNER_SLEEP_MS) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(env.FAKE_RUNNER_SLEEP_MS));
process.stdout.write(lines.slice(half).join('\n') + '\n');
process.exitCode = Number(env.FAKE_RUNNER_EXIT ?? 0);
