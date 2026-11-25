import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { briefCommand, brief, renderBrief, type BriefData } from '../src/commands/brief.js';
import { check, checkCommand } from '../src/commands/check.js';
import { usage, usageCommand, renderUsage } from '../src/commands/usage.js';
import { createEntry } from '../src/change.js';
import type { Ctx } from '../src/context.js';
import type { Entry } from '../src/entry.js';
import { EXIT, LeeboardError } from '../src/errors.js';
import { logSize, readCursor } from '../src/log.js';
import { addProject } from '../src/projects.js';
import { scopeDir, writeEntry } from '../src/store.js';
import {
  appendUsage,
  readUsage,
  summarizeUsage,
  type BriefUsageLine,
  type CheckUsageLine,
  type UsageLine,
} from '../src/usage.js';
import { lb, makeRepo, sampleEntry, tempDir } from './helpers.js';

function ctxFor(home: string, cwd: string, session: string | null = 'A', harness: Ctx['identity']['harness'] = 'pi'): Ctx {
  return { home, cwd, now: new Date('2026-10-17T12:00:00Z'), identity: { harness, session, origin: 'agent-inferred' } };
}

function usagePath(home: string): string {
  return join(home, 'state', 'usage.jsonl');
}

/** Raw parsed records, bypassing the reader under test. */
function rawLines(home: string): any[] {
  return readFileSync(usagePath(home), 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line));
}

describe('usage writer', () => {
  it('writes every field for a brief record, with identity and project', () => {
    const home = tempDir();
    appendUsage(ctxFor(home, '/work/x', 'A', 'pi'), 'P', { command: 'brief', entries: 3, chars: 42 });
    expect(rawLines(home)).toEqual([
      {
        ts: '2026-10-17T12:00:00Z',
        command: 'brief',
        harness: 'pi',
        session: 'A',
        project: 'P',
        cwd: '/work/x',
        entries: 3,
        chars: 42,
      },
    ]);
  });

  it('writes every field for a check record, with null identity and project', () => {
    const home = tempDir();
    appendUsage(ctxFor(home, '/work/y', null, null), null, { command: 'check', tag: 'push', blocked: true });
    expect(rawLines(home)).toEqual([
      {
        ts: '2026-10-17T12:00:00Z',
        command: 'check',
        harness: null,
        session: null,
        project: null,
        cwd: '/work/y',
        tag: 'push',
        blocked: true,
      },
    ]);
  });

  it('appends: a second write keeps the first record', () => {
    const home = tempDir();
    const ctx = ctxFor(home, '/work/x');
    appendUsage(ctx, 'P', { command: 'brief', entries: 1, chars: 10 });
    appendUsage(ctx, 'P', { command: 'check', tag: 'merge', blocked: false });
    const records = rawLines(home);
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({ command: 'brief', entries: 1, chars: 10 });
    expect(records[1]).toMatchObject({ command: 'check', tag: 'merge', blocked: false });
  });

  it('creates state/ lazily', () => {
    const home = tempDir();
    expect(existsSync(join(home, 'state'))).toBe(false);
    appendUsage(ctxFor(home, '/work/x'), null, { command: 'brief', entries: 0, chars: 0 });
    expect(existsSync(join(home, 'state'))).toBe(true);
    expect(existsSync(usagePath(home))).toBe(true);
  });

  it('shortens a long multibyte cwd to a valid JSON line under 4 KB with a final newline', () => {
    const home = tempDir();
    const cwd = 'dir-é/sub-'.repeat(2000);
    appendUsage(ctxFor(home, cwd), 'P', { command: 'brief', entries: 0, chars: 0 });
    const text = readFileSync(usagePath(home), 'utf8');
    expect(text.endsWith('\n')).toBe(true);
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThan(4096);
    const record = JSON.parse(text.trimEnd());
    expect(cwd.startsWith(record.cwd)).toBe(true);
    expect(record.cwd.length).toBeGreaterThan(0);
    expect(record.cwd.length).toBeLessThan(cwd.length);
  });

  it('silently skips credential-like text without persisting anything', () => {
    const home = tempDir();
    expect(() => appendUsage(ctxFor(home, `ghp_${'a1b2c3d4e5'.repeat(3)}`), null, { command: 'brief', entries: 0, chars: 0 })).not.toThrow();
    expect(existsSync(usagePath(home))).toBe(false);
  });

  it('swallows a directory-creation failure when state is a regular file', () => {
    const home = tempDir();
    writeFileSync(join(home, 'state'), 'not a directory');
    expect(() => appendUsage(ctxFor(home, '/work/x'), null, { command: 'brief', entries: 0, chars: 0 })).not.toThrow();
    expect(readFileSync(join(home, 'state'), 'utf8')).toBe('not a directory');
  });

  it('swallows an append failure when usage.jsonl is a directory', () => {
    const home = tempDir();
    mkdirSync(usagePath(home), { recursive: true });
    expect(() => appendUsage(ctxFor(home, '/work/x'), null, { command: 'check', tag: 'x', blocked: false })).not.toThrow();
  });

  it('skips a record whose non-cwd field cannot fit even with an empty cwd', () => {
    const home = tempDir();
    appendUsage(ctxFor(home, '/work/x'), null, { command: 'check', tag: 'x'.repeat(5000), blocked: false });
    expect(existsSync(usagePath(home))).toBe(false);
  });

  it('keeps the reader-facing union type usable', () => {
    const sample: UsageLine = {
      ts: '2026-10-17T12:00:00Z',
      command: 'brief',
      harness: null,
      session: null,
      project: null,
      cwd: '/w',
      entries: 0,
      chars: 0,
    };
    expect(sample.command).toBe('brief');
  });
});

function projectWorld() {
  const home = tempDir();
  const repo = makeRepo();
  addProject(home, { name: 'P', paths: [repo] });
  return { home, repo };
}

describe('brief and check recording', () => {
  it('records one brief per invocation, empty and populated', () => {
    const { home, repo } = projectWorld();
    const ctx = ctxFor(home, repo);

    const empty = briefCommand(ctx, {});
    expect(readUsage(home)).toHaveLength(1);
    expect(empty).toMatchObject({ code: 0, stderr: '' });
    expect(readUsage(home)[0]).toMatchObject({ command: 'brief', project: 'P', entries: 0, chars: empty.stdout.length });

    createEntry(ctx, { kind: 'rule', title: 'A rule' });
    const populated = briefCommand(ctx, {});
    const records = readUsage(home);
    expect(records).toHaveLength(2);
    expect(populated).toMatchObject({ code: 0, stderr: '' });
    expect(records[1]).toMatchObject({ command: 'brief', project: 'P', entries: 1, chars: populated.stdout.length });
  });

  it('records rendered size and count exactly once in JSON mode', () => {
    const { home, repo } = projectWorld();
    const ctx = ctxFor(home, repo);
    createEntry(ctx, { kind: 'rule', title: 'JSON brief' });
    const result = briefCommand(ctx, { json: true });
    expect(result).toMatchObject({ code: 0, stderr: '' });
    const data = JSON.parse(result.stdout) as BriefData;
    expect(data).toEqual(brief(ctx));
    const text = renderBrief(data);
    expect(result.stdout).toBe(JSON.stringify(data) + '\n');
    expect(result.stdout.length).not.toBe(text.length);
    expect(readUsage(home)).toEqual([expect.objectContaining({ command: 'brief', entries: 1, chars: text.length })]);
  });

  it('records the resolved project, and null outside a registered project', () => {
    const { home, repo } = projectWorld();
    briefCommand(ctxFor(home, repo), {});
    expect(readUsage(home)[0]).toMatchObject({ project: 'P' });

    const loose = tempDir();
    briefCommand(ctxFor(loose, tempDir()), {});
    expect(readUsage(loose)[0]).toMatchObject({ project: null });
  });

  it('counts only rendered entry bullets, not every gathered entry, and chars matches the text', () => {
    const { home, repo } = projectWorld();
    const ctx = ctxFor(home, repo);
    const put = (overrides: Partial<Entry>): Entry => {
      const entry = sampleEntry({ created: '2026-10-17T10:00:00Z', updated: '2026-10-17T10:00:00Z', ...overrides });
      writeEntry(home, entry);
      return entry;
    };
    put({ id: 'hold-no-runs-0001', kind: 'hold', title: 'No Helmraiser runs', release: 'told', blocks: ['helmraiser-run'] });
    for (let i = 0; i < 150; i++) {
      put({ id: `rule-number-${String(i).padStart(4, '0')}`, kind: 'rule', title: `Rule number ${i} with a reasonably descriptive title` });
    }

    const result = briefCommand(ctx, {});
    expect(result).toMatchObject({ code: 0, stderr: '' });
    expect(result.stdout).toBe(renderBrief(brief(ctx)));
    expect(result.stdout.length).toBeLessThanOrEqual(8000);
    const visible = (result.stdout.match(/^- \[/gm) ?? []).length;
    expect(visible).toBeGreaterThan(0);
    expect(visible).toBeLessThan(151);
    const record = readUsage(home).at(-1)!;
    expect(record).toMatchObject({ command: 'brief', entries: visible, chars: result.stdout.length });
  });

  it('records a clear check and a blocked check with the tag and boolean', () => {
    const { home, repo } = projectWorld();
    const ctx = ctxFor(home, repo);

    const clear = checkCommand(ctx, { tag: 'deploy', json: true });
    expect(clear.code).toBe(0);
    expect(clear.stderr).toBe('');
    expect(JSON.parse(clear.stdout)).toEqual([]);
    expect(readUsage(home)).toHaveLength(1);
    expect(readUsage(home)[0]).toMatchObject({ command: 'check', tag: 'deploy', blocked: false, project: 'P' });

    const hold = createEntry(ctx, { kind: 'hold', title: 'No deploys', release: 'r', blocks: ['deploy'] });
    const blocked = checkCommand(ctx, { tag: 'deploy', json: true });
    expect(blocked.code).toBe(3);
    expect(blocked.stderr).toBe('');
    expect(JSON.parse(blocked.stdout)).toEqual([expect.objectContaining({ id: hold.id })]);
    const records = readUsage(home);
    expect(records).toHaveLength(2);
    expect(records[1]).toMatchObject({ command: 'check', tag: 'deploy', blocked: true });

    const otherTag = checkCommand(ctx, { tag: 'helmraiser-run', json: true });
    expect(otherTag.code).toBe(0);
    expect(otherTag.stderr).toBe('');
    expect(JSON.parse(otherTag.stdout)).toEqual([]);
    expect(readUsage(home).at(-1)).toMatchObject({ command: 'check', tag: 'helmraiser-run', blocked: false });
  });

  it('records an unreadable-only check as blocked, exactly once', () => {
    const { home, repo } = projectWorld();
    const dir = scopeDir(home, 'global');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'hold-broken.md');
    writeFileSync(path, 'broken');
    const result = checkCommand(ctxFor(home, repo), { tag: 'push', json: true });
    expect(result.code).toBe(3);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual([{
      id: 'hold-broken', kind: 'hold',
      title: `Unreadable hold file: ${path} — could not be parsed: entry has no frontmatter`,
      release: 'fix or remove this file', unreadable: true,
    }]);
    expect(readUsage(home)).toEqual([expect.objectContaining({ command: 'check', tag: 'push', blocked: true })]);
  });

  it('still rejects a blank tag, without recording', () => {
    const { home, repo } = projectWorld();
    expect(() => checkCommand(ctxFor(home, repo), { tag: ' ', json: false })).toThrow(LeeboardError);
    try {
      checkCommand(ctxFor(home, repo), { tag: '', json: false });
    } catch (error) {
      expect((error as LeeboardError).exitCode).toBe(EXIT.USAGE);
    }
    expect(readUsage(home)).toEqual([]);
  });

  it.each([false, true])('leaves brief data/text and check result unchanged when the usage log is unusable (json=%s)', (json) => {
    const { home, repo } = projectWorld();
    const ctx = ctxFor(home, repo);
    createEntry(ctx, { kind: 'hold', title: 'No deploys', release: 'r', blocks: ['deploy'] });

    const firstData = brief(ctx);
    const firstBrief = briefCommand(ctx, { json });
    const firstCheck = checkCommand(ctx, { tag: 'deploy', json: false });
    rmSync(join(home, 'state', 'usage.jsonl'), { force: true });
    mkdirSync(join(home, 'state', 'usage.jsonl'), { recursive: true });

    const secondBrief = briefCommand(ctx, { json });
    const secondCheck = checkCommand(ctx, { tag: 'deploy', json: false });
    expect(firstBrief).toMatchObject({ code: 0, stderr: '' });
    expect(secondBrief).toEqual(firstBrief);
    expect(brief(ctx)).toEqual(firstData);
    if (json) expect(JSON.parse(secondBrief.stdout)).toEqual(firstData);
    else expect(secondBrief.stdout).toBe(renderBrief(firstData));
    expect(secondCheck).toEqual(firstCheck);
  });

  it('does not change the change log or cursor behavior', () => {
    const { home, repo } = projectWorld();
    const ctx = ctxFor(home, repo, 'A', 'pi');
    createEntry(ctx, { kind: 'rule', title: 'X' });
    const before = logSize(home);
    briefCommand(ctx, {});
    expect(logSize(home)).toBe(before);
    expect(readCursor(home, 'A')).toBe(before);
  });

  it('keeps direct brief() and check() free of telemetry, so querying without the CLI writes no state', () => {
    const home = tempDir();
    brief(ctxFor(home, tempDir(), null, null));
    check(ctxFor(home, tempDir(), null, null), 'deploy');
    expect(existsSync(join(home, 'state'))).toBe(false);
  });
});

function briefRecord(overrides: Partial<BriefUsageLine> = {}): BriefUsageLine {
  return { ts: '2026-10-17T12:00:00Z', command: 'brief', harness: 'pi', session: 'A', project: 'P', cwd: '/w', entries: 0, chars: 0, ...overrides };
}

function checkRecord(overrides: Partial<CheckUsageLine> = {}): CheckUsageLine {
  return { ts: '2026-10-17T12:00:00Z', command: 'check', harness: 'pi', session: 'A', project: 'P', cwd: '/w', tag: 'push', blocked: false, ...overrides };
}

function seed(home: string, records: UsageLine[]): void {
  mkdirSync(join(home, 'state'), { recursive: true });
  writeFileSync(usagePath(home), records.map((record) => JSON.stringify(record)).join('\n') + '\n');
}

const SINCE = new Date('2026-10-01T00:00:00Z');

function fixture(): UsageLine[] {
  return [
    briefRecord({ session: 'A', harness: 'pi', project: 'P' }),
    briefRecord({ session: 'A', harness: 'pi', project: 'P' }),
    briefRecord({ session: 'A', harness: 'claude-code', project: 'P' }),
    briefRecord({ session: 'B', harness: 'pi', project: null }),
    briefRecord({ session: null, harness: null, project: null }),
    checkRecord({ session: 'A', harness: 'pi', tag: 'push', blocked: true }),
    checkRecord({ session: 'A', harness: 'pi', tag: 'push', blocked: false }),
    checkRecord({ session: 'A', harness: 'claude-code', tag: 'merge', blocked: false }),
    checkRecord({ session: null, harness: null, tag: 'deploy', blocked: true }),
    briefRecord({ ts: '2026-09-01T00:00:00Z', session: 'Z', project: 'P' }),
  ];
}

describe('usage command results', () => {
  it('finishes the seeded report as text or one JSON line without writing', () => {
    const home = tempDir();
    seed(home, fixture());
    const before = readFileSync(usagePath(home));
    const report = usage(home, '2026-10-01');
    expect(usageCommand(home, { since: '2026-10-01' })).toEqual({ code: 0, stdout: renderUsage(report), stderr: '' });
    expect(usageCommand(home, { since: '2026-10-01', json: true })).toEqual({ code: 0, stdout: JSON.stringify(report) + '\n', stderr: '' });
    expect(readFileSync(usagePath(home))).toEqual(before);
  });

  it('preserves the exact cutoff error and creates no state for a missing log', () => {
    const home = tempDir();
    expect(() => usageCommand(home, { since: 'invalid' })).toThrow("invalid --since 'invalid' (use an ISO date or timestamp with timezone)");
    expect(usageCommand(home, { json: true })).toEqual({ code: 0, stdout: JSON.stringify(usage(home)) + '\n', stderr: '' });
    expect(existsSync(join(home, 'state'))).toBe(false);
  });
});

describe('usage report', () => {
  it('counts brief calls, sessions, anonymous and breakdowns with sample sizes', () => {
    const home = tempDir();
    seed(home, fixture());
    const report = summarizeUsage(readUsage(home), SINCE);
    expect(report.since).toBe('2026-10-01T00:00:00.000Z');
    expect(report.brief.calls).toEqual({ count: 5, n: 5, lowSample: true });
    expect(report.brief.sessions).toEqual({ count: 3, n: 4, lowSample: true });
    expect(report.brief.anonymous).toEqual({ count: 1, n: 5, lowSample: true });
    expect(report.brief.byHarness).toEqual([
      { harness: 'claude-code', sessions: { count: 1, n: 1, lowSample: true } },
      { harness: 'pi', sessions: { count: 2, n: 3, lowSample: true } },
    ]);
    expect(report.brief.byProject).toEqual([
      { project: null, calls: { count: 2, n: 2, lowSample: true } },
      { project: 'P', calls: { count: 3, n: 3, lowSample: true } },
    ]);
    expect(report.check.calls).toEqual({ count: 4, n: 4, lowSample: true });
    expect(report.check.blocked).toEqual({ count: 2, n: 4, lowSample: true });
    expect(report.check.sessions).toEqual({ count: 2, n: 3, lowSample: true });
    expect(report.check.anonymous).toEqual({ count: 1, n: 4, lowSample: true });
    expect(report.check.byTag).toEqual([
      { tag: 'deploy', calls: { count: 1, n: 1, lowSample: true } },
      { tag: 'merge', calls: { count: 1, n: 1, lowSample: true } },
      { tag: 'push', calls: { count: 2, n: 2, lowSample: true } },
    ]);
  });

  it('reports an empty all-zero report for a missing log, without creating state', () => {
    const home = tempDir();
    const report = usage(home);
    expect(report.since).toBeNull();
    expect(report.brief.calls).toEqual({ count: 0, n: 0, lowSample: true });
    expect(report.brief.sessions).toEqual({ count: 0, n: 0, lowSample: true });
    expect(report.brief.anonymous).toEqual({ count: 0, n: 0, lowSample: true });
    expect(report.brief.byHarness).toEqual([]);
    expect(report.brief.byProject).toEqual([]);
    expect(report.check.calls).toEqual({ count: 0, n: 0, lowSample: true });
    expect(report.check.byTag).toEqual([]);
    expect(existsSync(join(home, 'state'))).toBe(false);
  });

  it('includes a record exactly at the inclusive cutoff', () => {
    const home = tempDir();
    seed(home, [briefRecord({ ts: '2026-10-01T00:00:00Z' }), briefRecord({ ts: '2026-09-30T23:59:59Z' }), briefRecord({ ts: '2026-09-29T00:00:00Z' })]);
    expect(usage(home, '2026-10-01').brief.calls.count).toBe(1);
    expect(usage(home, '2026-09-30T23:59:59Z').brief.calls.count).toBe(2);
  });

  it('skips malformed and invalid-schema lines without hiding valid ones', () => {
    const home = tempDir();
    mkdirSync(join(home, 'state'), { recursive: true });
    const junk = [
      JSON.stringify(briefRecord()),
      'not json',
      '',
      JSON.stringify({ command: 'brief' }),
      JSON.stringify({ ...briefRecord(), ts: 'not a date' }),
      JSON.stringify({ ...briefRecord(), entries: -1 }),
      JSON.stringify({ ...briefRecord(), chars: 1.5 }),
      JSON.stringify({ ...checkRecord(), blocked: 'yes' }),
      JSON.stringify({ ...checkRecord(), tag: 7 }),
      JSON.stringify({ command: 'delta' }),
      JSON.stringify(checkRecord()),
    ];
    writeFileSync(usagePath(home), junk.join('\n') + '\n');
    expect(readUsage(home).map((record) => record.command)).toEqual(['brief', 'check']);
  });

  it('ignores a partial trailing record', () => {
    const home = tempDir();
    mkdirSync(join(home, 'state'), { recursive: true });
    writeFileSync(usagePath(home), JSON.stringify(briefRecord()) + '\n' + JSON.stringify(checkRecord()).slice(0, 20));
    expect(readUsage(home).map((record) => record.command)).toEqual(['brief']);
  });

  it('rejects non-ISO and invalid cutoffs, and normalizes accepted ones', () => {
    for (const bad of ['not-a-date', '2026-13-01', '2026-02-30', '2026-02-30T00:00:00Z', '2026-10-18T10:00:00', '10:00:00']) {
      try {
        usage(tempDir(), bad);
        throw new Error(`expected '${bad}' to be rejected`);
      } catch (error) {
        expect(error).toBeInstanceOf(LeeboardError);
        expect((error as LeeboardError).exitCode).toBe(EXIT.USAGE);
      }
    }
    expect(usage(tempDir(), '2026-10-18').since).toBe('2026-10-18T00:00:00.000Z');
    expect(usage(tempDir(), '2026-10-18T10:00Z').since).toBe('2026-10-18T10:00:00.000Z');
    expect(usage(tempDir(), '2026-10-18T10:00:00+02:00').since).toBe('2026-10-18T08:00:00.000Z');
  });

  it('renders null groups as (none), every sample size, and the low-sample flag', () => {
    const report = summarizeUsage(
      [briefRecord({ session: null, harness: null, project: null }), checkRecord({ session: null, harness: null, project: null, tag: 'deploy', blocked: true })],
      null,
    );
    const text = renderUsage(report);
    expect(text).toContain('(none)');
    expect(text).toContain('n=1');
    expect(text).toContain('(n<10)');
  });

  it('sets and clears lowSample at the 9/10 boundary', () => {
    expect(summarizeUsage(Array.from({ length: 9 }, () => briefRecord()), null).brief.calls).toEqual({ count: 9, n: 9, lowSample: true });
    expect(summarizeUsage(Array.from({ length: 10 }, () => briefRecord()), null).brief.calls).toEqual({ count: 10, n: 10, lowSample: false });
  });

  it('renders the same counts the structure carries', () => {
    const home = tempDir();
    seed(home, fixture());
    const report = summarizeUsage(readUsage(home), SINCE);
    const rendered = new Map(
      renderUsage(report)
        .trimEnd()
        .split('\n')
        .slice(1)
        .map((line) => line.trim().split(/\s{2,}/))
        .map(([command, metric, count]) => [`${command} / ${metric}`, Number(count)]),
    );
    expect(rendered.get('brief / calls')).toBe(report.brief.calls.count);
    expect(rendered.get('brief / sessions')).toBe(report.brief.sessions.count);
    expect(rendered.get('brief / anonymous')).toBe(report.brief.anonymous.count);
    expect(rendered.get('check / calls')).toBe(report.check.calls.count);
    expect(rendered.get('check / blocked')).toBe(report.check.blocked.count);
    expect(rendered.get('check / sessions')).toBe(report.check.sessions.count);
    expect(rendered.get('check / anonymous')).toBe(report.check.anonymous.count);
    for (const entry of report.brief.byProject) {
      expect(rendered.get(`brief / calls by project ${entry.project ?? '(none)'}`)).toBe(entry.calls.count);
    }
    for (const entry of report.check.byTag) {
      expect(rendered.get(`check / calls by tag ${entry.tag}`)).toBe(entry.calls.count);
    }
  });
});

describe('lb usage end to end', () => {
  it('reports the expected JSON for two sessions briefing and one blocked check', async () => {
    const { home, repo } = projectWorld();
    const a = { LEEBOARD_HARNESS: 'claude-code', LEEBOARD_SESSION: 'A' };
    const b = { LEEBOARD_HARNESS: 'pi', LEEBOARD_SESSION: 'B' };

    expect((await lb(home, ['brief'], { env: a, cwd: repo })).code).toBe(0);
    expect((await lb(home, ['brief'], { env: b, cwd: repo })).code).toBe(0);
    expect((await lb(home, ['check', '--blocks', 'deploy'], { env: b, cwd: repo })).code).toBe(0);
    expect((await lb(home, ['hold', '--title', 'No deploys', '--release', 'r', '--blocks', 'deploy'], { env: a, cwd: repo })).code).toBe(0);
    expect((await lb(home, ['check', '--blocks', 'deploy'], { env: b, cwd: repo })).code).toBe(3);

    const report = JSON.parse((await lb(home, ['usage', '--json'], { cwd: repo })).out);
    expect(report.brief.calls).toEqual({ count: 2, n: 2, lowSample: true });
    expect(report.brief.sessions).toEqual({ count: 2, n: 2, lowSample: true });
    expect(report.brief.anonymous).toEqual({ count: 0, n: 2, lowSample: true });
    expect(report.brief.byProject).toEqual([{ project: 'P', calls: { count: 2, n: 2, lowSample: true } }]);
    expect(report.check.calls).toEqual({ count: 2, n: 2, lowSample: true });
    expect(report.check.blocked).toEqual({ count: 1, n: 2, lowSample: true });
    expect(report.check.sessions).toEqual({ count: 1, n: 2, lowSample: true });
    expect(report.check.anonymous).toEqual({ count: 0, n: 2, lowSample: true });
    expect(report.check.byTag).toEqual([{ tag: 'deploy', calls: { count: 2, n: 2, lowSample: true } }]);

    const text = (await lb(home, ['usage'], { cwd: repo })).out;
    expect(text).toContain('sessions by harness claude-code');
    expect(text).toContain('sessions by harness pi');
    expect(text).toContain('calls by tag deploy');
  });
});
