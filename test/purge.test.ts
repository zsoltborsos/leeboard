import { describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createEntry } from '../src/change.js';
import type { Ctx } from '../src/context.js';
import { summarize } from '../src/entry.js';
import { EXIT, LeeboardError } from '../src/errors.js';
import { purgeCommand, type PurgeFlags } from '../src/commands/purge.js';
import { initStore, scopeDir, writeEntry } from '../src/store.js';
import { lb, sampleEntry, tempDir } from './helpers.js';

const ME = { LEEBOARD_HARNESS: 'claude-code', LEEBOARD_SESSION: 'S1' };
const DAY = 86_400_000;
const daysAgo = (days: number) => new Date(Date.now() - days * DAY).toISOString().replace(/\.\d{3}Z$/, 'Z');

async function added(home: string, args: string[]): Promise<string> {
  const result = await lb(home, ['add', ...args, '--json'], { env: ME });
  expect(result.code).toBe(0);
  return JSON.parse(result.out).id as string;
}

function entryPath(home: string, scope: string, id: string): string {
  return join(scopeDir(home, scope), `${id}.md`);
}

function logLines(home: string): { id: string; event: string; status: string }[] {
  return readFileSync(join(home, 'log.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
}

describe('purge command results', () => {
  function world(): Ctx {
    const home = tempDir();
    initStore(home);
    return { home, cwd: tempDir(), now: new Date('2026-10-18T10:00:00Z'),
      identity: { harness: 'claude-code', session: 'S1', origin: 'user-stated' } };
  }

  it.each([
    { json: false, dryRun: false }, { json: true, dryRun: false },
    { json: false, dryRun: true }, { json: true, dryRun: true },
  ])('owns id-based output and effects (%j)', (flags) => {
    const ctx = world();
    const entry = createEntry(ctx, { kind: 'rule', title: 'Remove me', scope: 'global' });
    const path = entryPath(ctx.home, 'global', entry.id);
    const bytes = readFileSync(path);
    const logPath = join(ctx.home, 'log.jsonl');
    const log = readFileSync(logPath, 'utf8');
    const resolve = vi.fn(() => ctx);
    expect(purgeCommand(resolve, [entry.id], flags)).toEqual({
      code: 0, stderr: '',
      stdout: flags.json
        ? JSON.stringify({ dryRun: flags.dryRun, purged: [summarize(entry)], kept: [] }) + '\n'
        : `${flags.dryRun ? 'would purge' : 'purged'} 1 entry\n- [${entry.id}] active global: Remove me\n`,
    });
    expect(resolve).toHaveBeenCalledTimes(1);
    if (flags.dryRun) {
      expect(readFileSync(path)).toEqual(bytes);
      expect(readFileSync(logPath, 'utf8')).toBe(log);
    } else {
      expect(existsSync(path)).toBe(false);
      const lines = logLines(ctx.home);
      expect(lines).toHaveLength(2);
      expect(lines[1]).toMatchObject({ id: entry.id, event: 'purged', status: 'active' });
      expect(readFileSync(logPath, 'utf8').startsWith(log)).toBe(true);
    }
  });

  it.each([
    { json: false, days: undefined }, { json: true, days: undefined },
    { json: false, days: '0' }, { json: true, days: '0' },
  ])('selects closed entries with default retention or explicit zero (%j)', ({ json, days }) => {
    const ctx = world();
    const old = sampleEntry({ id: 'rule-old-0001', title: 'Old', status: 'revoked', updated: '2026-09-01T10:00:00Z' });
    // Global is scanned before machine, independently of directory enumeration order.
    const recent = sampleEntry({ id: 'rule-recent-0002', scope: 'machine', title: 'Recent', status: 'revoked', updated: '2026-10-17T10:00:00Z' });
    const active = sampleEntry({ id: 'rule-active-0003', title: 'Active' });
    for (const entry of [old, recent, active]) writeEntry(ctx.home, entry);
    const chosen = days === undefined ? [old] : [old, recent];
    const text = `purged ${chosen.length} ${chosen.length === 1 ? 'entry' : 'entries'}\n` +
      chosen.map((entry) => `- [${entry.id}] revoked ${entry.scope}: ${entry.title}\n`).join('');
    expect(purgeCommand(() => ctx, [], { closed: true, days, json })).toEqual({
      code: 0, stdout: json ? JSON.stringify({ dryRun: false, purged: chosen.map(summarize), kept: [] }) + '\n' : text, stderr: '',
    });
    expect(existsSync(entryPath(ctx.home, 'global', old.id))).toBe(false);
    expect(existsSync(entryPath(ctx.home, 'machine', recent.id))).toBe(days === undefined);
    expect(existsSync(entryPath(ctx.home, 'global', active.id))).toBe(true);
    expect(logLines(ctx.home).map(({ id, event }) => ({ id, event }))).toEqual(chosen.map(({ id }) => ({ id, event: 'purged' })));
  });

  it.each([false, true])('returns the nonempty zero-selection result (json=%s)', (json) => {
    const ctx = world();
    expect(purgeCommand(() => ctx, [], { closed: true, json })).toEqual({
      code: 0, stdout: json ? '{"dryRun":false,"purged":[],"kept":[]}\n' : 'purged 0 entries\n', stderr: '',
    });
  });

  const usage = 'usage: lb purge <id>... | lb purge --closed [--days <n>]';
  const badDays = '--days must be a whole number of days, 0 or more';
  const invalid: { ids: string[]; flags: PurgeFlags; args: string[]; message: string }[] = [
    { ids: [], flags: {}, args: [], message: usage },
    { ids: ['some-id'], flags: { closed: true }, args: ['some-id', '--closed'], message: usage },
    { ids: ['some-id'], flags: { days: '3' }, args: ['some-id', '--days', '3'], message: '--days goes with --closed' },
    { ids: [], flags: { days: '3' }, args: ['--days', '3'], message: usage },
    ...['x', '-1', '1.5', 'Infinity'].map((days) => ({
      ids: [], flags: { closed: true, days }, args: ['--closed', `--days=${days}`], message: badDays,
    })),
  ];

  it.each(invalid)('validates before context resolution: $args', async ({ ids, flags, args, message }) => {
    const resolve = vi.fn(() => { throw new Error('identity must not be resolved'); });
    expect(() => purgeCommand(resolve, ids, flags)).toThrow(LeeboardError);
    expect(() => purgeCommand(resolve, ids, flags)).toThrow(expect.objectContaining({ message, exitCode: EXIT.USAGE }));
    expect(resolve).not.toHaveBeenCalled();
    expect(await lb(tempDir(), ['purge', ...args], { env: ME })).toEqual({ code: 1, out: '', err: `lb: ${message}\n` });
  });

  it('preserves purge flag errors before identity errors, but resolves identity for valid flags', async () => {
    const ctx = world();
    const entry = createEntry(ctx, { kind: 'rule', title: 'Keep me' });
    const log = readFileSync(join(ctx.home, 'log.jsonl'));
    expect(await lb(ctx.home, ['purge', '--harness', 'nobody'])).toEqual({
      code: 1, out: '', err: `lb: ${usage}\n`,
    });
    expect(await lb(ctx.home, ['purge', entry.id, '--harness', 'nobody'])).toEqual({
      code: 1, out: '', err: "lb: unknown harness 'nobody' (use claude-code, pi, helmraiser, funkyoctopus, bosun, user)\n",
    });
    expect(existsSync(entryPath(ctx.home, entry.scope, entry.id))).toBe(true);
    expect(readFileSync(join(ctx.home, 'log.jsonl'))).toEqual(log);
  });
});

describe('lb purge <id>', () => {
  it('removes the entry file and its revisions, and logs one purged line', async () => {
    const home = tempDir();
    const id = await added(home, ['rule', '--title', 'Use the old tool', '--scope', 'global']);
    expect((await lb(home, ['revise', id, '--title', 'Use the old tool, really'], { env: ME })).code).toBe(0);
    expect(existsSync(join(home, 'revisions', `${id}.jsonl`))).toBe(true);

    const result = await lb(home, ['purge', id.slice(0, 12)], { env: ME });
    expect(result).toEqual({ code: 0, err: '', out: `purged 1 entry\n- [${id}] active global: Use the old tool, really\n` });
    expect(existsSync(entryPath(home, 'global', id))).toBe(false);
    expect(existsSync(join(home, 'revisions', `${id}.jsonl`))).toBe(false);
    expect(logLines(home).at(-1)).toMatchObject({ id, event: 'purged', status: 'active' });
    expect((await lb(home, ['show', id])).code).toBe(EXIT.UNKNOWN_ID);
    expect((await lb(home, ['list', '--all'])).out).toBe('');
  });

  it('drops the id from other entries\' supersedes lists', async () => {
    const home = tempDir();
    const old = await added(home, ['rule', '--title', 'Old wording', '--scope', 'global']);
    const replacement = await added(home, ['rule', '--title', 'New wording', '--scope', 'global']);
    expect((await lb(home, ['supersede', old, '--by', replacement], { env: ME })).code).toBe(0);
    expect(readFileSync(entryPath(home, 'global', replacement), 'utf8')).toContain(old);

    expect((await lb(home, ['purge', old], { env: ME })).code).toBe(0);
    const text = readFileSync(entryPath(home, 'global', replacement), 'utf8');
    expect(text).not.toContain(old);
    expect(text).not.toContain('supersedes');
    expect(logLines(home).filter((line) => line.id === replacement).at(-1)).toMatchObject({ event: 'updated' });
  });

  it('refuses an id an active entry still cites, changing nothing', async () => {
    const home = tempDir();
    const cited = await added(home, ['reference', '--title', 'The server is box-1', '--scope', 'machine']);
    await added(home, ['rule', '--title', 'Back up first', '--body', `See ${cited}.`, '--scope', 'global']);
    const before = readFileSync(join(home, 'log.jsonl'), 'utf8');

    const result = await lb(home, ['purge', cited], { env: ME });
    expect(result.code).toBe(EXIT.BAD_TRANSITION);
    expect(result.err).toContain(`${cited} is cited by rule-back-up-first`);
    expect(existsSync(entryPath(home, 'machine', cited))).toBe(true);
    expect(readFileSync(join(home, 'log.jsonl'), 'utf8')).toBe(before);
  });

  it('purges entries that cite each other in one call', async () => {
    const home = tempDir();
    const a = await added(home, ['reference', '--title', 'Retired tool lives here', '--scope', 'machine']);
    const b = await added(home, ['rule', '--title', 'Start the retired tool', '--body', `It lives at ${a}.`, '--scope', 'global']);
    expect((await lb(home, ['purge', a, b], { env: ME })).code).toBe(0);
    expect((await lb(home, ['list', '--all'])).out).toBe('');
  });

  it('changes nothing on a dry run', async () => {
    const home = tempDir();
    const id = await added(home, ['rule', '--title', 'Keep me for now', '--scope', 'global']);
    const before = readFileSync(join(home, 'log.jsonl'), 'utf8');
    expect((await lb(home, ['purge', id, '--dry-run'], { env: ME })).out).toBe(`would purge 1 entry\n- [${id}] active global: Keep me for now\n`);
    expect(existsSync(entryPath(home, 'global', id))).toBe(true);
    expect(readFileSync(join(home, 'log.jsonl'), 'utf8')).toBe(before);
  });

  it('is not permitted to Bosun or Helmraiser', async () => {
    const home = tempDir();
    const id = await added(home, ['rule', '--title', 'Never delete me', '--scope', 'global']);
    for (const harness of ['bosun', 'helmraiser']) {
      const result = await lb(home, ['purge', id], { env: { LEEBOARD_HARNESS: harness, LEEBOARD_SESSION: 'run-1' } });
      expect(result.code).toBe(EXIT.NOT_PERMITTED);
    }
    expect(existsSync(entryPath(home, 'global', id))).toBe(true);
  });

  it('leaves review and delta without the purged entry', async () => {
    const home = tempDir();
    const id = await added(home, ['rule', '--title', 'Gone soon', '--scope', 'global']);
    expect((await lb(home, ['purge', id], { env: ME })).code).toBe(0);
    expect((await lb(home, ['review', '--peek'])).out).not.toContain(id);
    const delta = await lb(home, ['delta'], { env: { ...ME, LEEBOARD_SESSION: 'S2' } });
    expect(delta.code).toBe(0);
    expect(delta.out).not.toContain(id);
  });
});

describe('lb purge --closed', () => {
  function closedStore() {
    const home = tempDir();
    writeEntry(home, sampleEntry({ id: 'rule-old-closed-0001', status: 'revoked', title: 'Old revoked', updated: daysAgo(40) }));
    writeEntry(home, sampleEntry({ id: 'rule-recent-closed-0002', status: 'superseded', title: 'Recently superseded', updated: daysAgo(5) }));
    writeEntry(home, sampleEntry({ id: 'rule-old-active-0003', title: 'Old but active', updated: daysAgo(90) }));
    writeEntry(home, sampleEntry({ id: 'reference-old-cited-0004', kind: 'reference', status: 'revoked', title: 'Old cited', updated: daysAgo(40) }));
    writeEntry(home, sampleEntry({ id: 'rule-citer-0005', title: 'Cites an old one', body: 'Was reference-old-cited-0004.\n', updated: daysAgo(1) }));
    return home;
  }

  it('purges entries closed more than 30 days ago and keeps the rest, naming the cited ones', async () => {
    const home = closedStore();
    const result = await lb(home, ['purge', '--closed'], { env: ME });
    expect(result.code).toBe(0);
    expect(result.out).toBe(
      'purged 1 entry\n' +
      '- [rule-old-closed-0001] revoked global: Old revoked\n' +
      'kept 1 closed entry still cited by active ones:\n' +
      '- [reference-old-cited-0004] kept: cited by rule-citer-0005\n',
    );
    expect((await lb(home, ['list', '--all'])).out.match(/^- \[[^\]]+/gm)).toEqual([
      '- [rule-citer-0005',
      '- [rule-recent-closed-0002',
      '- [reference-old-cited-0004',
      '- [rule-old-active-0003',
    ]);
  });

  it('takes --days, including 0 for every closed entry', async () => {
    const home = closedStore();
    const result = await lb(home, ['purge', '--closed', '--days', '0', '--json'], { env: ME });
    expect(JSON.parse(result.out).purged.map((item: { id: string }) => item.id).sort()).toEqual(['rule-old-closed-0001', 'rule-recent-closed-0002']);
  });

  it('rejects malformed calls', async () => {
    const home = closedStore();
    for (const args of [['purge'], ['purge', 'rule-old', '--closed'], ['purge', 'rule-old', '--days', '3'], ['purge', '--closed', '--days', 'x'], ['purge', '--closed', '--days', '-1']]) {
      expect((await lb(home, args, { env: ME })).code).toBe(EXIT.USAGE);
    }
  });
});

describe('list and search --all on the CLI', () => {
  it('shows closed entries only with --all', async () => {
    const home = tempDir();
    writeEntry(home, sampleEntry({ id: 'rule-live-0001', title: 'Live rule' }));
    writeEntry(home, sampleEntry({ id: 'rule-dead-0002', status: 'revoked', title: 'Dead rule' }));
    expect((await lb(home, ['list'])).out).toBe('- [rule-live-0001] active global: Live rule\n');
    expect((await lb(home, ['list', '--all'])).out).toContain('rule-dead-0002');
    expect((await lb(home, ['search', 'rule'])).out).toBe('- [rule-live-0001] active global: Live rule\n');
    expect((await lb(home, ['search', 'dead', '--all'])).out).toBe('- [rule-dead-0002] revoked global: Dead rule\n');
  });
});
