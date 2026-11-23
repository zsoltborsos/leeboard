import { beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { findEntry, writeEntry } from '../src/store.js';
import { CLI, lb, requireBuild, sampleEntry, tempDir } from './helpers.js';

function world() {
  const home = tempDir();
  const entry = sampleEntry({ body: 'Original\n', release: 'Owner says so', blocks: ['push'], holder: 'owner', to: 'any', until: '2027-01-01' });
  writeEntry(home, entry);
  return { home, entry };
}

describe('lb revise', () => {
  it('returns text and summary JSON with the same id; show resolves after a move', async () => {
    const { home, entry } = world();
    const result = await lb(home, ['revise', entry.id, '--title', 'Tightened', '--scope', 'project:alpha']);
    expect(result).toMatchObject({ code: 0, err: '' });
    expect(result.out).toContain(`[${entry.id}] active project:alpha: Tightened`);
    const json = await lb(home, ['revise', entry.id, '--body', 'New body', '--json']);
    expect(json.code).toBe(0);
    expect(JSON.parse(json.out)).toMatchObject({ id: entry.id, title: 'Tightened', scope: 'project:alpha' });
    const shown = await lb(home, ['show', entry.id, '--json']);
    expect(shown.code).toBe(0);
    expect(JSON.parse(shown.out)).toMatchObject({ id: entry.id, body: 'New body\n', scope: 'project:alpha', author: entry.author, created: entry.created });
  });

  it('passes every supported option to persistence without changing attribution', async () => {
    const { home, entry } = world();
    const result = await lb(home, ['revise', entry.id, '--title', 'New', '--body', '', '--scope', 'machine', '--until', '2027-02-01', '--release', 'New release', '--blocks', 'merge, deploy', '--holder', 'next', '--to', 'session:next', '--harness', 'bosun', '--session', 'run']);
    expect(result).toMatchObject({ code: 0, err: '' });
    expect(findEntry(home, entry.id)).toMatchObject({ ...entry, title: 'New', body: '', scope: 'machine', until: '2027-02-01', release: 'New release', blocks: ['merge', 'deploy'], holder: 'next', to: 'session:next', updated: expect.any(String) });
  });

  it('preserves unspecified fields and allows empty blocks', async () => {
    const { home, entry } = world();
    expect((await lb(home, ['revise', entry.id, '--blocks', ''])).code).toBe(0);
    expect(findEntry(home, entry.id)).toEqual({ ...entry, blocks: [], updated: expect.any(String) });
  });

  it.each([
    ['revise'], ['revise', 'rule-sample-0001'],
    ['revise', 'rule-sample-0001', '--harness', 'pi', '--session', 'actor'],
    ...['kind', 'origin', 'status'].map((flag) => ['revise', 'rule-sample-0001', '--title', 'new', `--${flag}`, { kind: 'rule', origin: 'agent-inferred', status: 'active' }[flag]!]),
  ])('rejects usage: %j', async (...args) => {
    const { home, entry } = world();
    expect((await lb(home, args)).code).toBe(1);
    expect(findEntry(home, entry.id)).toEqual(entry);
  });

  it.each([
    [['missing', '--title', 'new'], 4],
    [['rule-sample-0001', '--title', 'ghp_' + 'abc123'.repeat(5)], 2],
    [['rule-sample-0001', '--title', 'new', '--harness', 'helmraiser', '--session', 'other'], 6],
    [['rule-sample-0001', '--title', 'new', '--harness', 'helmraiser', '--session', 'other'], 6],
  ] as const)('propagates exit code %s', async (args, code) => {
    const { home } = world();
    expect((await lb(home, ['revise', ...args])).code).toBe(code);
  });

  it('rejects inactive entries with exit 5', async () => {
    const { home, entry } = world();
    writeEntry(home, { ...entry, status: 'revoked' });
    expect((await lb(home, ['revise', entry.id, '--title', 'new'])).code).toBe(5);
  });

  it('advertises the complete command', async () => {
    const help = await lb(tempDir(), ['--help']);
    expect(help.out).toContain('lb revise <id> [--title <t>] [--body <text>|-] [--scope <s>] [--until <d>]');
    expect(help.out).toContain('[--release <t>] [--blocks a,b] [--holder <h>] [--to <target>]');
  });
});

describe('spawned lb revise stdin', () => {
  beforeAll(requireBuild);
  it('preserves multiline --body - input', () => {
    const { home, entry } = world();
    const result = spawnSync('node', [CLI, 'revise', entry.id, '--body', '-'], {
      cwd: tempDir(), env: { ...process.env, LEEBOARD_HOME: home }, encoding: 'utf8',
      input: 'line one\nline two\n',
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(findEntry(home, entry.id).body).toBe('line one\nline two\n');
  });
});
