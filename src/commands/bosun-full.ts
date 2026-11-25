import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { readWatermark, scanMirror, writeWatermark } from '../bosun/mirror.js';
import { PROMPT_TEMPLATE, renderPrompt } from '../bosun/prompt.js';
import { type AgentExit, buildInvocation, NEEDS_MODEL, parseStream, type Runner, runAgent, type Usage, validateRunnerOptions } from '../bosun/runner.js';
import { readSection } from '../change.js';
import type { Ctx } from '../context.js';
import { timestamp } from '../entry.js';
import { EXIT, LeeboardError } from '../errors.js';
import { logSize, readLogSince } from '../log.js';
import { jsonLine, ok, type RunResult } from '../result.js';
import { listEntries, writeFileAtomic } from '../store.js';
import { bosun, type BosunReport, renderBosun } from './bosun.js';

export interface FullOptions {
  runner: string;
  model: string;
  thinking?: string;
  /** Default `~/.claude/projects`. */
  memoryRoot?: string;
  timeoutMinutes: number;
  /** The environment the agent inherits (plus LEEBOARD_HOME, LEEBOARD_HARNESS, LEEBOARD_SESSION). */
  env: NodeJS.ProcessEnv;
}

/** `state/bosun/<run>/run.json`. `reported` values come from the runner's stream, null when it did not say. */
export interface RunRecord {
  runId: string;
  runner: Runner;
  model: { requested: string; reported: string | null };
  thinking: { requested: string | null; reported: string | null };
  startedAt: string;
  wallMs: number;
  exit: Omit<AgentExit, 'wallMs'>;
  clean: boolean;
  usage: Usage | null;
  costUsd: number | null;
  turns: number | null;
  extra: Record<string, unknown>;
  mirror: { new: number; changed: number; deleted: number; watermarkWritten: boolean };
}

export interface Changes {
  total: number;
  created: number;
  /** Body updates and in-place revisions. */
  updated: number;
  /** Status changes by the resulting status. */
  status: Record<string, number>;
}

export interface FullResult {
  runId: string;
  dir: string;
  /** Null when the agent produced no final message. */
  reportPath: string | null;
  clean: boolean;
  quick: BosunReport;
  mirror: { new: number; changed: number; deleted: number };
  changes: Changes;
  run: RunRecord;
}

const usage = (message: string): LeeboardError => new LeeboardError(message, EXIT.USAGE);
const DEFAULT_MEMORY_ROOT = (): string => join(homedir(), '.claude', 'projects');

/** Where the last clean full pass left the change log, so an idle day can skip the agent. */
const lastCleanPath = (home: string): string => join(home, 'state', 'bosun', 'last-clean.json');

/**
 * A full pass has work only when no clean pass ran yet, a memory note is new, changed or
 * deleted, or another session changed an entry since the last clean pass. Bosun's own
 * writes (its runs and the quick pass) do not count.
 */
export function fullPassNeeded(home: string, memoryRoot?: string): { needed: boolean; reason: string } {
  let last: { runId: string; logOffset: number };
  try {
    last = JSON.parse(readFileSync(lastCleanPath(home), 'utf8'));
  } catch {
    return { needed: true, reason: 'no earlier clean full pass' };
  }
  const mirror = scanMirror(memoryRoot ?? DEFAULT_MEMORY_ROOT(), readWatermark(home), { allowMissing: memoryRoot === undefined });
  const notes = mirror.notes.length + mirror.deleted.length;
  if (notes > 0) return { needed: true, reason: `${notes} memory note${notes === 1 ? '' : 's'} new, changed or deleted` };
  const others = readLogSince(home, last.logOffset).lines.filter((line) => line.harness !== 'bosun').length;
  if (others > 0) return { needed: true, reason: `${others} entry change${others === 1 ? '' : 's'} by other sessions` };
  return { needed: false, reason: `nothing new since ${last.runId}` };
}

function checkTimeout(minutes: number): void {
  if (!(Number.isFinite(minutes) && minutes > 0)) throw usage('--timeout must be a positive number of minutes');
}

/** What `lb bosun --full` was given, as parsed from the command line and not yet checked. */
export interface FullFlags {
  runner?: string;
  model?: string;
  thinking?: string;
  /** Relative to the directory `lb` was started in. */
  memoryRoot?: string;
  /** Minutes, default 30. */
  timeout?: string;
  ifChanged?: boolean;
  json?: boolean;
}

/** What the CLI hands `bosunFullCommand` besides the flags. */
export interface FullContext {
  home: string;
  /** Resolves the caller's identity on each call, so a bad flag is reported before a bad identity. */
  ctx: () => Ctx;
  env: NodeJS.ProcessEnv;
  /** Where `lb` was started; `--memory-root` is relative to it. */
  cwd: string;
}

/**
 * `lb bosun --full`: check the flags, skip an idle pass under `--if-changed` (the quick pass
 * still runs), run the pass, and map an unclean run to exit 1.
 */
export async function bosunFullCommand({ home, ctx, env, cwd }: FullContext, flags: FullFlags): Promise<RunResult> {
  const timeoutMinutes = flags.timeout === undefined ? 30 : Number(flags.timeout);
  checkTimeout(timeoutMinutes);
  const memoryRoot = flags.memoryRoot === undefined ? undefined : resolve(cwd, flags.memoryRoot);
  if (flags.ifChanged) {
    const gate = fullPassNeeded(home, memoryRoot);
    if (!gate.needed) {
      const report = bosun(ctx());
      const stdout = flags.json ? jsonLine({ skipped: true, reason: gate.reason, quick: report }) : `Bosun full pass skipped: ${gate.reason}\n${renderBosun(report)}`;
      return ok(stdout);
    }
  }
  const result = await bosunFull(ctx(), {
    runner: flags.runner ?? fail('bosun --full needs --runner pi|claude'),
    model: flags.model ?? fail(NEEDS_MODEL),
    thinking: flags.thinking,
    memoryRoot,
    timeoutMinutes,
    env,
  });
  return {
    code: result.clean ? 0 : 1,
    stdout: flags.json ? jsonLine(result) : renderFull(result),
    stderr: result.clean ? '' : `lb: bosun --full did not finish cleanly; see ${result.dir}\n`,
  };
}

/**
 * The LLM pass: quick pass, mirror input, rendered prompt, one agent session that changes
 * the store through `lb` as harness `bosun`, then the report and run record. The mirror
 * watermark advances only on a clean run, so a failed run's input is offered again.
 */
export async function bosunFull(ctx: Ctx, options: FullOptions): Promise<FullResult> {
  // Validate the runner arguments before anything is written.
  const { runner, model } = validateRunnerOptions(options.runner, options.model, options.thinking);
  checkTimeout(options.timeoutMinutes);
  const memoryRoot = options.memoryRoot ?? DEFAULT_MEMORY_ROOT();
  const allowMissing = options.memoryRoot === undefined;
  const runId = `bosun-${timestamp(ctx.now).replace(/[-:]/g, '')}`;
  const invocationBase = { runner, model, thinking: options.thinking, home: ctx.home, session: runId, env: options.env };

  // Reading the memory root changes nothing; a missing root fails here, unless it is the
  // default one and nothing was mirrored yet (no Claude Code on this machine).
  const mirror = scanMirror(memoryRoot, readWatermark(ctx.home), { allowMissing });
  const dir = join(ctx.home, 'state', 'bosun', runId);
  mkdirSync(join(ctx.home, 'state', 'bosun'), { recursive: true });
  try {
    mkdirSync(dir);
  } catch {
    throw usage(`run ${runId} already exists; wait a second and retry`);
  }

  const logStart = logSize(ctx.home);
  const actor: Ctx = { ...ctx, identity: { harness: 'bosun', session: runId, origin: 'agent-inferred' } };
  const quick = bosun(actor);

  const prompt = renderPrompt(readFileSync(PROMPT_TEMPLATE, 'utf8'), {
    runId,
    today: timestamp(ctx.now).slice(0, 10),
    memoryRoot,
    quickReport: renderBosun(quick),
    notes: mirror.notes,
    deleted: mirror.deleted,
    revoked: listEntries(ctx.home).filter((entry) => entry.status === 'revoked').map((entry) => ({
      id: entry.id, scope: entry.scope, title: entry.title,
      reason: readSection(entry.body, 'Revoked') ?? '',
    })),
  });
  const promptFile = join(dir, 'prompt.md');
  writeFileSync(promptFile, prompt);

  const invocation = buildInvocation({ ...invocationBase, promptFile, prompt });
  const transcript = join(dir, 'transcript.jsonl');
  const exit = await runAgent(invocation, {
    transcript,
    stderr: join(dir, 'stderr.log'),
    timeoutMs: Math.round(options.timeoutMinutes * 60_000),
  });

  const facts = parseStream(runner, readFileSync(transcript, 'utf8'));
  let reportPath: string | null = null;
  if (facts.report !== null) {
    reportPath = join(dir, 'report.md');
    writeFileSync(reportPath, facts.report.replace(/\n*$/, '\n'));
  }
  const clean = exit.code === 0 && !exit.timedOut && !facts.error && facts.report !== null;
  if (clean) writeWatermark(ctx.home, mirror.next);

  const counts = {
    new: mirror.notes.filter((note) => note.status === 'new').length,
    changed: mirror.notes.filter((note) => note.status === 'changed').length,
    deleted: mirror.deleted.length,
  };
  const { wallMs, ...exitFacts } = exit;
  const run: RunRecord = {
    runId,
    runner,
    model: { requested: model, reported: facts.model },
    thinking: { requested: options.thinking ?? null, reported: facts.thinking },
    startedAt: timestamp(ctx.now),
    wallMs,
    exit: exitFacts,
    clean,
    usage: facts.usage,
    costUsd: facts.costUsd,
    turns: facts.turns,
    extra: facts.extra,
    mirror: { ...counts, watermarkWritten: clean },
  };
  writeFileSync(join(dir, 'run.json'), JSON.stringify(run, null, 2) + '\n');
  if (clean) writeFileAtomic(lastCleanPath(ctx.home), JSON.stringify({ runId, logOffset: logSize(ctx.home) }) + '\n');

  return { runId, dir, reportPath, clean, quick, mirror: counts, changes: countChanges(ctx.home, logStart, runId), run };
}

function fail(message: string): never {
  throw usage(message);
}

function countChanges(home: string, offset: number, session: string): Changes {
  const changes: Changes = { total: 0, created: 0, updated: 0, status: {} };
  for (const line of readLogSince(home, offset).lines) {
    if (line.session !== session) continue;
    changes.total++;
    if (line.event === 'created') changes.created++;
    else if (line.event === 'updated' || line.event === 'revised') changes.updated++;
    else if (line.event === 'status') changes.status[line.status] = (changes.status[line.status] ?? 0) + 1;
  }
  return changes;
}

function minutes(ms: number): string {
  const seconds = Math.round(ms / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, '0')}s`;
}

export function renderFull(result: FullResult): string {
  const { run, quick, changes } = result;
  const outcome = run.exit.timedOut ? 'timed out'
    : run.exit.error ? `could not start: ${run.exit.error}`
    : result.clean ? 'clean'
    : run.exit.code !== 0 ? `failed (exit ${run.exit.code ?? run.exit.signal})`
    : result.reportPath === null ? 'failed (no final message)' : 'failed (runner reported an error)';
  const thinking = run.thinking.requested === null ? '' : `, thinking ${run.thinking.requested}`;
  const breakdown = [
    ...(changes.created ? [`${changes.created} created`] : []),
    ...(changes.updated ? [`${changes.updated} updated`] : []),
    ...Object.keys(changes.status).sort().map((status) => `${changes.status[status]} ${status}`),
  ];
  const lines = [
    `Bosun full pass ${result.runId} (${run.runner} ${run.model.requested}${thinking}): ${outcome}, ${minutes(run.wallMs)}`,
    `Reported by the runner: model ${run.model.reported ?? 'not reported'}, thinking ${run.thinking.reported ?? 'not reported'}`,
    `Quick pass: ${quick.expired.length} expired, ${quick.deadReferences.length} dead references, ${quick.duplicates.length} duplicate groups, ${quick.staleHolds.length} stale holds`,
    `Mirror input: ${result.mirror.new} new, ${result.mirror.changed} changed, ${result.mirror.deleted} deleted — watermark ${run.mirror.watermarkWritten ? 'updated' : 'kept'}`,
    `Changes: ${changes.total}${breakdown.length ? ` (${breakdown.join(', ')})` : ''}`,
  ];
  if (run.usage) {
    const cost = run.costUsd === null ? '' : `; cost $${run.costUsd.toFixed(4)}`;
    lines.push(`Tokens: ${run.usage.input} in, ${run.usage.output} out, ${run.usage.cacheRead} cache read, ${run.usage.cacheWrite} cache write${cost}`);
  }
  lines.push(`Report: ${result.reportPath ?? 'none'}`, `Run record: ${join(result.dir, 'run.json')}`);
  return lines.join('\n') + '\n';
}
