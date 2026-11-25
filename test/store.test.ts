import { describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type RevisionRecord, serializeEntry } from '../src/entry.js';
import { EXIT, LeeboardError } from '../src/errors.js';
import {
  appendRevision,
  readRevision,
  findEntry,
  allScopes,
  createEntryFile,
  createSuccessorResolver,
  initStore,
  listEntries,
  listEntriesWithDiagnostics,
  resolveHome,
  scopeDir,
  withRevisionLock,
  writeEntry,
  writeFileAtomic,
} from '../src/store.js';
import { sampleEntry, tempDir } from './helpers.js';

function failure(fn: () => unknown): LeeboardError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(LeeboardError);
    return error as LeeboardError;
  }
  throw new Error('expected a LeeboardError');
}

describe('writeFileAtomic', () => {
  it('writes the content and leaves no temporary file behind', () => {
    const dir = tempDir();
    writeFileAtomic(join(dir, 'a.md'), 'hello\n');
    expect(readFileSync(join(dir, 'a.md'), 'utf8')).toBe('hello\n');
    expect(readdirSync(dir)).toEqual(['a.md']);
  });

  it('replaces an existing file in place', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'a.md'), 'old');
    writeFileAtomic(join(dir, 'a.md'), 'new');
    expect(readFileSync(join(dir, 'a.md'), 'utf8')).toBe('new');
    expect(readdirSync(dir)).toEqual(['a.md']);
  });

  it('creates missing parent directories', () => {
    const dir = tempDir();
    writeFileAtomic(join(dir, 'x', 'y', 'a.md'), 'deep');
    expect(readFileSync(join(dir, 'x', 'y', 'a.md'), 'utf8')).toBe('deep');
  });

  it('cleans up its temporary file when the rename fails', () => {
    const dir = tempDir();
    mkdirSync(join(dir, 'a.md')); // a directory cannot be replaced by a file
    expect(() => writeFileAtomic(join(dir, 'a.md'), 'x')).toThrow();
    expect(readdirSync(dir)).toEqual(['a.md']);
  });
});

describe('revision lock', () => {
  it('holds the lock across the callback and releases it on success or failure', () => {
    const home = tempDir();
    const lock = join(home, 'state', 'revision.lock');
    expect(withRevisionLock(home, () => {
      const owner = JSON.parse(readFileSync(join(lock, 'owner.json'), 'utf8'));
      expect(owner).toEqual({ pid: process.pid, ts: expect.any(String) });
      expect(Math.abs(Date.now() - Date.parse(owner.ts))).toBeLessThan(1000);
      return 'saved';
    })).toBe('saved');
    expect(existsSync(lock)).toBe(false);
    expect(() => withRevisionLock(home, () => { throw new Error('failed revision'); })).toThrow('failed revision');
    expect(existsSync(lock)).toBe(false);
    expect(withRevisionLock(home, () => 'next revision')).toBe('next revision');
  });

  it.each(['old owner', 'numeric owner timestamp', 'missing owner', 'unreadable owner', 'invalid owner timestamp'])(
    'recovers a stale lock with %s and completes the write', (reason) => {
      const home = tempDir();
      const state = join(home, 'state');
      const lock = join(state, 'revision.lock');
      mkdirSync(lock, { recursive: true });
      const old = new Date(Date.now() - 20_000);
      if (reason === 'old owner' || reason === 'numeric owner timestamp') {
        // Even our own live PID must not prevent age-based recovery across PID namespaces.
        writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, ts: reason === 'old owner' ? old.toISOString() : old.getTime() }));
      } else {
        if (reason === 'unreadable owner') writeFileSync(join(lock, 'owner.json'), '{bad');
        if (reason === 'invalid owner timestamp') writeFileSync(join(lock, 'owner.json'), '{"pid":123,"ts":"bad"}');
        utimesSync(lock, old, old);
      }
      const clock = vi.spyOn(performance, 'now').mockReturnValueOnce(0).mockReturnValue(15_001);
      const entry = sampleEntry();
      try {
        withRevisionLock(home, () => writeEntry(home, entry));
        expect(findEntry(home, entry.id)).toEqual(entry);
        expect(readdirSync(state)).toEqual([]);
      } finally { clock.mockRestore(); }
    },
  );

  it('recovers even if a previous recovery process abandoned its claim', () => {
    const home = tempDir();
    const lock = join(home, 'state', 'revision.lock');
    const claim = join(lock, '.recovering');
    mkdirSync(claim, { recursive: true });
    const old = new Date(Date.now() - 20_000);
    writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid: 123, ts: old.toISOString() }));
    utimesSync(claim, old, old);
    const clock = vi.spyOn(performance, 'now').mockReturnValueOnce(0).mockReturnValue(15_001);
    try {
      expect(withRevisionLock(home, () => 'recovered')).toBe('recovered');
      expect(readdirSync(join(home, 'state'))).toEqual([]);
    } finally { clock.mockRestore(); }
  });

  it('uses fresh ownership time rather than an old directory mtime', () => {
    const home = tempDir();
    const lock = join(home, 'state', 'revision.lock');
    mkdirSync(lock, { recursive: true });
    const owner = JSON.stringify({ pid: 123, ts: new Date().toISOString() });
    writeFileSync(join(lock, 'owner.json'), owner);
    const old = new Date(Date.now() - 20_000);
    utimesSync(lock, old, old);
    const clock = vi.spyOn(performance, 'now').mockReturnValueOnce(0).mockReturnValue(15_001);
    const change = vi.fn();
    try {
      expect(() => withRevisionLock(home, change)).toThrow('timed out waiting');
      expect(change).not.toHaveBeenCalled();
      expect(readFileSync(join(lock, 'owner.json'), 'utf8')).toBe(owner);
    } finally { clock.mockRestore(); }
  });

  it.skipIf(process.env.LEEBOARD_TEST_FUTURE)('bounds contention without entering the callback or removing another writer lock', () => {
    const home = tempDir();
    const lock = join(home, 'state', 'revision.lock');
    mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, 'owner.json'), '{"pid":123}\n');
    const clock = vi.spyOn(performance, 'now').mockReturnValueOnce(0).mockReturnValue(15_001);
    const change = vi.fn();
    try {
      expect(() => withRevisionLock(home, change)).toThrow('timed out waiting');
      expect(change).not.toHaveBeenCalled();
      expect(readFileSync(join(lock, 'owner.json'), 'utf8')).toBe('{"pid":123}\n');
    } finally { clock.mockRestore(); }
  });
});

describe('revision history', () => {
  const record: RevisionRecord = {
    ts: '2026-10-22T12:00:00Z', harness: 'pi', session: 'revision-actor',
    before: { title: 'Café 船', body: 'Old body\n', scope: 'global', updated: '2026-10-21T12:00:00Z' },
  };

  it('creates history lazily and preserves original bytes with multibyte offsets and large bodies', () => {
    const home = tempDir();
    initStore(home);
    expect(existsSync(join(home, 'revisions'))).toBe(false);
    const first = appendRevision(home, 'rule-x', record);
    const path = join(home, 'revisions', 'rule-x.jsonl');
    const bytes = readFileSync(path);
    const large = { ...record, before: { ...record.before, body: '船'.repeat(5000) } };
    const second = appendRevision(home, 'rule-x', large);
    expect(first).toBe(0);
    expect(second).toBe(bytes.length);
    expect(second).toBeGreaterThan(bytes.toString().length);
    expect(readFileSync(path).subarray(0, bytes.length)).toEqual(bytes);
    expect(readRevision(home, 'rule-x', first)).toEqual(record);
    expect(readRevision(home, 'rule-x', second)).toEqual(large);
  });

  it('returns null for missing, partial, malformed records and invalid offsets without rewriting', () => {
    const home = tempDir();
    expect(readRevision(home, 'missing', 0)).toBeNull();
    appendRevision(home, 'rule-x', record);
    const path = join(home, 'revisions', 'rule-x.jsonl');
    for (const text of [JSON.stringify(record), '{bad}\n', '{}\n', 'null\n', JSON.stringify({ ...record, before: {} }) + '\n']) {
      writeFileSync(path, text);
      expect(readRevision(home, 'rule-x', 0)).toBeNull();
      expect(readFileSync(path, 'utf8')).toBe(text);
    }
    writeFileSync(path, JSON.stringify(record) + '\n');
    for (const offset of [-1, 0.5, NaN, Infinity, 1, 99999]) expect(readRevision(home, 'rule-x', offset)).toBeNull();
  });
});

describe('scope moves', () => {
  it('writes the destination then removes the old file, preserving id and scope directories', () => {
    const home = tempDir();
    const entry = sampleEntry();
    writeEntry(home, entry);
    writeEntry(home, { ...entry, scope: 'project:alpha' }, 'global');
    expect(readdirSync(scopeDir(home, 'global'))).toEqual([]);
    expect(readdirSync(scopeDir(home, 'project:alpha'))).toEqual([`${entry.id}.md`]);
    expect(listEntries(home)).toEqual([{ ...entry, scope: 'project:alpha' }]);
    expect(findEntry(home, entry.id).scope).toBe('project:alpha');
  });

  it('keeps the original file when the destination write fails', () => {
    const home = tempDir();
    const entry = sampleEntry();
    writeEntry(home, entry);
    const destination = join(scopeDir(home, 'machine'), `${entry.id}.md`);
    mkdirSync(destination, { recursive: true });
    expect(() => writeEntry(home, { ...entry, scope: 'machine' }, 'global')).toThrow();
    expect(listEntries(home)).toEqual([entry]);
    expect(readFileSync(join(scopeDir(home, 'global'), `${entry.id}.md`), 'utf8')).toBe(serializeEntry(entry));
    expect(readdirSync(scopeDir(home, 'machine'))).toEqual([`${entry.id}.md`]);
  });
});

describe('createEntryFile', () => {
  it('writes a new entry and leaves no temporary file behind', () => {
    const home = tempDir();
    const entry = sampleEntry();
    expect(createEntryFile(home, entry)).toBe(true);
    expect(readdirSync(scopeDir(home, entry.scope))).toEqual([`${entry.id}.md`]);
  });

  it('refuses to overwrite an existing entry with the same id', () => {
    const home = tempDir();
    const first = sampleEntry();
    createEntryFile(home, first);
    const second = { ...first, title: 'A different entry' };
    expect(createEntryFile(home, second)).toBe(false);
    const path = join(scopeDir(home, first.scope), `${first.id}.md`);
    expect(readFileSync(path, 'utf8')).toBe(serializeEntry(first));
    expect(readdirSync(scopeDir(home, first.scope))).toEqual([`${first.id}.md`]);
  });
});

describe('resolveHome', () => {
  it('uses LEEBOARD_HOME when set', () => {
    expect(resolveHome({ LEEBOARD_HOME: '/data/store' })).toBe('/data/store');
  });

  it('falls back to ~/.leeboard', () => {
    expect(resolveHome({})).toBe(join(process.env.HOME!, '.leeboard'));
  });
});

describe('initStore', () => {
  it('creates the layout, an empty log and a .gitignore for state/', () => {
    const home = join(tempDir(), 'store');
    initStore(home);
    expect(readdirSync(home).sort()).toEqual(['.gitignore', 'global', 'log.jsonl', 'machine', 'projects', 'state']);
    expect(readdirSync(join(home, 'global'))).toEqual(['entries']);
    expect(readdirSync(join(home, 'machine'))).toEqual(['entries']);
    expect(readFileSync(join(home, 'log.jsonl'), 'utf8')).toBe('');
    expect(readFileSync(join(home, '.gitignore'), 'utf8')).toBe('state/\n');
  });

  it('can be run again without touching what is there', () => {
    const home = tempDir();
    initStore(home);
    writeFileSync(join(home, 'log.jsonl'), '{"a":1}\n');
    writeFileSync(join(home, '.gitignore'), 'state/\nextra\n');
    initStore(home);
    expect(readFileSync(join(home, 'log.jsonl'), 'utf8')).toBe('{"a":1}\n');
    expect(readFileSync(join(home, '.gitignore'), 'utf8')).toBe('state/\nextra\n');
  });
});

describe('scopeDir', () => {
  it('maps scopes to entry directories', () => {
    expect(scopeDir('/h', 'global')).toBe('/h/global/entries');
    expect(scopeDir('/h', 'machine')).toBe('/h/machine/entries');
    expect(scopeDir('/h', 'project:alpha')).toBe('/h/projects/alpha/entries');
  });

  it.each(['', 'Global', 'project:', 'project:../x', 'project:a/b', 'projects', 'project'])(
    'rejects the scope %j with the usage exit code',
    (scope) => {
      expect(failure(() => scopeDir('/h', scope)).exitCode).toBe(EXIT.USAGE);
    },
  );
});

describe('entry files', () => {
  it('writes each entry to <scope dir>/<id>.md', () => {
    const home = tempDir();
    const entry = sampleEntry({ id: 'rule-a-0001', scope: 'project:alpha', body: 'why\n' });
    writeEntry(home, entry);
    expect(readFileSync(join(home, 'projects', 'alpha', 'entries', 'rule-a-0001.md'), 'utf8')).toBe(serializeEntry(entry));
  });

  it('lists entries across scopes, skipping temp files, other files and unreadable entries', () => {
    const home = tempDir();
    writeEntry(home, sampleEntry({ id: 'rule-g-0001', scope: 'global' }));
    writeEntry(home, sampleEntry({ id: 'rule-m-0002', scope: 'machine' }));
    writeEntry(home, sampleEntry({ id: 'hold-p-0003', kind: 'hold', scope: 'project:alpha' }));
    const dir = scopeDir(home, 'global');
    writeFileSync(join(dir, '.rule-x-0009.md.tmp-1-ab'), 'partial');
    writeFileSync(join(dir, 'notes.txt'), 'not an entry');
    writeFileSync(join(dir, 'broken-0004.md'), 'no frontmatter here');

    expect(listEntries(home).map((e) => e.id).sort()).toEqual(['hold-p-0003', 'rule-g-0001', 'rule-m-0002']);
  });

  it('can be limited to some scopes', () => {
    const home = tempDir();
    writeEntry(home, sampleEntry({ id: 'rule-g-0001', scope: 'global' }));
    writeEntry(home, sampleEntry({ id: 'rule-m-0002', scope: 'machine' }));
    writeEntry(home, sampleEntry({ id: 'rule-p-0003', scope: 'project:alpha' }));
    expect(listEntries(home, ['global', 'project:alpha']).map((e) => e.id).sort()).toEqual(['rule-g-0001', 'rule-p-0003']);
  });

  it('lists nothing in an empty or missing store', () => {
    expect(listEntries(join(tempDir(), 'missing'))).toEqual([]);
  });
});

describe('listing diagnostics', () => {
  it('returns valid entries and read/parse failures with directory scopes, respecting filters', () => {
    const home = tempDir();
    const valid = sampleEntry();
    writeEntry(home, valid);
    const broken = join(scopeDir(home, 'global'), 'rule-broken.md');
    writeFileSync(broken, 'no frontmatter');
    writeFileSync(join(scopeDir(home, 'global'), '.hidden.md'), 'ignored');
    writeFileSync(join(scopeDir(home, 'global'), 'notes.txt'), 'ignored');
    writeEntry(home, sampleEntry({ id: 'rule-machine-0002', scope: 'machine' }));
    const unreadable = join(scopeDir(home, 'machine'), 'hold-read-error.md');
    mkdirSync(unreadable);
    const result = listEntriesWithDiagnostics(home);
    expect(result.entries).toEqual(listEntries(home));
    expect(result.entries).toHaveLength(2);
    expect(result.unreadable).toEqual([
      { path: broken, scope: 'global', error: expect.stringMatching(/frontmatter/) },
      { path: unreadable, scope: 'machine', error: expect.stringMatching(/EISDIR/) },
    ]);
    expect(listEntriesWithDiagnostics(home, ['global']).unreadable).toEqual([result.unreadable[0]]);
    expect(listEntriesWithDiagnostics(home, undefined, (id) => id.startsWith('hold-')).unreadable)
      .toEqual([result.unreadable[1]]);
    expect(listEntriesWithDiagnostics(home, ['project:missing'])).toEqual({ entries: [], unreadable: [] });
  });

  it('returns empty arrays for empty and missing stores', () => {
    const home = tempDir();
    expect(listEntriesWithDiagnostics(home)).toEqual({ entries: [], unreadable: [] });
    expect(listEntriesWithDiagnostics(join(home, 'missing'))).toEqual({ entries: [], unreadable: [] });
  });
});

describe('findEntry', () => {
  function storeWithEntries() {
    const home = tempDir();
    writeEntry(home, sampleEntry({ id: 'hold-no-runs-1a2b', kind: 'hold', title: 'No runs' }));
    writeEntry(home, sampleEntry({ id: 'hold-no-pushes-3c4d', kind: 'hold', scope: 'machine' }));
    writeEntry(home, sampleEntry({ id: 'rule-pipefail-5e6f', scope: 'project:alpha' }));
    return home;
  }

  it('finds an entry by its full id or by any unique prefix, in any scope', () => {
    const home = storeWithEntries();
    expect(findEntry(home, 'hold-no-runs-1a2b').title).toBe('No runs');
    expect(findEntry(home, 'hold-no-r').id).toBe('hold-no-runs-1a2b');
    expect(findEntry(home, 'rule-').id).toBe('rule-pipefail-5e6f');
    expect(findEntry(home, 'rule-').scope).toBe('project:alpha');
  });

  it('refuses an ambiguous prefix with exit 4 and lists the candidates', () => {
    const error = failure(() => findEntry(storeWithEntries(), 'hold-no-'));
    expect(error.exitCode).toBe(EXIT.UNKNOWN_ID);
    expect(error.message).toContain('hold-no-runs-1a2b');
    expect(error.message).toContain('hold-no-pushes-3c4d');
    expect(error.message).not.toContain('rule-pipefail-5e6f');
  });

  it('finds an entry by its four-character hash suffix when no id starts with it', () => {
    const home = storeWithEntries();
    expect(findEntry(home, '3c4d').id).toBe('hold-no-pushes-3c4d');
    writeEntry(home, sampleEntry({ id: 'rule-other-3c4d' }));
    const error = failure(() => findEntry(home, '3c4d'));
    expect(error.exitCode).toBe(EXIT.UNKNOWN_ID);
    expect(error.message).toContain('hold-no-pushes-3c4d');
    expect(error.message).toContain('rule-other-3c4d');
    expect(failure(() => findEntry(home, 'c4d')).exitCode).toBe(EXIT.UNKNOWN_ID);
  });

  it('refuses an unknown id with exit 4', () => {
    const error = failure(() => findEntry(storeWithEntries(), 'grant-'));
    expect(error.exitCode).toBe(EXIT.UNKNOWN_ID);
    expect(error.message).toContain('grant-');
  });
});

describe('listEntries with an id filter', () => {
  it('only parses entries whose id passes the filter', () => {
    const home = tempDir();
    writeEntry(home, sampleEntry({ id: 'rule-g-0001', scope: 'global' }));
    writeEntry(home, sampleEntry({ id: 'handoff-x-0002', kind: 'handoff', scope: 'project:alpha', to: 'any' }));
    writeEntry(home, sampleEntry({ id: 'request-y-0003', kind: 'request', scope: 'machine', to: 'any' }));
    const inbox = listEntries(home, undefined, (id) => id.startsWith('handoff-') || id.startsWith('request-'));
    expect(inbox.map((e) => e.id).sort()).toEqual(['handoff-x-0002', 'request-y-0003']);
  });
});

describe('successor resolver', () => {
  const now = new Date('2026-10-17T12:00:00Z');
  const a = sampleEntry({ id: 'rule-a', status: 'superseded' });
  const b = sampleEntry({ id: 'rule-b', status: 'superseded', supersedes: [a.id] });
  const c = sampleEntry({ id: 'rule-c', supersedes: [b.id] });

  it('resolves live entries to themselves and reports standalone lapsed entries without a current', () => {
    const active = sampleEntry();
    expect(createSuccessorResolver([active], now)(active.id)).toEqual({ successors: [], current: active, chainEnd: { id: active.id, status: 'active' } });
    const lapsed = { ...active, until: '2000-01-01' };
    expect(createSuccessorResolver([lapsed], now)(lapsed.id)).toEqual({ successors: [], current: null, chainEnd: { id: lapsed.id, status: 'lapsed' } });
  });

  it('reports lapsed direct and multihop endpoints without changing stored status', () => {
    const lapsed = { ...c, until: '2000-01-01' };
    const entries = [a, b, lapsed];
    const before = structuredClone(entries);
    const resolve = createSuccessorResolver(entries, now);
    expect(resolve(a.id)).toEqual({ successors: [b], current: null, chainEnd: { id: c.id, status: 'lapsed' } });
    expect(resolve(b.id)).toEqual({ successors: [lapsed], current: null, chainEnd: { id: c.id, status: 'lapsed' } });
    expect(entries).toEqual(before);
    expect(lapsed.status).toBe('active');
  });

  it('skips a lapsed branch for a live branch, otherwise preserves the first failed endpoint', () => {
    const lapsed = { ...c, until: '2000-01-01' };
    const live = sampleEntry({ id: 'rule-live', supersedes: [a.id] });
    expect(createSuccessorResolver([a, b, lapsed, live], now)(a.id)).toEqual({
      successors: [b, live], current: live, chainEnd: { id: live.id, status: 'active' },
    });
    const closed = { ...live, status: 'revoked' as const };
    expect(createSuccessorResolver([a, b, lapsed, closed], now)(a.id)).toEqual({
      successors: [b, closed], current: null, chainEnd: { id: c.id, status: 'lapsed' },
    });
  });

  it('follows one hop and multiple hops without mutating fixtures or sharing visited state', () => {
    const entries = [a, b, c];
    const before = structuredClone(entries);
    const resolve = createSuccessorResolver(entries, now);
    expect(resolve(a.id)).toEqual({ successors: [b], current: c, chainEnd: { id: c.id, status: 'active' } });
    expect(resolve(b.id)).toEqual({ successors: [c], current: c, chainEnd: { id: c.id, status: 'active' } });
    expect(resolve(a.id).current).toBe(c);
    expect(entries).toEqual(before);
  });

  it('resolves several old entries merged into one replacement, deduplicating direct links', () => {
    const old = sampleEntry({ id: 'rule-other', status: 'superseded' });
    const merged = sampleEntry({ supersedes: [a.id, old.id, a.id] });
    const resolve = createSuccessorResolver([a, old, merged], now);
    expect(resolve(a.id)).toEqual({ successors: [merged], current: merged, chainEnd: { id: merged.id, status: 'active' } });
    expect(resolve(old.id).current).toBe(merged);
  });

  it('returns all direct successors in input order and selects the first reachable active branch', () => {
    const first = sampleEntry({ id: 'rule-first', supersedes: [a.id] });
    const second = sampleEntry({ id: 'rule-second', supersedes: [a.id] });
    expect(createSuccessorResolver([a, second, first], now)(a.id)).toEqual({ successors: [second, first], current: second, chainEnd: { id: second.id, status: 'active' } });
    const revoked = { ...first, status: 'revoked' as const };
    expect(createSuccessorResolver([a, revoked, second], now)(a.id)).toEqual({ successors: [revoked, second], current: second, chainEnd: { id: second.id, status: 'active' } });
  });

  it.each(['revoked', 'released', 'done', 'retired', 'expired'] as const)('does not follow a %s endpoint', (status) => {
    const closed = { ...b, status };
    const resolve = createSuccessorResolver([a, closed, c], now);
    expect(resolve(a.id)).toEqual({ successors: [closed], current: null, chainEnd: { id: closed.id, status } });
    expect(resolve(closed.id)).toMatchObject({ current: null, chainEnd: { id: closed.id, status } });
  });

  it('leaves unknown ids and superseded entries without a replacement unresolved', () => {
    const resolve = createSuccessorResolver([a, c], now);
    expect(resolve(a.id)).toEqual({ successors: [], current: null, chainEnd: null });
    expect(resolve('unknown')).toEqual({ successors: [], current: null, chainEnd: null });
    // The missing starting entry must exist before its meaning can be followed.
    expect(resolve(b.id)).toEqual({ successors: [c], current: null, chainEnd: null });
  });

  it('reports a superseded leaf or closed endpoint through several hops', () => {
    expect(createSuccessorResolver([a, b], now)(a.id)).toEqual({
      successors: [b], current: null, chainEnd: { id: b.id, status: 'superseded' },
    });
    const revoked = { ...c, status: 'revoked' as const };
    expect(createSuccessorResolver([a, b, revoked], now)(a.id)).toEqual({
      successors: [b], current: null, chainEnd: { id: c.id, status: 'revoked' },
    });
  });

  it('reports the first failed branch endpoint if no branch reaches an active entry', () => {
    const revoked = { ...c, status: 'revoked' as const };
    const other = sampleEntry({ id: 'rule-other', status: 'released', supersedes: [a.id] });
    expect(createSuccessorResolver([a, b, revoked, other], now)(a.id).chainEnd).toEqual({ id: c.id, status: 'revoked' });
    expect(createSuccessorResolver([a, other, b, revoked], now)(a.id).chainEnd).toEqual({ id: other.id, status: 'released' });
  });

  it('terminates self-cycles, two-entry cycles and still tries later branches', () => {
    const self = { ...a, supersedes: [a.id] };
    expect(createSuccessorResolver([self], now)(a.id)).toEqual({ successors: [self], current: null, chainEnd: { id: a.id, status: 'superseded' } });
    const cyclicA = { ...a, supersedes: [b.id] };
    const resolve = createSuccessorResolver([cyclicA, b], now);
    expect(resolve(a.id)).toMatchObject({ current: null, chainEnd: { id: a.id, status: 'superseded' } });
    expect(resolve(b.id)).toMatchObject({ current: null, chainEnd: { id: b.id, status: 'superseded' } });
    const valid = { ...c, supersedes: [a.id] };
    expect(createSuccessorResolver([cyclicA, b, valid], now)(a.id)).toEqual({ successors: [b, valid], current: valid, chainEnd: { id: valid.id, status: 'active' } });
  });
});

describe('allScopes', () => {
  it('is global, machine and one scope per project directory', () => {
    const home = tempDir();
    expect(allScopes(home)).toEqual(['global', 'machine']);
    writeEntry(home, sampleEntry({ id: 'rule-a-0001', scope: 'project:beta' }));
    writeEntry(home, sampleEntry({ id: 'rule-b-0002', scope: 'project:alpha' }));
    expect(allScopes(home)).toEqual(['global', 'machine', 'project:alpha', 'project:beta']);
  });
});
