import { describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { brief } from '../src/commands/brief.js';
import { delta, renderDelta } from '../src/commands/delta.js';
import { createEntry, releaseHold, replyToRequest, reviseEntry, revokeEntry, supersedeEntry } from '../src/change.js';
import type { Ctx } from '../src/context.js';
import { logChange, logSize, readCursor, writeCursor } from '../src/log.js';
import { addProject } from '../src/projects.js';
import * as store from '../src/store.js';
import { lb, makeRepo, tempDir } from './helpers.js';

/** One store with project alpha; sessions are different identities sharing it. */
function world() {
  const home = tempDir();
  const repo = makeRepo();
  addProject(home, { name: 'alpha', paths: [repo] });
  const as = (session: string | null, harness: Ctx['identity']['harness'], cwd = repo): Ctx => ({
    home,
    cwd,
    now: new Date('2026-10-17T14:02:11Z'),
    identity: { harness, session, origin: 'agent-inferred' },
  });
  return { home, repo, A: as('A', 'claude-code'), B: as('B', 'pi'), as };
}

const lines = (ctx: Ctx) => renderDelta(delta(ctx));

describe('successor-aware delta', () => {
  it.each(['direct', 'chain', 'revoked'] as const)('names a %s replacement outside the reader scope without delivering it', (mode) => {
    const { A, B } = world();
    const old = createEntry(A, { kind: 'rule', title: 'Old rule' });
    brief(B);
    const next = createEntry(A, { kind: 'rule', title: 'Elsewhere', scope: 'project:beta' });
    supersedeEntry(A, old.id, next.id);
    let target = next.id;
    if (mode === 'chain') {
      const current = createEntry(A, { kind: 'rule', title: 'Current', scope: 'project:gamma' });
      supersedeEntry(A, next.id, current.id);
      target = current.id;
    } else if (mode === 'revoked') revokeEntry(A, next.id, 'No longer applies');
    const items = delta(B);
    expect(items).toEqual([{
      id: old.id, kind: 'rule', scope: 'project:alpha', title: 'Old rule', event: 'status', status: 'superseded',
      supersededBy: [next.id], current: mode === 'revoked' ? null : target,
    }]);
    expect(renderDelta(items)).toBe(`- [${old.id}] rule superseded: Old rule → ${target}\n`);
    expect(lines(B)).toBe('');
  });

  it.each(['direct', 'chain'] as const)('uses the delta clock for a %s endpoint without changing delivery or stored data', (mode) => {
    const { home, A, B } = world();
    const old = createEntry(A, { kind: 'rule', title: 'Old rule' });
    brief(B);
    const offset = readCursor(home, 'B')!;
    const next = createEntry(A, { kind: 'rule', title: 'Elsewhere', scope: 'project:beta', until: B.now.toISOString().slice(0, 10) });
    supersedeEntry(A, old.id, next.id);
    const end = mode === 'chain'
      ? createEntry(A, { kind: 'rule', title: 'Terminal', scope: 'project:gamma', until: next.until }) : next;
    if (mode === 'chain') supersedeEntry(A, next.id, end.id);
    const entries = mode === 'chain' ? [old, next, end] : [old, next];
    const paths = [...entries.map((entry) => join(store.scopeDir(home, entry.scope), `${entry.id}.md`)), join(home, 'log.jsonl')];
    const bytes = paths.map((path) => readFileSync(path));
    const before = delta(B);
    expect(before).toEqual([{
      id: old.id, kind: 'rule', scope: 'project:alpha', title: 'Old rule', event: 'status', status: 'superseded',
      supersededBy: [next.id], current: end.id,
    }]);
    expect(readCursor(home, 'B')).toBe(logSize(home));
    writeCursor(home, 'B', offset);
    const after = delta({ ...B, now: new Date(B.now.getTime() + 86_400_000) });
    expect(after).toEqual(before.map((item) => ({ ...item, current: null })));
    expect(renderDelta(after)).toBe(`- [${old.id}] rule superseded: Old rule → ${next.id}\n`);
    expect(readCursor(home, 'B')).toBe(logSize(home));
    expect(delta(B)).toEqual([]);
    expect(paths.map((path) => readFileSync(path))).toEqual(bytes);
    expect(store.findEntry(home, end.id).status).toBe('active');
  });

  it('keeps hold release text before the arrow and enriches latest superseded status, not just status events', () => {
    const { A, B } = world();
    const old = createEntry(A, { kind: 'hold', title: 'Old hold', release: 'Tunnel closed' });
    brief(B);
    const next = createEntry(A, { kind: 'hold', title: 'New hold', release: 'Approved', scope: 'project:beta' });
    supersedeEntry(A, old.id, next.id);
    logChange(A, store.findEntry(A.home, old.id), 'updated');
    expect(lines(B)).toBe(`- [${old.id}] hold updated: Old hold — release: Tunnel closed → ${next.id}\n`);
  });

  it('CLI JSON includes direct ids but not rendering-only current, and preserves empty output', async () => {
    const { home, repo, A, B } = world();
    brief(B);
    const old = createEntry(A, { kind: 'rule', title: 'Old rule' });
    const next = createEntry(A, { kind: 'rule', title: 'Next', scope: 'project:beta' });
    supersedeEntry(A, old.id, next.id);
    const options = { cwd: repo, env: { LEEBOARD_SESSION: 'B', LEEBOARD_HARNESS: 'pi' } };
    const result = await lb(home, ['delta', '--json'], options);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out)).toEqual([{
      id: old.id, kind: 'rule', scope: 'project:alpha', title: 'Old rule', event: 'status', status: 'superseded', supersededBy: [next.id],
    }]);
    expect((await lb(home, ['delta', '--json'], options)).out).toBe('');
  });

  it('leaves unresolved entries unsuffixed with an empty direct-id array', async () => {
    const { home, repo, A, B } = world();
    brief(B);
    const old = createEntry(A, { kind: 'rule', title: 'Orphan' });
    const orphan = { ...old, status: 'superseded' as const };
    store.writeEntry(home, orphan);
    logChange(A, orphan, 'status');
    const offset = readCursor(home, 'B')!;
    expect(lines(B)).toBe(`- [${old.id}] rule superseded: Orphan\n`);
    writeCursor(home, 'B', offset);
    const result = await lb(home, ['delta', '--json'], { cwd: repo, env: { LEEBOARD_SESSION: 'B', LEEBOARD_HARNESS: 'pi' } });
    expect(JSON.parse(result.out)[0]).toMatchObject({ supersededBy: [] });
    expect(JSON.parse(result.out)[0]).not.toHaveProperty('current');
  });

  it('indexes once for several included superseded items and not for ordinary, excluded or empty deltas', () => {
    const { home, A, B } = world();
    brief(B);
    const scan = vi.spyOn(store, 'listEntries');
    const resolve = vi.spyOn(store, 'createSuccessorResolver');
    try {
      expect(delta(B)).toEqual([]);
      createEntry(A, { kind: 'rule', title: 'Ordinary' });
      delta(B);
      const excluded = createEntry(A, { kind: 'rule', title: 'Hidden', scope: 'project:beta' });
      const hiddenNext = createEntry(A, { kind: 'rule', title: 'Hidden replacement', scope: 'project:beta' });
      supersedeEntry(A, excluded.id, hiddenNext.id);
      expect(delta(B)).toEqual([]);
      expect(scan).not.toHaveBeenCalled();
      expect(resolve).not.toHaveBeenCalled();
      const first = createEntry(A, { kind: 'rule', title: 'First' });
      const second = createEntry(A, { kind: 'rule', title: 'Second' });
      const next = createEntry(A, { kind: 'rule', title: 'Merged', scope: 'project:beta' });
      supersedeEntry(A, first.id, next.id);
      supersedeEntry(A, second.id, next.id);
      expect(delta(B)).toHaveLength(2);
      expect(scan).toHaveBeenCalledExactlyOnceWith(home);
      expect(resolve).toHaveBeenCalledTimes(1);
      expect(resolve).toHaveBeenCalledWith(expect.any(Array), B.now);
    } finally { scan.mockRestore(); resolve.mockRestore(); }
  });
});

describe('delta', () => {
  it('folds unseen creation and revisions to the latest title, event and moved scope once', () => {
    const { home, A, B } = world();
    brief(B);
    const entry = createEntry(A, { kind: 'rule', title: 'Old', scope: 'project:beta' });
    reviseEntry(A, entry.id, { title: 'Intermediate' });
    reviseEntry(A, entry.id, { title: 'Latest', scope: 'project:alpha' });
    expect(delta(B)).toEqual([{ id: entry.id, kind: 'rule', scope: 'project:alpha', title: 'Latest', event: 'revised', status: 'active' }]);
    expect(lines(B)).toBe('');
    expect(readCursor(home, 'B')).toBe(logSize(home));
  });

  it('delivers an existing entry moved in and excludes an entry moved out', () => {
    const { home, A, B } = world();
    const into = createEntry(A, { kind: 'rule', title: 'Into', scope: 'project:beta' });
    const out = createEntry(A, { kind: 'rule', title: 'Out', scope: 'project:alpha' });
    brief(B);
    reviseEntry(A, into.id, { scope: 'project:alpha' });
    reviseEntry(A, out.id, { scope: 'project:beta' });
    expect(lines(B)).toBe(`- [${into.id}] rule revised: Into\n`);
    expect(lines(B)).toBe('');
    expect(readCursor(home, 'B')).toBe(logSize(home));
  });

  it('delivers moved handoffs through their target', () => {
    const { A, B } = world();
    const entry = createEntry(A, { kind: 'handoff', title: 'For B', to: 'session:B' });
    brief(B);
    reviseEntry(A, entry.id, { scope: 'project:beta' });
    expect(delta(B)).toMatchObject([{ id: entry.id, scope: 'project:beta', event: 'revised', to: 'session:B' }]);
    expect(lines(B)).toBe('');
  });

  it('suppresses the reader latest event before resolving a stale earlier scope', () => {
    const { home, A, B } = world();
    brief(B);
    const entry = createEntry(A, { kind: 'rule', title: 'Old' });
    reviseEntry(A, entry.id, { title: 'Other session' });
    reviseEntry(B, entry.id, { scope: 'project:beta' });
    reviseEntry(B, entry.id, { scope: 'project:alpha' });
    expect(lines(B)).toBe('');
    expect(readCursor(home, 'B')).toBe(logSize(home));
    expect(lines(B)).toBe('');
  });
  it('prints nothing without a session, and keeps no cursor for it', () => {
    const { home, repo, A, as } = world();
    createEntry(A, { kind: 'rule', title: 'A rule' });
    expect(delta(as(null, 'pi', repo))).toEqual([]);
    expect(renderDelta([])).toBe('');
    // Lock-free creation and anonymous delta must not create state or a cursor.
    expect(existsSync(join(home, 'state'))).toBe(false);
  });

  it('starts a session with no cursor at the end of the log: nothing, then only what comes later', () => {
    const { home, A, B } = world();
    createEntry(A, { kind: 'rule', title: 'Before B started' });
    expect(lines(B)).toBe('');
    expect(readCursor(home, 'B')).toBe(logSize(home));

    const later = createEntry(A, { kind: 'rule', title: 'After B started' });
    expect(lines(B)).toBe(`- [${later.id}] rule created: After B started\n`);
  });

  it("shows another session's hold with its release condition, once", () => {
    const { A, B } = world();
    brief(B);
    const hold = createEntry(A, { kind: 'hold', title: 'No Helmraiser runs', release: 'tunnel closed', blocks: ['helmraiser-run'] });

    expect(lines(B)).toBe(`- [${hold.id}] hold created: No Helmraiser runs — release: tunnel closed\n`);
    expect(lines(B)).toBe('');
  });

  it("does not show a session its own changes", () => {
    const { A } = world();
    brief(A);
    createEntry(A, { kind: 'rule', title: 'Mine' });
    expect(lines(A)).toBe('');
  });

  it('reports a release as the new status', () => {
    const { A, B } = world();
    const hold = createEntry(A, { kind: 'hold', title: 'No runs', release: 'tunnel closed' });
    brief(B);
    releaseHold(A, hold.id);
    expect(lines(B)).toBe(`- [${hold.id}] hold released: No runs — release: tunnel closed\n`);
  });

  it('collapses several events on one entry to the latest', () => {
    const { A, B } = world();
    brief(B);
    const rule = createEntry(A, { kind: 'rule', title: 'Short lived' });
    const request = createEntry(A, { kind: 'request', title: 'Please review', to: 'any' });
    replyToRequest(A, request.id, 'first');
    replyToRequest(A, request.id, 'second');
    revokeEntry(A, rule.id, 'oops');

    expect(lines(B)).toBe(
      `- [${request.id}] request updated: Please review\n` + `- [${rule.id}] rule revoked: Short lived\n`,
    );
  });

  it('keeps only scopes in play for the cwd: global, machine and the resolved project', () => {
    const { A, B, as } = world();
    const elsewhere = as('C', 'claude-code', tempDir('lb-plain-'));
    brief(B);
    brief(elsewhere);
    const project = createEntry(A, { kind: 'rule', title: 'In alpha' });
    const global = createEntry(A, { kind: 'rule', title: 'Everywhere', scope: 'global' });
    const machine = createEntry(A, { kind: 'rule', title: 'This laptop', scope: 'machine' });
    createEntry(A, { kind: 'rule', title: 'In beta', scope: 'project:beta' });

    expect(lines(B)).toBe(
      `- [${project.id}] rule created: In alpha\n` +
        `- [${global.id}] rule created: Everywhere\n` +
        `- [${machine.id}] rule created: This laptop\n`,
    );
    expect(lines(elsewhere)).toBe(
      `- [${global.id}] rule created: Everywhere\n` + `- [${machine.id}] rule created: This laptop\n`,
    );
  });

  it('includes handoffs and requests addressed to this session or harness even from other scopes', () => {
    const { A, B, as } = world();
    const claude = as('C', 'claude-code');
    brief(B);
    brief(claude);
    const toPi = createEntry(A, { kind: 'handoff', title: 'For pi', to: 'harness:pi', scope: 'project:beta' });
    const toB = createEntry(A, { kind: 'request', title: 'For session B', to: 'session:B', scope: 'project:beta' });
    const toClaude = createEntry(A, { kind: 'handoff', title: 'For claude', to: 'harness:claude-code', scope: 'project:beta' });
    createEntry(A, { kind: 'handoff', title: 'For session X', to: 'session:X', scope: 'project:beta' });

    expect(lines(B)).toBe(
      `- [${toPi.id}] handoff created: For pi\n` + `- [${toB.id}] request created: For session B\n`,
    );
    expect(lines(claude)).toBe(`- [${toClaude.id}] handoff created: For claude\n`);
  });

  it('advances the cursor even when nothing was relevant', () => {
    const { home, A, B } = world();
    brief(B);
    createEntry(A, { kind: 'rule', title: 'In beta', scope: 'project:beta' });
    expect(lines(B)).toBe('');
    expect(readCursor(home, 'B')).toBe(logSize(home));
  });

  it('treats a cursor past the end of the log as "nothing new" and resets it', () => {
    const { home, A, B } = world();
    createEntry(A, { kind: 'rule', title: 'Something' });
    writeCursor(home, 'B', logSize(home) + 1000);
    expect(lines(B)).toBe('');
    expect(readCursor(home, 'B')).toBe(logSize(home));
  });

  it('structured output carries the event and status, not just the text', () => {
    const { A, B } = world();
    brief(B);
    const hold = createEntry(A, { kind: 'hold', title: 'No runs', release: 'tunnel closed' });
    expect(delta(B)).toEqual([
      { id: hold.id, kind: 'hold', scope: 'project:alpha', event: 'created', status: 'active', title: 'No runs', release: 'tunnel closed' },
    ]);
  });
});
