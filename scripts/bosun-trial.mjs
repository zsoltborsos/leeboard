#!/usr/bin/env node
// Bosun model trials: run `lb bosun --full` for each model × repeat against a
// fresh copy of the fixture, score each run against expected.json, and write results.json and
// results.md. Bosun must never write to the real store (~/.leeboard): after every run and at the
// end, new real log lines and entry files are checked for harness bosun. Other sessions may write.
//
//   npm run build
//   node scripts/bosun-trial.mjs --models <runner:model[:thinking],...> [--repeat N] [--out <dir>]
//                                [--timeout <minutes>] [--fixture <dir>]
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const REPO = join(import.meta.dirname, '..');
const CLI = join(REPO, 'dist', 'cli.js');

function die(message, code = 1) {
  process.stderr.write(`bosun-trial: ${message}\n`);
  process.exit(code);
}

const { values } = parseArgs({
  options: {
    models: { type: 'string' },
    repeat: { type: 'string', default: '1' },
    out: { type: 'string' },
    timeout: { type: 'string', default: '30' },
    fixture: { type: 'string', default: join(REPO, 'trials', 'bosun') },
    help: { type: 'boolean' },
  },
});
if (values.help || !values.models) {
  process.stdout.write('usage: node scripts/bosun-trial.mjs --models <runner:model[:thinking],...> [--repeat N] [--out <dir>] [--timeout <minutes>] [--fixture <dir>]\n');
  process.exit(values.help ? 0 : 1);
}
if (!existsSync(CLI)) die('dist/cli.js is missing: run `npm run build` first');
const { scoreRun, loadStoreEntries, aggregate, renderRunDiff } = await import(join(REPO, 'dist', 'bosun', 'score.js'));
const { RUNNERS, THINKING_LEVELS } = await import(join(REPO, 'dist', 'bosun', 'runner.js'));

/** `runner:model[:thinking]`; the model id itself may contain `/` and `:`. */
function parseModel(spec) {
  const first = spec.indexOf(':');
  if (first < 0) die(`bad model '${spec}': use runner:model[:thinking]`);
  const runner = spec.slice(0, first);
  let model = spec.slice(first + 1);
  let thinking = null;
  const last = model.lastIndexOf(':');
  if (last >= 0 && THINKING_LEVELS.includes(model.slice(last + 1))) {
    thinking = model.slice(last + 1);
    model = model.slice(0, last);
  }
  if (!RUNNERS.includes(runner) || model === '') die(`bad model '${spec}': runner is ${RUNNERS.join(' or ')}`);
  return { label: spec, runner, model, thinking };
}

const models = values.models.split(',').map((spec) => spec.trim()).filter(Boolean).map(parseModel);
const repeat = Number(values.repeat);
if (!Number.isInteger(repeat) || repeat < 1) die('--repeat must be a positive integer');
const fixture = resolve(values.fixture);
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
const out = resolve(values.out ?? join(REPO, 'trials', 'bosun', 'results', stamp));
const expected = JSON.parse(readFileSync(join(fixture, 'expected.json'), 'utf8'));
const baselineEntries = loadStoreEntries(join(fixture, 'store'));
const baselineIds = baselineEntries.map((entry) => entry.id);
// The fixture already holds superseded and revoked entries; only the ones active before the run can be churn.
const baselineActiveIds = baselineEntries.filter((entry) => entry.status === 'active').map((entry) => entry.id);

// --- Bosun must never write to the real store ----------------------------------------------
// Other live sessions may write to ~/.leeboard while a trial runs; that is allowed. What must
// never appear there is a change made by Bosun: a log line from harness bosun, or an entry
// file authored by it.
const realStore = join(homedir(), '.leeboard');
const realLog = join(realStore, 'log.jsonl');
const startOffset = (() => { try { return statSync(realLog).size; } catch { return 0; } })();
const startedMs = Date.now();
function bosunWritesToReal() {
  const found = [];
  try {
    const tail = readFileSync(realLog).subarray(startOffset).toString('utf8');
    for (const line of tail.split('\n')) {
      if (!line.trim()) continue;
      let row; try { row = JSON.parse(line); } catch { continue; }
      if (row.harness === 'bosun' || String(row.session ?? '').startsWith('bosun-')) found.push(`log: ${line.slice(0, 200)}`);
    }
  } catch {}
  const walk = (dir) => {
    let names = [];
    try { names = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const d of names) {
      const path = join(dir, d.name);
      if (d.isDirectory()) { if (d.name !== '.git' && d.name !== 'state') walk(path); continue; }
      if (!d.name.endsWith('.md')) continue;
      try {
        if (statSync(path).mtimeMs >= startedMs && /\n\s+harness: bosun\b/.test(readFileSync(path, 'utf8'))) found.push(`entry: ${path}`);
      } catch {}
    }
  };
  walk(realStore);
  return found;
}
const results = { startedAt: new Date().toISOString(), fixture, out, models: models.map((m) => m.label), repeat, realStore, runs: [], summary: [] };

function write() {
  results.summary = aggregate(results.runs.map((run) => ({ model: run.model, values: run.values })));
  writeFileSync(join(out, 'results.json'), JSON.stringify(results, null, 2) + '\n');
  writeFileSync(join(out, 'results.md'), renderMarkdown());
}

function checkReal(when) {
  const found = bosunWritesToReal();
  if (found.length === 0) return;
  results.aborted = `the real store ${realStore} changed ${when}`;
  write();
  process.stderr.write(
    `\n!!! ABORT: the real store ${realStore} changed ${when}: Bosun wrote to it.\n` +
    found.map((f) => `!!! ${f}\n`).join('') + `!!! Partial results: ${out}\n`,
  );
  process.exit(2);
}

// --- reporting ------------------------------------------------------------------------------
const pct = (metric) => (metric.n === 0 ? null : metric.hit / metric.n);
function fmt(summary, kind) {
  if (!summary) return '–';
  const show = (value) =>
    kind === 'pct' ? `${Math.round(value * 100)}%`
      : kind === 'ms' ? `${(value / 60000).toFixed(1)}m`
      : kind === 'usd' ? `$${value.toFixed(3)}`
      : kind === 'k' ? `${(value / 1000).toFixed(0)}k`
      : value.toFixed(1);
  return summary.sd === null ? show(summary.mean) : `${show(summary.mean)} ± ${show(summary.sd)}`;
}
const COLUMNS = [
  ['Score', 'score', 'num'], ['False retirements', 'falseRetirements', 'num'], ['Unasked edits', 'unaskedEdits', 'num'],
  ['Unasked retirements', 'unaskedRetirements', 'num'], ['Duplicates', 'duplicates', 'pct'],
  ['Decidable', 'decidable', 'pct'], ['Undecidable flagged', 'undecidable', 'pct'], ['Re-scoped', 'rescope', 'pct'],
  ['Retired', 'retire', 'pct'], ['Flagged', 'flag', 'pct'], ['Tightened', 'tighten', 'pct'], ['Stale refs', 'staleRefs', 'pct'],
  ['Mirror', 'mirror', 'pct'], ['Budget ok', 'budget', 'pct'],
  ['Report ok', 'report', 'pct'], ['Clean', 'clean', 'pct'], ['Wall', 'wallMs', 'ms'], ['Tokens in', 'tokensIn', 'k'],
  ['Tokens out', 'tokensOut', 'k'], ['Cost', 'costUsd', 'usd'],
];
function renderMarkdown() {
  const lines = [
    `# Bosun trial ${stamp}`,
    '',
    `Fixture \`${relative(REPO, fixture) || fixture}\`; ${repeat} repeat(s) per model. Score is 0–100 (weighted mean of the rates)`,
    'minus 20 per false retirement, 2 per unasked supersede and 10 per unasked revoke; see `trials/bosun/README.md`.',
    'Values are mean ± sample sd over n runs.',
    '',
  ];
  if (results.aborted) lines.push(`**ABORTED: ${results.aborted}.**`, '');
  lines.push(`| Model | n | ${COLUMNS.map(([title]) => title).join(' | ')} |`, `|---|---|${COLUMNS.map(() => '---').join('|')}|`);
  for (const row of results.summary) {
    lines.push(`| ${row.model} | ${row.n} | ${COLUMNS.map(([, key, kind]) => fmt(row.metrics[key], kind)).join(' | ')} |`);
  }
  for (const model of models) {
    const runs = results.runs.filter((run) => run.model === model.label);
    if (runs.length === 0) continue;
    lines.push('', `## ${model.label}`, '', '| Run | Clean | Score | False retirements | Unasked edits | Unasked retirements | Wall | Tokens in/out | Cost | Report | Diff |', '|---|---|---|---|---|---|---|---|---|---|---|');
    for (const run of runs) {
      const link = (file) => (run.files.includes(file) ? `[${file}](${run.dir}/${file})` : '–');
      const v = run.values;
      lines.push(`| ${run.repeat} | ${v.clean ? 'yes' : 'no'} | ${v.score.toFixed(1)} | ${v.falseRetirements} | ${v.unaskedEdits} | ${v.unaskedRetirements} | ${fmt({ mean: v.wallMs, sd: null }, 'ms')} | ` +
        `${v.tokensIn === null ? '–' : `${fmt({ mean: v.tokensIn, sd: null }, 'k')}/${fmt({ mean: v.tokensOut, sd: null }, 'k')}`} | ` +
        `${v.costUsd === null ? '–' : fmt({ mean: v.costUsd, sd: null }, 'usd')} | ${link('report.md')} | ${link('diff.md')} |`);
    }
    for (const run of runs) {
      if (run.score.misses.length === 0) continue;
      lines.push('', `Misses, run ${run.repeat}:`, '', ...run.score.misses.map((miss) => `- ${miss}`));
    }
  }
  return lines.join('\n') + '\n';
}

// --- the trial ----------------------------------------------------------------------------
mkdirSync(out, { recursive: true });
process.stdout.write(`bosun-trial: ${models.length} model(s) × ${repeat}; results in ${out}\n`);

for (const model of models) {
  for (let rep = 1; rep <= repeat; rep++) {
    const work = mkdtempSync(join(tmpdir(), 'bosun-trial-'));
    const store = join(work, 'store');
    const memory = join(work, 'memory');
    cpSync(join(fixture, 'store'), store, { recursive: true });
    cpSync(join(fixture, 'memory'), memory, { recursive: true });
    if (resolve(store) === resolve(realStore)) die('refusing to run against the real store', 2);

    const env = { ...process.env, LEEBOARD_HOME: store };
    delete env.LEEBOARD_HARNESS;
    delete env.LEEBOARD_SESSION;
    const args = ['bosun', '--full', '--runner', model.runner, '--model', model.model,
      ...(model.thinking ? ['--thinking', model.thinking] : []),
      '--memory-root', memory, '--timeout', values.timeout, '--json'];
    process.stdout.write(`- ${model.label} run ${rep}: `);
    const child = spawnSync('node', [CLI, ...args], {
      env, cwd: work, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
      timeout: (Number(values.timeout) + 5) * 60_000,
    });
    let full = null;
    try {
      full = JSON.parse(child.stdout);
    } catch {}
    checkReal(`after ${model.label} run ${rep}`);

    const slug = model.label.replace(/[^A-Za-z0-9._-]+/g, '_');
    const dir = join(slug, String(rep));
    const runDir = join(out, dir);
    mkdirSync(runDir, { recursive: true });
    const files = [];
    if (full?.dir && existsSync(full.dir)) {
      cpSync(full.dir, runDir, { recursive: true });
      files.push('prompt.md', 'transcript.jsonl', 'stderr.log', 'run.json', ...(full.reportPath ? ['report.md'] : []));
    }
    if (full?.runId) {
      writeFileSync(join(runDir, 'diff.md'), renderRunDiff(store, full.runId));
      files.push('diff.md');
    }
    writeFileSync(join(runDir, 'lb.log'), `exit ${child.status}${child.error ? ` (${child.error})` : ''}\n--- stderr\n${child.stderr ?? ''}\n--- stdout\n${child.stdout ?? ''}`);
    cpSync(store, join(runDir, 'store'), { recursive: true, filter: (path) => !path.startsWith(join(store, 'state')) });

    const report = full?.reportPath && existsSync(full.reportPath) ? readFileSync(full.reportPath, 'utf8') : null;
    const score = scoreRun({ baselineIds, baselineActiveIds, entries: loadStoreEntries(store), report, expected });
    const usage = full?.run?.usage ?? null;
    results.runs.push({
      model: model.label,
      repeat: rep,
      runId: full?.runId ?? null,
      dir,
      files,
      lbExit: child.status,
      run: full?.run ?? null,
      changes: full?.changes ?? null,
      score,
      values: {
        score: score.score,
        falseRetirements: score.falseRetirements.length,
        unaskedEdits: score.unaskedEdits,
        unaskedRetirements: score.unaskedRetirements,
        duplicates: pct(score.duplicates),
        decidable: pct(score.decidable),
        undecidable: pct(score.undecidable),
        rescope: pct(score.rescope),
        retire: pct(score.retire),
        flag: pct(score.flag),
        tighten: pct(score.tighten),
        staleRefs: pct(score.staleRefs),
        mirror: pct(score.mirror),
        budget: score.budget.ok ? 1 : 0,
        report: score.report.wellFormed ? 1 : 0,
        clean: full?.clean ? 1 : 0,
        wallMs: full?.run?.wallMs ?? null,
        tokensIn: usage ? usage.input + usage.cacheRead + usage.cacheWrite : null,
        tokensOut: usage ? usage.output : null,
        costUsd: full?.run?.costUsd ?? null,
      },
    });
    rmSync(work, { recursive: true, force: true });
    write();
    process.stdout.write(`${full?.clean ? 'clean' : 'NOT CLEAN'}, score ${score.score.toFixed(1)}, ${score.falseRetirements.length} false retirement(s)\n`);
  }
}

checkReal('by the end of the trial');
results.finishedAt = new Date().toISOString();
write();
process.stdout.write(`bosun-trial: done. ${join(out, 'results.md')}\n`);
