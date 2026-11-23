import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { reviseEntry, type RevisionInput } from '../src/change.js';
import type { Ctx } from '../src/context.js';
import { KINDS, STATUSES } from '../src/entry.js';
import { LeeboardError } from '../src/errors.js';
import { readLogSince } from '../src/log.js';
import { findEntry, readRevision, scopeDir, writeEntry } from '../src/store.js';
import { sampleEntry, tempDir } from './helpers.js';

function world() {
  const ctx: Ctx = {
    home: tempDir(), cwd: tempDir(), now: new Date('2026-10-22T12:00:00Z'),
    identity: { harness: 'pi', session: 'reviser', origin: 'agent-inferred' },
  };
  const entry = sampleEntry({ until: '2027-01-01', release: 'Owner says so', holder: 'owner', to: 'any', blocks: ['push'], body: 'Old body\n', source: '/memory/file', supersedes: ['rule-old-0000'] });
  writeEntry(ctx.home, entry);
  return { ctx, entry };
}

function fails(fn: () => unknown, code: number) {
  try { fn(); } catch (error) {
    expect(error).toBeInstanceOf(LeeboardError);
    expect((error as LeeboardError).exitCode).toBe(code);
    return;
  }
  throw new Error('expected refusal');
}

function untouched(ctx: Ctx, entry: ReturnType<typeof sampleEntry>) {
  expect(findEntry(ctx.home, entry.id)).toEqual(entry);
  expect(existsSync(join(ctx.home, 'revisions'))).toBe(false);
  expect(readLogSince(ctx.home, 0).lines).toEqual([]);
}

describe('reviseEntry', () => {
  it.each(KINDS)('revises active %s fields while preserving identity and attribution', (kind) => {
    const { ctx, entry } = world();
    entry.kind = kind;
    writeEntry(ctx.home, entry);
    const result = reviseEntry(ctx, 'rule-sample', {
      title: '  New\n title ', body: 'New body\n\n', scope: 'project:alpha',
      until: '2027-02-01T12:34:56+02:00', release: ' New  release ', blocks: ['merge'], holder: ' new owner ', to: 'session:next',
    });
    expect(result).toEqual({ ...entry, title: 'New title', body: 'New body\n', scope: 'project:alpha', updated: '2026-10-22T12:00:00Z', until: '2027-02-01T12:34:56+02:00', release: 'New release', blocks: ['merge'], holder: 'new owner', to: 'session:next' });
    expect(findEntry(ctx.home, entry.id)).toEqual(result);
    expect(readdirSync(scopeDir(ctx.home, 'global'))).toEqual([]);
    expect(readdirSync(scopeDir(ctx.home, result.scope))).toEqual([`${entry.id}.md`]);
    const lines = readLogSince(ctx.home, 0).lines;
    expect(lines).toEqual([{ ts: result.updated, id: entry.id, kind, scope: 'project:alpha', event: 'revised', status: 'active', harness: 'pi', session: 'reviser', revision: { offset: 0, fields: ['title', 'body', 'scope'] } }]);
    expect(readRevision(ctx.home, entry.id, 0)).toEqual({
      ts: result.updated, harness: 'pi', session: 'reviser',
      before: { title: entry.title, body: entry.body, scope: entry.scope, updated: entry.updated, until: entry.until, release: entry.release, blocks: entry.blocks, holder: entry.holder, to: entry.to },
    });
  });

  it('appends distinct snapshots even in the same second, including normalized no-ops', () => {
    const { ctx, entry } = world();
    const first = reviseEntry(ctx, entry.id, { title: 'First' });
    reviseEntry(ctx, entry.id, { title: ' First\n ' });
    const lines = readLogSince(ctx.home, 0).lines;
    expect(lines).toHaveLength(2);
    expect(lines[1]!.revision!.offset).toBeGreaterThan(0);
    expect(lines[1]!.revision!.fields).toEqual([]);
    expect(readRevision(ctx.home, entry.id, lines[1]!.revision!.offset)!.before).toEqual({ title: first.title, body: first.body, scope: first.scope, updated: first.updated, until: first.until, release: first.release, blocks: first.blocks, holder: first.holder, to: first.to });
  });

  it('clears body and blocks, preserving omitted fields', () => {
    const { ctx, entry } = world();
    const result = reviseEntry(ctx, entry.id, { body: '', blocks: [], title: undefined });
    expect(result).toEqual({ ...entry, body: '', blocks: [], updated: '2026-10-22T12:00:00Z' });
  });

  it('omits absent optional snapshot properties', () => {
    const { ctx } = world();
    const entry = sampleEntry();
    writeEntry(ctx.home, entry);
    reviseEntry(ctx, entry.id, { title: 'New' });
    expect(readRevision(ctx.home, entry.id, 0)!.before).toEqual({ title: entry.title, body: '', scope: 'global', updated: entry.updated });
  });

  it.each([{}, { title: undefined }])('rejects missing fields with exit 1', (input) => {
    const { ctx, entry } = world();
    fails(() => reviseEntry(ctx, entry.id, input), 1);
    untouched(ctx, entry);
  });

  it('rejects unknown and ambiguous prefixes with exit 4', () => {
    const { ctx, entry } = world();
    writeEntry(ctx.home, sampleEntry({ id: 'rule-second-0002' }));
    fails(() => reviseEntry(ctx, 'missing', { title: 'new' }), 4);
    fails(() => reviseEntry(ctx, 'rule-', { title: 'new' }), 4);
    untouched(ctx, entry);
  });

  it.each(STATUSES.filter((status) => status !== 'active'))('rejects status %s with exit 5', (status) => {
    const { ctx, entry } = world();
    entry.status = status;
    writeEntry(ctx.home, entry);
    fails(() => reviseEntry(ctx, entry.id, { title: 'new' }), 5);
    untouched(ctx, entry);
  });

  it.each(['title', 'body', 'scope', 'until', 'release', 'blocks', 'holder', 'to'] as const)('rejects raw credentials in %s before lookup or permissions', (field) => {
    const { ctx, entry } = world();
    ctx.identity.harness = 'helmraiser';
    const secret = 'ghp_' + 'abcd1234'.repeat(4);
    const input = { [field]: field === 'blocks' ? [secret] : secret } as RevisionInput;
    fails(() => reviseEntry(ctx, 'missing', input), 2);
    fails(() => reviseEntry(ctx, entry.id, input), 2);
    untouched(ctx, entry);
  });

  it.each(['body', 'updated'] as const)('refuses to archive a hand-edited credential in %s', (field) => {
    const { ctx, entry } = world();
    entry[field] = 'Bearer ' + 'abcdef0123456789'.repeat(2);
    writeEntry(ctx.home, entry);
    fails(() => reviseEntry(ctx, entry.id, { body: 'clean' }), 2);
    untouched(ctx, entry);
  });

  it.each([
    ['rule', { title: '' }], ['hold', { release: '' }], ['grant', { holder: ' ' }],
    ['handoff', { to: '' }], ['request', { to: 'harness:invalid' }],
    ['rule', { scope: 'project:../bad' }], ['rule', { until: '2026-02-30' }],
    ['rule', { until: 'October 22, 2026' }],
  ] as const)('invalid %s candidate persists nothing', (kind, input) => {
    const { ctx, entry } = world();
    entry.kind = kind;
    writeEntry(ctx.home, entry);
    fails(() => reviseEntry(ctx, entry.id, input), 1);
    untouched(ctx, entry);
  });

  it('validates required fields on the full candidate, even when omitted', () => {
    const { ctx, entry } = world();
    entry.kind = 'hold';
    delete entry.release;
    writeEntry(ctx.home, entry);
    fails(() => reviseEntry(ctx, entry.id, { title: 'new' }), 1);
    untouched(ctx, entry);
  });

  it.each(
    (['helmraiser'] as const).flatMap((harness) => [
      [harness, 'A', 'rule', true], [harness, 'foreign', 'rule', false], [harness, null, 'rule', false],
      [harness, 'A', 'hold', false], [harness, 'A', 'grant', false],
    ] as const),
  )('%s session %s revising %s: permitted=%s', (harness, session, kind, permitted) => {
    const { ctx, entry } = world();
    entry.kind = kind;
    writeEntry(ctx.home, entry);
    ctx.identity = { harness, session, origin: 'agent-inferred' };
    if (permitted) expect(reviseEntry(ctx, entry.id, { title: 'new' }).id).toBe(entry.id);
    else { fails(() => reviseEntry(ctx, entry.id, { title: 'new' }), 6); untouched(ctx, entry); }
  });

  it('allows Bosun to revise owner words without changing attribution', () => {
    const { ctx, entry } = world();
    entry.author.origin = 'user-stated';
    writeEntry(ctx.home, entry);
    ctx.identity.harness = 'bosun';
    expect(reviseEntry(ctx, entry.id, { title: 'Tightened' }).author).toEqual(entry.author);
    expect(readRevision(ctx.home, entry.id, 0)!.harness).toBe('bosun');
  });

  it('does not write entry or log when history append fails', () => {
    const { ctx, entry } = world();
    writeFileSync(join(ctx.home, 'revisions'), 'not a directory');
    expect(() => reviseEntry(ctx, entry.id, { title: 'new' })).toThrow();
    expect(findEntry(ctx.home, entry.id)).toEqual(entry);
    expect(readLogSince(ctx.home, 0).lines).toEqual([]);
  });

  it('keeps large old bodies exclusively in history and log lines below 4 KB', () => {
    const { ctx, entry } = world();
    entry.body = 'Historical text 船'.repeat(1000);
    writeEntry(ctx.home, entry);
    reviseEntry(ctx, entry.id, { body: 'Replacement' });
    expect(readRevision(ctx.home, entry.id, 0)!.before.body).toBe(entry.body);
    const log = readFileSync(join(ctx.home, 'log.jsonl'), 'utf8');
    expect(Buffer.byteLength(log)).toBeLessThan(4096);
    expect(log).not.toContain('Historical text');
    expect(log).not.toContain('Replacement');
  });
});
