import { beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readWatermark, writeWatermark } from '../src/bosun/mirror.js';
import { bosunFull, fullPassNeeded, renderFull } from '../src/commands/bosun-full.js';
import { createEntry } from '../src/change.js';
import type { Ctx } from '../src/context.js';
import { EXIT, LeeboardError } from '../src/errors.js';
import { logSize, readLogSince } from '../src/log.js';
import { run } from '../src/run.js';
import { findEntry, initStore, readRevision, writeEntry } from '../src/store.js';
import { CLI, fakeRunnerBin, requireBuild, sampleEntry, tempDir } from './helpers.js';

const NOW = new Date('2026-10-18T09:00:00Z');
const RUN = 'bosun-20261018T090000Z';
const sha = (text: string) => createHash('sha256').update(text).digest('hex');

const REPORT = [
  '## Mirrored', '- -mnt-p-a/note.md — new (see log)', '## Merged', 'none', '## Re-scoped', 'none', '## Tightened', 'none',
  '## Retired', '- rule-stale-0001 — code fact', '## Contradictions for the owner', 'none', '## Left alone with doubt', 'none',
].join('\n');

/** A store with one stale agent-inferred rule and one lapsed hold, a memory root with one note, and fake runners on PATH. */
function world(options: { exit?: number; sleepMs?: number; script?: { args: string[]; input?: string }[] } = {}) {
  const home = tempDir('lb-full-home-');
  initStore(home);
  writeEntry(home, sampleEntry({ id: 'rule-stale-0001', title: 'Entry ids are built in src/entry.ts' }));
  writeEntry(home, sampleEntry({ id: 'hold-lapsed-0002', kind: 'hold', title: 'Lapsed', release: 'r', until: '2026-10-01' }));
  writeEntry(home, sampleEntry({
    id: 'rule-gone-0003', status: 'revoked', title: 'Always do Y',
    body: 'Why.\n\n## Revoked (2026-10-17T10:00:00Z, user/owner)\nOwner: no longer wanted.\nSee the review.\n',
  }));
  const memory = tempDir('lb-full-memory-');
  mkdirSync(join(memory, '-mnt-p-a', 'memory'), { recursive: true });
  writeFileSync(join(memory, '-mnt-p-a', 'memory', 'note.md'), 'Owner: always do X.\n');

  const work = tempDir('lb-full-work-');
  const runnerLog = join(work, 'runner.jsonl');
  const script = join(work, 'script.json');
  writeFileSync(script, JSON.stringify(options.script ?? [
    { args: ['add', 'rule', '--title', 'Always do X', '--scope', 'global', '--origin', 'user-stated', '--body', '-'], input: 'Why.\nSource: claude-memory -mnt-p-a/note.md\n' },
    { args: ['revoke', 'rule-stale-0001', '--reason', 'code fact'] },
  ]));
  writeFileSync(join(work, 'report.md'), REPORT);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${fakeRunnerBin()}:${process.env.PATH}`,
    ANTHROPIC_API_KEY: 'not-a-real-key',
    FAKE_RUNNER_LOG: runnerLog,
    FAKE_LB_SCRIPT: script,
    FAKE_REPORT_FILE: join(work, 'report.md'),
    ...(options.exit === undefined ? {} : { FAKE_RUNNER_EXIT: String(options.exit) }),
    ...(options.sleepMs === undefined ? {} : { FAKE_RUNNER_SLEEP_MS: String(options.sleepMs) }),
  };
  const ctx: Ctx = { home, cwd: work, now: NOW, identity: { harness: 'user', session: 'owner', origin: 'agent-inferred' } };
  const calls = () => readFileSync(runnerLog, 'utf8').trimEnd().split('\n').map((line) => JSON.parse(line));
  return { home, memory, env, ctx, calls, runDir: join(home, 'state', 'bosun', RUN) };
}

// The fake agents call `lb` through a PATH shim that runs the build, so the tests that
// run an agent need `npm run build`; the ones that stop at input checks do not.
describe('bosun --full with the pi runner', () => {
  beforeAll(requireBuild);

  it('delivers stale citations and meaning-preserving repair guidance, and executes a scripted revision', async () => {
    const old = sampleEntry({ id: 'rule-old-citation-0001', title: 'Old citation target', status: 'superseded' });
    const current = sampleEntry({ id: 'rule-current-citation-0001', title: 'Current citation target', supersedes: [old.id] });
    const citing = sampleEntry({ id: 'rule-citing-0001', title: 'Follow the cited instruction', body: `Follow ${old.id}.` });
    const body = `Follow ${current.id}.`;
    const args = ['revise', citing.id, '--body', body];
    const w = world({ script: [{ args }] });
    for (const entry of [old, current, citing]) writeEntry(w.home, entry);
    const targetFiles = [old, current].map((entry) => join(w.home, 'global', 'entries', `${entry.id}.md`));
    const before = targetFiles.map((file) => readFileSync(file, 'utf8'));
    const result = await bosunFull(w.ctx, { runner: 'pi', model: 'm', memoryRoot: w.memory, timeoutMinutes: 1, env: w.env });
    expect(result.clean).toBe(true);
    const prompt = readFileSync(join(w.runDir, 'prompt.md'), 'utf8');
    expect(prompt).toContain(`## Stale entry references\n- [${citing.id}] ${citing.title} — cites ${old.id} (superseded; now ${current.id})`);
    expect(prompt).toContain('use `lb revise` on the citing\n  entry to cite the current id only when that preserves its meaning; otherwise leave\n  it unchanged and list it under "Left alone with doubt"');
    expect(result.quick.staleReferences).toEqual([{
      entry: expect.objectContaining({ id: citing.id }),
      citations: [{ id: old.id, status: 'superseded', current: current.id }],
    }]);
    expect(readFileSync(join(w.runDir, 'stderr.log'), 'utf8')).toContain(`$ lb ${args.join(' ')} -> 0`);
    expect(findEntry(w.home, citing.id)).toEqual({ ...citing, body: body + '\n', updated: expect.any(String) });
    expect(targetFiles.map((file) => readFileSync(file, 'utf8'))).toEqual(before);
  });

  it('counts a fake-agent same-id revision as an update, not an active status change', async () => {
    const args = ['revise', 'rule-stale-0001', '--title', 'Use stable entry handles', '--scope', 'machine'];
    const w = world({ script: [{ args }] });
    const original = findEntry(w.home, 'rule-stale-0001');
    const result = await bosunFull(w.ctx, { runner: 'pi', model: 'm', memoryRoot: w.memory, timeoutMinutes: 1, env: w.env });
    expect(result.clean).toBe(true);
    // A clean fake-runner exit alone does not prove the scripted CLI command succeeded.
    expect(readFileSync(join(w.runDir, 'stderr.log'), 'utf8')).toContain(`$ lb ${args.join(' ')} -> 0`);
    expect(findEntry(w.home, original.id)).toMatchObject({ id: original.id, status: 'active', title: 'Use stable entry handles', scope: 'machine', author: original.author });
    const revised = readLogSince(w.home, 0).lines.find((line) => line.event === 'revised')!;
    expect(revised).toMatchObject({ id: original.id, harness: 'bosun', session: RUN, scope: 'machine', status: 'active' });
    expect(readRevision(w.home, original.id, revised.revision!.offset)).toMatchObject({ harness: 'bosun', session: RUN, before: { title: original.title, scope: 'global', body: original.body, updated: original.updated } });
    expect(result.changes).toEqual({ total: 2, created: 0, updated: 1, status: { expired: 1 } });
    expect(result.changes.status).not.toHaveProperty('active');
    expect(renderFull(result)).toContain('Changes: 2 (1 updated, 1 expired)');
  });

  it('runs the quick pass, the agent as bosun/<run>, and records transcript, report, run.json and the watermark', async () => {
    const w = world();
    const result = await bosunFull(w.ctx, { runner: 'pi', model: 'opencode-go/deepseek-v4.1-flash', thinking: 'low', memoryRoot: w.memory, timeoutMinutes: 1, env: w.env });

    // The agent ran once, in the store, as Bosun with the run id as its session.
    const [call] = w.calls();
    expect(call.runner).toBe('pi');
    expect(call.cwd).toBe(w.home);
    expect(call.env).toEqual({ LEEBOARD_HOME: w.home, LEEBOARD_HARNESS: 'bosun', LEEBOARD_SESSION: RUN, ANTHROPIC_API_KEY: true });
    expect(call.args).toContain(join(w.runDir, 'prompt.md'));
    expect(call.args.slice(call.args.indexOf('--thinking'), call.args.indexOf('--thinking') + 2)).toEqual(['--thinking', 'low']);

    // The rendered prompt carries the context block.
    const prompt = readFileSync(join(w.runDir, 'prompt.md'), 'utf8');
    expect(prompt).toContain('# Bosun full pass');
    expect(prompt).toContain(`- Run id: ${RUN}`);
    expect(prompt).toContain('- Today: 2026-10-18');
    expect(prompt).toContain('### new: -mnt-p-a/memory/note.md');
    expect(prompt).toContain('Owner: always do X.');
    expect(prompt).toContain('## Expired\n- [hold-lapsed-0002] Lapsed');
    expect(prompt).toContain('- [rule-gone-0003] global: Always do Y — revoked: Owner: no longer wanted. See the review.');

    expect(readdirSync(w.runDir).sort()).toEqual(['prompt.md', 'report.md', 'run.json', 'stderr.log', 'transcript.jsonl']);
    expect(readFileSync(join(w.runDir, 'report.md'), 'utf8')).toBe(REPORT + '\n');
    expect(readFileSync(join(w.runDir, 'transcript.jsonl'), 'utf8')).toContain('"type":"agent_end"');

    const run = JSON.parse(readFileSync(join(w.runDir, 'run.json'), 'utf8'));
    expect(run).toMatchObject({
      runId: RUN,
      runner: 'pi',
      model: { requested: 'opencode-go/deepseek-v4.1-flash', reported: 'opencode-go/deepseek-v4.1-flash' },
      thinking: { requested: 'low', reported: 'low' },
      startedAt: '2026-10-18T09:00:00Z',
      exit: { code: 0, signal: null, timedOut: false, error: null },
      clean: true,
      usage: { input: 1289, output: 57, cacheRead: 1152, cacheWrite: 0 },
      turns: 2,
      mirror: { new: 1, changed: 0, deleted: 0, watermarkWritten: true },
    });
    expect(run.costUsd).toBeGreaterThan(0);
    expect(run.wallMs).toBeGreaterThanOrEqual(0);

    // Clean exit: the watermark now covers the note.
    expect(readWatermark(w.home)).toEqual({ '-mnt-p-a/memory/note.md': sha('Owner: always do X.\n') });

    // Changes are counted from log lines with session = run, including the quick pass's expiry.
    expect(result.changes).toEqual({ total: 3, created: 1, updated: 0, status: { expired: 1, revoked: 1 } });
    expect(readLogSince(w.home, 0).lines.every((line) => line.session === RUN && line.harness === 'bosun')).toBe(true);
    expect(findEntry(w.home, 'rule-stale-0001').status).toBe('revoked');
    expect(result).toMatchObject({ runId: RUN, clean: true, reportPath: join(w.runDir, 'report.md'), mirror: { new: 1, changed: 0, deleted: 0 } });
    expect(result.quick.expired.map((entry) => entry.id)).toEqual(['hold-lapsed-0002']);

    const text = renderFull(result);
    expect(text).toContain(`Bosun full pass ${RUN}`);
    expect(text).toContain('clean');
    expect(text).toContain(`Report: ${join(w.runDir, 'report.md')}`);
    expect(text).toContain('Changes: 3 (1 created, 1 expired, 1 revoked)');
  });

  it('leaves the watermark on a failed run so the next run retries the same input, and still keeps the report', async () => {
    const w = world({ exit: 2 });
    const previous = { '-mnt-p-a/memory/older.md': sha('older') };
    writeWatermark(w.home, previous);
    const result = await bosunFull(w.ctx, { runner: 'pi', model: 'm', memoryRoot: w.memory, timeoutMinutes: 1, env: w.env });
    expect(result.clean).toBe(false);
    expect(result.run.exit.code).toBe(2);
    expect(result.run.mirror).toEqual({ new: 1, changed: 0, deleted: 1, watermarkWritten: false });
    expect(readWatermark(w.home)).toEqual(previous);
    expect(readFileSync(join(w.runDir, 'report.md'), 'utf8')).toBe(REPORT + '\n');
    expect(renderFull(result)).toContain('watermark kept');
  });

  it('kills a run that outlives its timeout and keeps the watermark', async () => {
    const w = world({ sleepMs: 20_000, script: [] });
    const result = await bosunFull(w.ctx, { runner: 'pi', model: 'm', memoryRoot: w.memory, timeoutMinutes: 0.01, env: w.env });
    expect(result.clean).toBe(false);
    expect(result.run.exit.timedOut).toBe(true);
    expect(result.run.wallMs).toBeLessThan(15_000);
    expect(readWatermark(w.home)).toEqual({});
    expect(renderFull(result)).toContain('timed out');
  }, 20_000);
});

describe('bosun --full with the claude runner', () => {
  beforeAll(requireBuild);

  it('strips ANTHROPIC_API_KEY, never passes --bare, passes the prompt text, and reads the model back from the stream', async () => {
    const w = world();
    const result = await bosunFull(w.ctx, { runner: 'claude', model: 'claude-haiku-5-5', memoryRoot: w.memory, timeoutMinutes: 1, env: w.env });
    const [call] = w.calls();
    expect(call.runner).toBe('claude');
    expect(call.env).toEqual({ LEEBOARD_HOME: w.home, LEEBOARD_HARNESS: 'bosun', LEEBOARD_SESSION: RUN, ANTHROPIC_API_KEY: false });
    expect(call.args).not.toContain('--bare');
    expect(call.args[call.args.indexOf('--append-system-prompt') + 1]).toBe(readFileSync(join(w.runDir, 'prompt.md'), 'utf8'));
    expect(result.clean).toBe(true);
    expect(result.run).toMatchObject({
      runner: 'claude',
      model: { requested: 'claude-haiku-5-5', reported: 'claude-haiku-5-5' },
      thinking: { requested: null, reported: null },
      costUsd: 0.00151804,
      extra: { apiKeySource: 'none' },
    });
    expect(readFileSync(join(w.runDir, 'report.md'), 'utf8')).toBe(REPORT + '\n');
  });
});

describe('bosun --full refuses bad input before changing anything', () => {
  const failure = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (error) {
      expect(error).toBeInstanceOf(LeeboardError);
      return error as LeeboardError;
    }
    throw new Error('expected a LeeboardError');
  };

  it.each([
    ['an unknown runner', { runner: 'codex' }],
    ['an empty model', { model: ' ' }],
    ['a thinking level the runner lacks', { runner: 'claude', thinking: 'minimal' }],
    ['a non-positive timeout', { timeoutMinutes: 0 }],
    ['a missing memory root', { memoryRoot: '/no/such/memory/root' }],
  ])('%s', async (_name, override) => {
    const w = world();
    const log = readFileSync(join(w.home, 'log.jsonl'), 'utf8');
    const error = await failure(() => bosunFull(w.ctx, { runner: 'pi', model: 'm', memoryRoot: w.memory, timeoutMinutes: 1, env: w.env, ...override }));
    expect(error.exitCode).toBe(EXIT.USAGE);
    expect(readFileSync(join(w.home, 'log.jsonl'), 'utf8')).toBe(log);
    expect(existsSync(join(w.home, 'state', 'bosun'))).toBe(false);
    expect(findEntry(w.home, 'hold-lapsed-0002').status).toBe('active');
  });
});

describe('fullPassNeeded: skip an idle full pass', () => {
  beforeAll(requireBuild);

  it('runs when there was no clean run yet, and not again until another session writes or a note changes', async () => {
    const w = world();
    expect(fullPassNeeded(w.home, w.memory)).toEqual({ needed: true, reason: 'no earlier clean full pass' });
    await bosunFull(w.ctx, { runner: 'pi', model: 'm', memoryRoot: w.memory, timeoutMinutes: 1, env: w.env });
    expect(fullPassNeeded(w.home, w.memory)).toEqual({ needed: false, reason: `nothing new since ${RUN}` });

    writeFileSync(join(w.memory, '-mnt-p-a', 'memory', 'note.md'), 'Owner: always do X, and Z.\n');
    expect(fullPassNeeded(w.home, w.memory)).toEqual({ needed: true, reason: '1 memory note new, changed or deleted' });
    writeFileSync(join(w.memory, '-mnt-p-a', 'memory', 'note.md'), 'Owner: always do X.\n');

    const other: Ctx = { ...w.ctx, identity: { harness: 'claude-code', session: 's1', origin: 'agent-inferred' } };
    createEntry(other, { kind: 'rule', title: 'Do W', scope: 'global' });
    expect(fullPassNeeded(w.home, w.memory)).toEqual({ needed: true, reason: '1 entry change by other sessions' });
  });

  it('keeps asking for a run after a failed one', async () => {
    const w = world({ exit: 2 });
    await bosunFull(w.ctx, { runner: 'pi', model: 'm', memoryRoot: w.memory, timeoutMinutes: 1, env: w.env });
    expect(fullPassNeeded(w.home, w.memory).needed).toBe(true);
  });
});

describe('lb bosun --full', () => {
  const lb = (args: string[], env: NodeJS.ProcessEnv) => run(args, env, tempDir('lb-cwd-'));

  describe('with an agent', () => {
    beforeAll(requireBuild);

    it('runs a full pass, prints the summary, and exits 0', async () => {
      const w = world();
      const result = await lb(['bosun', '--full', '--runner', 'pi', '--model', 'm', '--memory-root', w.memory], { ...w.env, LEEBOARD_HOME: w.home });
      expect(result.stderr).toBe('');
      expect(result.code).toBe(0);
      expect(result.stdout).toMatch(/^Bosun full pass bosun-\d{8}T\d{6}Z \(pi m\): clean/);
      expect(result.stdout).toContain('Report: ');
    });

    it('with --if-changed, skips the agent when nothing is new but still runs the quick pass', async () => {
      const w = world();
      const env = { ...w.env, LEEBOARD_HOME: w.home };
      const args = ['bosun', '--full', '--if-changed', '--runner', 'pi', '--model', 'm', '--memory-root', w.memory];
      expect((await lb(args, env)).code).toBe(0);
      expect(w.calls()).toHaveLength(1);
      const second = await lb(args, env);
      expect(second.code).toBe(0);
      expect(second.stdout).toMatch(/^Bosun full pass skipped: nothing new since bosun-\d{8}T\d{6}Z\n/);
      expect(w.calls()).toHaveLength(1);
    });

    it('prints JSON with --json, and exits 1 when the agent fails', async () => {
      const w = world({ exit: 4 });
      const result = await lb(['bosun', '--full', '--runner', 'claude', '--model', 'm', '--memory-root', w.memory, '--json'], { ...w.env, LEEBOARD_HOME: w.home });
      expect(result.code).toBe(1);
      const data = JSON.parse(result.stdout);
      expect(data.clean).toBe(false);
      expect(data.run.exit.code).toBe(4);
      expect(result.stderr).toContain('did not finish cleanly');
    });
  });

  it('with --if-changed, skips an idle pass as JSON without needing a runner, after the quick pass', async () => {
    const w = world();
    mkdirSync(join(w.home, 'state', 'bosun'), { recursive: true });
    writeFileSync(join(w.home, 'state', 'bosun', 'last-clean.json'), JSON.stringify({ runId: RUN, logOffset: logSize(w.home) }));
    writeWatermark(w.home, { '-mnt-p-a/memory/note.md': sha('Owner: always do X.\n') });
    const result = await lb(['bosun', '--full', '--if-changed', '--json', '--memory-root', w.memory], { ...w.env, LEEBOARD_HOME: w.home });
    expect(result).toMatchObject({ code: 0, stderr: '' });
    expect(JSON.parse(result.stdout)).toMatchObject({ skipped: true, reason: `nothing new since ${RUN}`, quick: { expired: [{ id: 'hold-lapsed-0002' }] } });
    expect(findEntry(w.home, 'hold-lapsed-0002').status).toBe('expired');
    expect(existsSync(join(w.home, 'state', 'bosun', RUN))).toBe(false);
  });

  it('needs --runner and --model, and does not combine with --dry-run', async () => {
    const w = world();
    const env = { ...w.env, LEEBOARD_HOME: w.home };
    expect(await lb(['bosun', '--full', '--model', 'm', '--memory-root', w.memory], env)).toMatchObject({ code: 1, stderr: expect.stringContaining('--runner') });
    expect(await lb(['bosun', '--full', '--runner', 'pi', '--memory-root', w.memory], env)).toMatchObject({ code: 1, stderr: expect.stringContaining('--model') });
    expect(await lb(['bosun', '--full', '--dry-run', '--runner', 'pi', '--model', 'm'], env)).toMatchObject({ code: 1, stderr: expect.stringContaining('--dry-run') });
    expect(await lb(['bosun', '--full', '--runner', 'pi', '--model', 'm', '--timeout', 'soon', '--memory-root', w.memory], env)).toMatchObject({ code: 1, stderr: expect.stringContaining('--timeout') });
    expect(await lb(['bosun', '--full', '--runner', 'pi', '--model', 'm', '--timeout', '0', '--memory-root', w.memory], env)).toMatchObject({ code: 1, stderr: expect.stringContaining('--timeout') });
    // A bad timeout is reported before a bad identity.
    expect(await lb(['bosun', '--full', '--harness', 'nobody', '--timeout', 'soon'], env)).toMatchObject({ code: 1, stderr: expect.stringContaining('--timeout') });
    expect(await lb(['bosun', '--full', '--harness', 'nobody', '--model', 'm'], env)).toMatchObject({ code: 1, stderr: expect.stringContaining("unknown harness 'nobody'") });
    expect(existsSync(join(w.home, 'state', 'bosun'))).toBe(false);
  });

  it('keeps the full-pass code out of the hot path: the built CLI only imports it lazily', () => {
    requireBuild();
    const bin = readFileSync(CLI, 'utf8');
    expect(bin).toContain("from './run.js'");
    expect(bin).not.toMatch(/^import[^;]*(bosun-full|\/bosun\/)/m);
    const source = readFileSync(join(import.meta.dirname, '..', 'dist', 'run.js'), 'utf8');
    expect(source).not.toMatch(/^import[^;]*bosun-full/m);
    expect(source).not.toMatch(/^import[^;]*\/bosun\//m);
    expect(source).toContain("import('./commands/bosun-full.js')");
  });
});
