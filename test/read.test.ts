import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { listCommand, renderList, searchEntries, showEntry } from '../src/commands/read.js';
import { parseEntry, serializeEntry } from '../src/entry.js';
import { EXIT, LeeboardError } from '../src/errors.js';
import { scopeDir, writeEntry } from '../src/store.js';
import { lb, sampleEntry, tempDir } from './helpers.js';

function failure(fn: () => unknown): LeeboardError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(LeeboardError);
    return error as LeeboardError;
  }
  throw new Error('expected a LeeboardError');
}

function store() {
  const home = tempDir();
  writeEntry(home, sampleEntry({ id: 'rule-pipefail-0001', title: 'Set pipefail before committing', body: 'tail returns its own status\n', updated: '2026-10-17T10:00:00Z' }));
  writeEntry(home, sampleEntry({ id: 'hold-tunnel-0002', kind: 'hold', scope: 'project:alpha', title: 'Tunnel is open', release: 'closed', updated: '2026-10-17T11:00:00Z' }));
  writeEntry(home, sampleEntry({ id: 'hold-old-0003', kind: 'hold', scope: 'project:alpha', status: 'released', title: 'Old hold', release: 'r', updated: '2026-10-16T11:00:00Z' }));
  writeEntry(home, sampleEntry({ id: 'reference-logs-0004', kind: 'reference', scope: 'machine', title: 'Logs live in /var/log', updated: '2026-10-15T11:00:00Z' }));
  return home;
}

describe('show', () => {
  it('returns the entry, found by prefix, and its file text', () => {
    const home = store();
    const entry = showEntry(home, 'rule-pipe');
    expect(entry.title).toBe('Set pipefail before committing');
    expect(serializeEntry(entry)).toContain('tail returns its own status');
  });

  it('exits 4 for an unknown id', () => {
    expect(failure(() => showEntry(store(), 'nope')).exitCode).toBe(EXIT.UNKNOWN_ID);
  });
});

describe('successor-aware show CLI', () => {
  const a = sampleEntry({ id: 'rule-a-0001', status: 'superseded', body: 'Original body without final newline' });
  const b = sampleEntry({ id: 'rule-b-0002', title: 'Replacement', supersedes: [a.id] });

  it('preserves active text and JSON exactly', async () => {
    const home = tempDir();
    writeEntry(home, b);
    expect(await lb(home, ['show', b.id])).toEqual({ code: 0, err: '', out: serializeEntry(b) });
    expect(JSON.parse((await lb(home, ['show', b.id, '--json'])).out)).toEqual(b);
  });

  it('names a direct successor without a redundant current line or persisting metadata', async () => {
    const home = tempDir();
    for (const entry of [a, b]) writeEntry(home, entry);
    const paths = [a, b].map((entry) => join(scopeDir(home, entry.scope), `${entry.id}.md`));
    const bytes = paths.map((path) => readFileSync(path));
    expect(await lb(home, ['show', 'rule-a'])).toEqual({
      code: 0, err: '', out: serializeEntry(a) + `\nSuperseded by: ${b.id} — ${b.title}\n`,
    });
    expect(JSON.parse((await lb(home, ['show', a.id, '--json'])).out)).toEqual({ ...a, supersededBy: [b.id], current: b.id, chainEnd: { id: b.id, status: 'active' } });
    expect(paths.map((path) => readFileSync(path))).toEqual(bytes);
  });

  it('names the current entry through several hops across scopes, preserving the body', async () => {
    const home = tempDir();
    const middle = { ...b, status: 'superseded' as const, scope: 'project:elsewhere' };
    const current = sampleEntry({ id: 'rule-c-0003', title: 'Current wording', scope: 'machine', supersedes: [b.id] });
    for (const entry of [a, middle, current]) writeEntry(home, entry);
    expect((await lb(home, ['show', a.id])).out).toBe(serializeEntry(a) +
      `\nSuperseded by: ${b.id} — ${b.title}\nCurrent: ${current.id} — ${current.title}\n`);
    expect(JSON.parse((await lb(home, ['show', a.id, '--json'])).out)).toMatchObject({
      current: current.id, chainEnd: { id: current.id, status: 'active' },
    });
  });

  it('names every direct successor', async () => {
    const home = tempDir();
    const other = sampleEntry({ id: 'rule-c-0003', title: 'Other replacement', supersedes: [a.id] });
    for (const entry of [a, b, other]) writeEntry(home, entry);
    expect((await lb(home, ['show', a.id])).out).toBe(serializeEntry(a) +
      `\nSuperseded by: ${b.id} — ${b.title}\nSuperseded by: ${other.id} — ${other.title}\n`);
    expect(JSON.parse((await lb(home, ['show', a.id, '--json'])).out)).toMatchObject({ supersededBy: [b.id, other.id], current: b.id });
  });

  it.each(['revoked', 'released', 'done', 'retired', 'expired'] as const)('explains a %s endpoint', async (status) => {
    const home = tempDir();
    for (const entry of [a, { ...b, status }]) writeEntry(home, entry);
    expect(await lb(home, ['show', a.id])).toEqual({ code: 0, err: '', out: serializeEntry(a) +
      `\nSuperseded by: ${b.id} — ${b.title}\nCurrent: none — chain ends at ${b.id} (${status})\n` });
    expect(JSON.parse((await lb(home, ['show', a.id, '--json'])).out)).toEqual({
      ...a, supersededBy: [b.id], current: null, chainEnd: { id: b.id, status },
    });
  });

  it('explicitly reports when no successor was found without changing the file', async () => {
    const home = tempDir();
    writeEntry(home, a);
    const path = join(scopeDir(home, a.scope), `${a.id}.md`);
    const bytes = readFileSync(path);
    expect(await lb(home, ['show', a.id])).toEqual({ code: 0, err: '', out: serializeEntry(a) + '\nSuperseded by: none found\n' });
    expect(JSON.parse((await lb(home, ['show', a.id, '--json'])).out)).toEqual({
      ...a, supersededBy: [], current: null, chainEnd: null,
    });
    expect(readFileSync(path)).toEqual(bytes);
  });

  it.each(['missing', 'cycle', 'self-cycle'] as const)('explains a %s chain without inventing a current entry', async (end) => {
    const home = tempDir();
    const old = end === 'cycle' ? { ...a, supersedes: [b.id] }
      : end === 'self-cycle' ? { ...a, supersedes: [a.id] } : a;
    const direct = end === 'self-cycle' ? old : { ...b, status: 'superseded' as const };
    const endpoint = end === 'missing' ? direct : old;
    const entries = end === 'self-cycle' ? [old] : [old, direct];
    for (const entry of entries) writeEntry(home, entry);
    const paths = entries.map((entry) => join(scopeDir(home, entry.scope), `${entry.id}.md`));
    const bytes = paths.map((path) => readFileSync(path));
    expect(await lb(home, ['show', a.id])).toEqual({ code: 0, err: '', out: serializeEntry(old) +
      `\nSuperseded by: ${direct.id} — ${direct.title}\nCurrent: none — chain ends at ${endpoint.id} (no active successor)\n` });
    expect(JSON.parse((await lb(home, ['show', a.id, '--json'])).out)).toEqual({
      ...old, supersededBy: [direct.id], current: null, chainEnd: { id: endpoint.id, status: 'superseded' },
    });
    expect(paths.map((path) => readFileSync(path))).toEqual(bytes);
  });

  it('explains a revoked endpoint beyond the direct successor across scopes', async () => {
    const home = tempDir();
    const middle = { ...b, status: 'superseded' as const, scope: 'project:elsewhere' };
    const end = sampleEntry({ id: 'rule-c-0003', status: 'revoked', scope: 'machine', supersedes: [b.id] });
    for (const entry of [a, middle, end]) writeEntry(home, entry);
    expect((await lb(home, ['show', a.id])).out).toBe(serializeEntry(a) +
      `\nSuperseded by: ${b.id} — ${b.title}\nCurrent: none — chain ends at ${end.id} (revoked)\n`);
    expect(JSON.parse((await lb(home, ['show', a.id, '--json'])).out)).toMatchObject({
      supersededBy: [b.id], current: null, chainEnd: { id: end.id, status: 'revoked' },
    });
  });

  it('retains unknown and ambiguous prefix errors', async () => {
    const home = tempDir();
    for (const entry of [a, b]) writeEntry(home, entry);
    for (const id of ['unknown', 'rule-']) {
      expect((await lb(home, ['show', id])).code).toBe(4);
      expect((await lb(home, ['show', id, '--json'])).code).toBe(4);
    }
  });
});

describe('list', () => {
  it('lists active entries newest first, and every status with all', () => {
    expect(listCommand(store(), {}).map((e) => e.id)).toEqual(['hold-tunnel-0002', 'rule-pipefail-0001', 'reference-logs-0004']);
    expect(listCommand(store(), { all: true }).map((e) => e.id)).toEqual([
      'hold-tunnel-0002',
      'rule-pipefail-0001',
      'hold-old-0003',
      'reference-logs-0004',
    ]);
  });

  it('refuses all together with a status', () => {
    expect(failure(() => listCommand(store(), { all: true, status: 'active' })).exitCode).toBe(EXIT.USAGE);
  });

  it('filters by kind, scope and status, alone or together', () => {
    const home = store();
    expect(listCommand(home, { kind: 'hold' }).map((e) => e.id)).toEqual(['hold-tunnel-0002']);
    expect(listCommand(home, { kind: 'hold', all: true }).map((e) => e.id)).toEqual(['hold-tunnel-0002', 'hold-old-0003']);
    expect(listCommand(home, { scope: 'machine' }).map((e) => e.id)).toEqual(['reference-logs-0004']);
    expect(listCommand(home, { status: 'released' }).map((e) => e.id)).toEqual(['hold-old-0003']);
    expect(listCommand(home, { kind: 'hold', scope: 'project:alpha', status: 'active' }).map((e) => e.id)).toEqual(['hold-tunnel-0002']);
  });

  it('refuses a filter value that cannot match anything, with the usage exit code', () => {
    const home = store();
    expect(failure(() => listCommand(home, { kind: 'note' })).exitCode).toBe(EXIT.USAGE);
    expect(failure(() => listCommand(home, { status: 'open' })).exitCode).toBe(EXIT.USAGE);
    expect(failure(() => listCommand(home, { scope: 'project:../x' })).exitCode).toBe(EXIT.USAGE);
  });

  it('renders one line per entry, and nothing for none', () => {
    expect(renderList(listCommand(store(), { kind: 'hold', all: true }))).toBe(
      '- [hold-tunnel-0002] active project:alpha: Tunnel is open\n' + '- [hold-old-0003] released project:alpha: Old hold\n',
    );
    expect(renderList([])).toBe('');
  });
});

describe('search', () => {
  it('matches title and body of active entries, case-insensitively; closed ones only with all', () => {
    const home = store();
    expect(searchEntries(home, 'PIPEFAIL').map((e) => e.id)).toEqual(['rule-pipefail-0001']);
    expect(searchEntries(home, 'its own status').map((e) => e.id)).toEqual(['rule-pipefail-0001']);
    expect(searchEntries(home, 'old hold')).toEqual([]);
    expect(searchEntries(home, 'old hold', { all: true }).map((e) => e.id)).toEqual(['hold-old-0003']);
    expect(searchEntries(home, '/var/log').map((e) => e.id)).toEqual(['reference-logs-0004']);
    expect(searchEntries(home, 'zzz')).toEqual([]);
  });

  it('needs something to search for', () => {
    expect(failure(() => searchEntries(store(), '  ')).exitCode).toBe(EXIT.USAGE);
  });
});

describe('lapsed reads', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-17T12:00:00Z'));
  });
  afterEach(() => vi.useRealTimers());

  function fixture() {
    const home = tempDir();
    const entries = [
      sampleEntry({ id: 'rule-lapsed-0001', until: '2000-01-01' }),
      sampleEntry({ id: 'rule-active-0002' }),
      sampleEntry({ id: 'rule-future-0003', until: '2030-01-01' }),
      sampleEntry({ id: 'rule-expired-0004', status: 'expired', until: '2000-01-01' }),
      sampleEntry({ id: 'rule-released-0005', status: 'released', until: '2000-01-01' }),
    ];
    entries.forEach((entry, i) => {
      entry.updated = `2026-10-17T0${9 - i}:00:00Z`;
      writeEntry(home, entry);
    });
    return { home, entries };
  }

  it('filters on display status, preserving closed and author views', () => {
    const { home, entries } = fixture();
    const active = entries.slice(1, 3).map((e) => e.id);
    expect(listCommand(home, {}).map((e) => e.id)).toEqual(active);
    expect(listCommand(home, { status: 'active' }).map((e) => e.id)).toEqual(active);
    expect(searchEntries(home, 'sample').map((e) => e.id)).toEqual(active);
    const all = entries.map((e, i) => ({ ...e, status: i === 0 ? 'lapsed' : e.status }));
    for (const result of [listCommand(home, { all: true }), searchEntries(home, 'sample', { all: true }),
      listCommand(home, { session: 'A' }), listCommand(home, { harness: 'claude-code' })]) {
      expect(result.map(({ id, status }) => ({ id, status }))).toEqual(all.map(({ id, status }) => ({ id, status })));
    }
    expect(listCommand(home, { status: 'lapsed' }).map((e) => e.id)).toEqual([entries[0].id]);
    for (const status of ['expired', 'released']) {
      expect(listCommand(home, { status }).map((e) => e.id)).toEqual(entries.filter((e) => e.status === status).map((e) => e.id));
    }
    expect(listCommand(home, { session: 'A', status: 'active' }).map((e) => e.id)).toEqual(active);
    expect(renderList(listCommand(home, { all: true }))).toContain('lapsed global: Sample');
    expect(failure(() => listCommand(home, { all: true, status: 'lapsed' })).exitCode).toBe(EXIT.USAGE);
  });

  it('reports lapsed through the CLI without changing the entry or log', async () => {
    const home = tempDir();
    expect((await lb(home, ['init'])).code).toBe(0);
    const help = await lb(home, ['--help']);
    expect(help.code).toBe(0);
    expect(help.out).toContain('--status lapsed          past its until date, not yet expired by Bosun');
    const entry = sampleEntry({ until: '2000-01-01', body: 'Body\nstatus: active\n' });
    writeEntry(home, entry);
    const path = join(scopeDir(home, entry.scope), `${entry.id}.md`);
    const bytes = readFileSync(path);
    const logPath = join(home, 'log.jsonl');
    const log = readFileSync(logPath);
    for (const args of [
      ['list', '--json'], ['list', '--status', 'active', '--json'], ['search', 'sample', '--json'],
    ]) {
      expect(await lb(home, args)).toEqual({ code: 0, err: '', out: '[]\n' });
    }
    for (const args of [
      ['list', '--all', '--json'], ['list', '--status', 'lapsed', '--json'], ['search', 'sample', '--all', '--json'],
    ]) {
      const result = await lb(home, args);
      expect(result.code).toBe(0);
      expect(result.err).toBe('');
      expect(JSON.parse(result.out)).toEqual(listCommand(home, { status: 'lapsed' }));
    }
    for (const args of [['list', '--all'], ['search', 'sample', '--all']]) {
      expect(await lb(home, args)).toEqual({ code: 0, err: '', out: renderList(listCommand(home, { all: true })) });
    }
    expect(await lb(home, ['show', entry.id])).toEqual({
      code: 0, err: '', out: serializeEntry(entry).replace(/^status: active$/m, 'status: lapsed'),
    });
    const json = await lb(home, ['show', entry.id, '--json']);
    expect(json.code).toBe(0);
    expect(JSON.parse(json.out)).toEqual({ ...entry, status: 'lapsed' });
    expect(readFileSync(path)).toEqual(bytes);
    expect(readFileSync(path, 'utf8')).toMatch(/^status: active$/m);
    expect(readFileSync(logPath)).toEqual(log);
    expect(showEntry(home, entry.id).status).toBe('active');
    expect(() => parseEntry(serializeEntry(entry).replace(/^status: active$/m, 'status: lapsed'))).toThrow();
    expect((await lb(home, ['revise', entry.id, '--status', 'lapsed'])).code).toBe(EXIT.USAGE);
  });

  it.each([
    ['2026-10-17', '2026-10-17T23:59:59.999Z', 'active'],
    ['2026-10-17', '2026-10-18T00:00:00Z', 'lapsed'],
    ['2026-10-17T12:00:00Z', '2026-10-17T12:00:00Z', 'active'],
    ['2026-10-17T12:00:00Z', '2026-10-17T12:00:00.001Z', 'lapsed'],
    ['unreadable', '2026-10-17T12:00:00Z', 'active'],
  ])('until %s at %s displays %s', (until, now, status) => {
    vi.setSystemTime(new Date(now));
    const home = tempDir();
    const entry = sampleEntry({ until });
    writeEntry(home, entry);
    expect(listCommand(home, { status }).map((e) => e.id)).toEqual([entry.id]);
    expect(listCommand(home, { status: status === 'active' ? 'lapsed' : 'active' })).toEqual([]);
  });
});

describe('summary metadata', () => {
  function metadataStore() {
    const home = tempDir();
    writeEntry(
      home,
      sampleEntry({
        id: 'rule-meta-0001',
        title: 'Metadata rule',
        author: { harness: 'helmraiser', session: 'run-42', origin: 'mirrored' },
        created: '2026-10-17T10:00:00Z',
        updated: '2026-10-17T12:00:00Z',
        until: '2999-11-01',
        release: 'r',
        blocks: ['tag'],
        holder: 'h',
        to: 'any',
      }),
    );
    writeEntry(
      home,
      sampleEntry({
        id: 'rule-anon-0002',
        title: 'Anonymous rule',
        author: { harness: null, session: null, origin: 'mirrored' },
        created: '2026-10-16T10:00:00Z',
        updated: '2026-10-16T10:00:00Z',
      }),
    );
    return home;
  }

  it('list and search summaries carry author, created and updated, and no body', () => {
    const home = metadataStore();
    for (const summaries of [listCommand(home, {}), searchEntries(home, 'rule')]) {
      const authored = summaries.find((entry) => entry.id === 'rule-meta-0001')!;
      expect(authored.author).toEqual({ harness: 'helmraiser', session: 'run-42', origin: 'mirrored' });
      expect(authored.created).toBe('2026-10-17T10:00:00Z');
      expect(authored.updated).toBe('2026-10-17T12:00:00Z');
      expect(authored.until).toBe('2999-11-01');
      expect(authored.release).toBe('r');
      expect(authored.blocks).toEqual(['tag']);
      expect(authored.holder).toBe('h');
      expect(authored.to).toBe('any');
      expect(authored).not.toHaveProperty('body');

      const anonymous = summaries.find((entry) => entry.id === 'rule-anon-0002')!;
      expect(anonymous.author).toEqual({ harness: null, session: null, origin: 'mirrored' });
      expect(anonymous.created).toBe('2026-10-16T10:00:00Z');
      expect(anonymous.updated).toBe('2026-10-16T10:00:00Z');
      expect(anonymous).not.toHaveProperty('body');
    }
  });
});

describe('list author filters', () => {
  function filterStore() {
    const home = tempDir();
    writeEntry(
      home,
      sampleEntry({
        id: 'hold-run-a-0001',
        kind: 'hold',
        scope: 'global',
        title: 'Helmraiser A hold',
        release: 'r',
        author: { harness: 'helmraiser', session: 'run-1', origin: 'agent-inferred' },
        created: '2026-10-17T12:00:00Z',
        updated: '2026-10-17T12:00:00Z',
      }),
    );
    writeEntry(
      home,
      sampleEntry({
        id: 'rule-run-b-0002',
        kind: 'rule',
        scope: 'machine',
        title: 'Helmraiser B rule',
        author: { harness: 'helmraiser', session: 'run-2', origin: 'agent-inferred' },
        created: '2026-10-17T13:00:00Z',
        updated: '2026-10-17T13:00:00Z',
      }),
    );
    writeEntry(
      home,
      sampleEntry({
        id: 'reference-shared-0003',
        kind: 'reference',
        scope: 'global',
        title: 'Pi reference',
        author: { harness: 'pi', session: 'run-1', origin: 'agent-inferred' },
        created: '2026-10-17T11:00:00Z',
        updated: '2026-10-17T11:00:00Z',
      }),
    );
    writeEntry(
      home,
      sampleEntry({
        id: 'rule-anon-0004',
        kind: 'rule',
        scope: 'global',
        status: 'revoked',
        title: 'Anonymous rule',
        author: { harness: null, session: null, origin: 'mirrored' },
        created: '2026-10-17T10:00:00Z',
        updated: '2026-10-17T10:00:00Z',
      }),
    );
    return home;
  }

  it('filters by session or harness alone, and by both together', () => {
    const home = filterStore();
    expect(listCommand(home, { session: 'run-1' }).map((e) => e.id)).toEqual(['hold-run-a-0001', 'reference-shared-0003']);
    expect(listCommand(home, { harness: 'helmraiser' }).map((e) => e.id)).toEqual(['rule-run-b-0002', 'hold-run-a-0001']);
    expect(listCommand(home, { session: 'run-2', harness: 'helmraiser' }).map((e) => e.id)).toEqual(['rule-run-b-0002']);
    expect(listCommand(home, { session: 'run-1', harness: 'pi' }).map((e) => e.id)).toEqual(['reference-shared-0003']);
  });

  it('combines author filters with kind, scope and status', () => {
    const home = filterStore();
    expect(listCommand(home, { session: 'run-1', kind: 'hold' }).map((e) => e.id)).toEqual(['hold-run-a-0001']);
    expect(listCommand(home, { session: 'run-1', scope: 'global' }).map((e) => e.id)).toEqual(['hold-run-a-0001', 'reference-shared-0003']);
    expect(listCommand(home, { harness: 'helmraiser', status: 'active' }).map((e) => e.id)).toEqual(['rule-run-b-0002', 'hold-run-a-0001']);
    expect(listCommand(home, { harness: 'helmraiser', kind: 'rule', scope: 'machine', status: 'active' }).map((e) => e.id)).toEqual([
      'rule-run-b-0002',
    ]);
  });

  it('lists every status when filtering by author, unless a status is given', () => {
    const home = filterStore();
    writeEntry(home, sampleEntry({
      id: 'rule-run-old-0005', status: 'revoked', title: 'Revoked run rule',
      author: { harness: 'helmraiser', session: 'run-2', origin: 'agent-inferred' },
      created: '2026-10-17T09:00:00Z', updated: '2026-10-17T09:00:00Z',
    }));
    expect(listCommand(home, { session: 'run-2' }).map((e) => e.id)).toEqual(['rule-run-b-0002', 'rule-run-old-0005']);
    expect(listCommand(home, { harness: 'helmraiser' }).map((e) => e.id)).toEqual(['rule-run-b-0002', 'hold-run-a-0001', 'rule-run-old-0005']);
    expect(listCommand(home, { session: 'run-2', status: 'active' }).map((e) => e.id)).toEqual(['rule-run-b-0002']);
  });

  it('returns nothing for an unknown or inexact session or harness', () => {
    const home = filterStore();
    expect(listCommand(home, { session: 'run-9' })).toEqual([]);
    expect(listCommand(home, { harness: 'bosun' })).toEqual([]);
    expect(listCommand(home, { session: 'run' })).toEqual([]);
    expect(listCommand(home, { session: 'RUN-1' })).toEqual([]);
    expect(listCommand(home, { harness: 'Helmraiser' })).toEqual([]);
  });

  it('returns active entries without an author filter, and every one, anonymous included, with all', () => {
    expect(listCommand(filterStore(), {}).map((e) => e.id)).toEqual(['rule-run-b-0002', 'hold-run-a-0001', 'reference-shared-0003']);
    expect(listCommand(filterStore(), { all: true }).map((e) => e.id)).toEqual([
      'rule-run-b-0002',
      'hold-run-a-0001',
      'reference-shared-0003',
      'rule-anon-0004',
    ]);
  });

  it('keeps newest-first ordering and summary metadata on filtered results', () => {
    const filtered = listCommand(filterStore(), { harness: 'helmraiser' });
    expect(filtered.map((e) => e.id)).toEqual(['rule-run-b-0002', 'hold-run-a-0001']);
    expect(filtered[0]).toMatchObject({
      author: { harness: 'helmraiser', session: 'run-2', origin: 'agent-inferred' },
      created: '2026-10-17T13:00:00Z',
      updated: '2026-10-17T13:00:00Z',
    });
  });
});
