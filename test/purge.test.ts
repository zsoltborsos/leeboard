import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EXIT } from '../src/errors.js';
import { scopeDir, writeEntry } from '../src/store.js';
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
