import { describe, expect, it, vi } from 'vitest';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createEntry, releaseHold, replyToRequest, reviseEntry, revokeEntry, supersedeEntry } from '../src/change.js';
import { brief } from '../src/commands/brief.js';
import { delta } from '../src/commands/delta.js';
import { renderReview, renderReviewDigest, review, reviewCommand, reviewCounts } from '../src/commands/review.js';
import type { Ctx } from '../src/context.js';
import { type Status } from '../src/entry.js';
import { appendLog, logChange, logSize, readCursor, readReviewCursor, writeReviewCursor } from '../src/log.js';
import { readRevision, scopeDir, writeEntry } from '../src/store.js';
import * as store from '../src/store.js';
import { lb, sampleEntry, tempDir } from './helpers.js';

function world() {
  const home = tempDir();
  const cwd = tempDir();
  const A: Ctx = {
    home, cwd, now: new Date('2026-10-18T10:00:00Z'),
    identity: { harness: 'claude-code', session: 'abcdefgh-1234', origin: 'user-stated' },
  };
  const B: Ctx = { ...A, identity: { harness: 'pi', session: 'reviewer-session', origin: 'agent-inferred' } };
  return { home, A, B };
}

const empty = { new: [], changed: [], closed: [] };

describe('successor-aware owner review', () => {
  it.each(['direct', 'chain', 'revoked'] as const)('names a %s replacement on New items', async (mode) => {
    const { home, A, B } = world();
    const old = createEntry(A, { kind: 'rule', title: 'Old' });
    const next = createEntry(A, { kind: 'rule', title: 'Replacement', scope: 'project:elsewhere' });
    supersedeEntry(A, old.id, next.id);
    let target = next.id;
    if (mode === 'chain') {
      const current = createEntry(A, { kind: 'rule', title: 'Current', scope: 'machine' });
      supersedeEntry(A, next.id, current.id);
      target = current.id;
    } else if (mode === 'revoked') revokeEntry(A, next.id, 'No longer applies');
    const cursor = readReviewCursor(home);
    const data = reviewCommand(B, { peek: true });
    expect(readReviewCursor(home)).toBe(cursor);
    expect(data.closed).toEqual([]);
    expect(data.new.find((item) => item.id === old.id)).toMatchObject({
      status: 'superseded', supersededBy: [next.id], current: mode === 'revoked' ? null : target,
    });
    const expectedLine = `- [${old.id}] rule global: Old (claude-code/abcdefgh, user-stated) → ${target}`;
    expect(renderReview(data).split('\n')).toContain(expectedLine);
    const result = await lb(home, ['review', '--peek']);
    expect(result).toEqual({ code: 0, out: renderReview(data), err: '' });
    expect(readReviewCursor(home)).toBe(cursor);
    expect(reviewCommand(B)).toEqual(data);
    expect(readReviewCursor(home)).toBe(logSize(home));
    expect(reviewCommand(B)).toEqual(empty);
  });

  it('keeps Closed classification, attribution and every revision hint before supersede', async () => {
    const { home, A, B } = world();
    const old = createEntry(A, { kind: 'rule', title: 'Original', body: 'Original body' });
    review(B);
    reviseEntry(A, old.id, { title: 'Middle', scope: 'machine' });
    reviseEntry(A, old.id, { title: 'Final', body: 'Final body' });
    const next = createEntry(A, { kind: 'rule', title: 'Replacement' });
    supersedeEntry(A, old.id, next.id);
    const data = reviewCommand(B, { peek: true });
    expect(data.closed[0]).toMatchObject({
      id: old.id, supersededBy: [next.id], current: next.id,
      before: { title: old.title, body: old.body, scope: old.scope },
      revisionChanges: ['was: Original', 'scope: global → machine', 'was: Middle', 'body revised'],
    });
    expect(renderReview(data)).toContain(`## Closed\n- [${old.id}] rule machine: Final (claude-code/abcdefgh, user-stated) → ${next.id}\n` +
      '  was: Original\n  scope: global → machine\n  was: Middle\n  body revised\n');
    const cursor = readReviewCursor(home);
    const result = await lb(home, ['review', '--peek', '--json']);
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.out);
    expect(parsed.closed[0]).toMatchObject({ supersededBy: [next.id], before: data.closed[0]!.before, revisionChanges: data.closed[0]!.revisionChanges });
    for (const item of [...parsed.new, ...parsed.changed, ...parsed.closed]) expect(item).not.toHaveProperty('current');
    expect(parsed.new[0]).not.toHaveProperty('supersededBy');
    expect(readReviewCursor(home)).toBe(cursor);
    expect((await lb(home, ['review', '--json'])).out).toBe(result.out);
    expect(readReviewCursor(home)).toBe(logSize(home));
    expect((await lb(home, ['review', '--json'])).out).toBe('');
  });

  it.each(['missing', 'cycle'] as const)('handles a %s chain without looping or inventing current ids', async (mode) => {
    const { home, A, B } = world();
    const old = sampleEntry({ id: 'rule-old-0001', title: 'Orphan', status: 'superseded' });
    if (mode === 'cycle') {
      old.supersedes = ['rule-next-0002'];
      writeEntry(home, sampleEntry({ id: 'rule-next-0002', status: 'superseded', supersedes: [old.id] }));
    }
    writeEntry(home, old);
    logChange(A, old, 'created');
    const data = reviewCommand(B, { peek: true });
    expect(data.new[0]).toMatchObject({ supersededBy: mode === 'missing' ? [] : ['rule-next-0002'], current: null });
    expect(renderReview(data)).toBe(`## New\n- [${old.id}] rule global: Orphan (claude-code/A, agent-inferred)${mode === 'missing' ? '' : ' → rule-next-0002'}\n`);
    const result = await lb(home, ['review', '--peek', '--json']);
    expect(JSON.parse(result.out).new[0].supersededBy).toEqual(mode === 'missing' ? [] : ['rule-next-0002']);
    expect(JSON.parse(result.out).new[0]).not.toHaveProperty('current');
  });

  it('keeps lightweight review and brief free of successor indexing, then indexes CLI items once', () => {
    const { home, A, B } = world();
    const first = createEntry(A, { kind: 'rule', title: 'First' });
    const second = createEntry(A, { kind: 'rule', title: 'Second' });
    const next = createEntry(A, { kind: 'rule', title: 'Merged' });
    supersedeEntry(A, first.id, next.id);
    supersedeEntry(A, second.id, next.id);
    const resolve = vi.spyOn(store, 'createSuccessorResolver');
    const scan = vi.spyOn(store, 'listEntries');
    try {
      expect(reviewCounts(review(B, { peek: true }))).toEqual({ new: 3, changed: 0, closed: 0 });
      brief(B);
      expect(resolve).not.toHaveBeenCalled();
      expect(readReviewCursor(home)).toBe(0);
      scan.mockClear();
      const data = reviewCommand(B, { peek: true });
      expect(data.new.filter((item) => item.supersededBy)).toHaveLength(2);
      expect(resolve).toHaveBeenCalledTimes(1);
      expect(scan).toHaveBeenCalledExactlyOnceWith(home);
    } finally { resolve.mockRestore(); scan.mockRestore(); }
  });

  it('leaves ordinary review output, counts and metadata unchanged without indexing', () => {
    const { A, B } = world();
    createEntry(A, { kind: 'rule', title: 'Ordinary' });
    const light = review(B, { peek: true });
    const resolve = vi.spyOn(store, 'createSuccessorResolver');
    try {
      const full = reviewCommand(B, { peek: true });
      expect(full).toEqual(light);
      expect(renderReview(full)).toBe(renderReview(light));
      expect(reviewCounts(full)).toEqual({ new: 1, changed: 0, closed: 0 });
      expect(resolve).not.toHaveBeenCalled();
    } finally { resolve.mockRestore(); }
  });
});

describe('revision review details', () => {
  it('classifies revised existing entries as Changed and created/revised as New, rendering exact hints', () => {
    const { home, A, B } = world();
    const existing = createEntry(A, { kind: 'rule', title: 'Old title', body: 'Old body' });
    review(B);
    const moved = reviseEntry(A, existing.id, { title: 'New title', body: 'New body', scope: 'machine' });
    const fresh = createEntry(A, { kind: 'rule', title: 'Fresh' });
    reviseEntry(A, fresh.id, { title: 'Fresh tightened' });
    expect(existsSync(join(scopeDir(home, 'global'), `${existing.id}.md`))).toBe(false);
    const data = review(B, { details: true, peek: true });
    expect(data.changed[0]!.before).toEqual({ title: existing.title, body: existing.body, scope: 'global', updated: existing.updated });
    expect(data.changed[0]!.revisionChanges).toEqual(['was: Old title', 'scope: global → machine', 'body revised']);
    expect(data.new[0]).toMatchObject({ id: fresh.id, title: 'Fresh tightened', before: { title: 'Fresh' } });
    expect(renderReview({ new: [], changed: data.changed, closed: [] })).toBe(`## Changed\n- [${existing.id}] rule machine: New title (claude-code/abcdefgh, user-stated)\n  was: Old title\n  scope: global → machine\n  body revised\n`);
    expect(data.changed[0]!.title).toBe(moved.title);
    expect(reviewCounts(data)).toEqual({ new: 1, changed: 1, closed: 0 });
    expect(review(B, { details: true })).toEqual(data);
    expect(review(B, { details: true })).toEqual(empty);
  });

  it.each([false, true])('keeps lifecycle-active revisions visible after until passes (details=%s)', (details) => {
    const { home, A, B } = world();
    const existing = createEntry(A, { kind: 'request', title: 'Original', to: 'any' });
    review(B);
    reviseEntry(A, existing.id, { title: 'Revised', until: '2026-10-17' });
    replyToRequest(A, existing.id, 'Later reply');
    const data = review(B, { details, peek: true });
    expect(data.changed).toMatchObject([{ id: existing.id, title: 'Revised', status: 'active' }]);
    expect(data.new).toEqual([]);
    expect(data.closed).toEqual([]);
    expect(reviewCounts(data)).toEqual({ new: 0, changed: 1, closed: 0 });
    if (details) expect(data.changed[0]!.before!.title).toBe('Original');
    else expect(data.changed[0]).not.toHaveProperty('before');

    // Expiry dates must not override either New or Closed precedence.
    const fresh = createEntry(A, { kind: 'rule', title: 'Fresh' });
    reviseEntry(A, fresh.id, { title: 'Fresh revised', until: '2026-10-17' });
    revokeEntry(A, existing.id, 'Closed');
    const final = review(B, { details });
    expect(final.new.map((item) => item.id)).toEqual([fresh.id]);
    expect(final.changed).toEqual([]);
    expect(final.closed.map((item) => item.id)).toEqual([existing.id]);
    expect(readReviewCursor(home)).toBe(logSize(home));
    expect(review(B, { details })).toEqual(empty);
  });

  it('retains every same-second revision hint, including reversals and earliest snapshot', () => {
    const { A, B } = world();
    const entry = createEntry(A, { kind: 'rule', title: 'Original', body: 'Body' });
    review(B);
    reviseEntry(A, entry.id, { title: 'Second', scope: 'machine' });
    reviseEntry(A, entry.id, { title: 'Original', scope: 'global', body: 'Revised body' });
    const item = review(B, { details: true }).changed[0]!;
    expect(item.before).toEqual({ title: entry.title, body: entry.body, scope: entry.scope, updated: entry.updated });
    expect(item.revisionChanges).toEqual(['was: Original', 'scope: global → machine', 'was: Second', 'scope: machine → global', 'body revised']);
  });

  it('uses the exact history offset when the cursor falls between same-second revisions', () => {
    const { home, A, B } = world();
    const entry = createEntry(A, { kind: 'rule', title: 'Original' });
    reviseEntry(A, entry.id, { title: 'Café 船' });
    writeReviewCursor(home, logSize(home));
    reviseEntry(A, entry.id, { title: 'Third' });
    const item = review(B, { details: true }).changed[0]!;
    expect(item.before!.title).toBe('Café 船');
    expect(item.revisionChanges).toEqual(['was: Café 船']);
  });

  it('includes earliest before in CLI peek JSON without acknowledging', async () => {
    const { home, A, B } = world();
    const entry = createEntry(A, { kind: 'rule', title: 'Old' });
    review(B);
    const cursor = readReviewCursor(home);
    reviseEntry(A, entry.id, { title: 'Middle' });
    reviseEntry(A, entry.id, { title: 'New' });
    const result = await lb(home, ['review', '--peek', '--json']);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out).changed[0].before).toEqual(readRevision(home, entry.id, 0)!.before);
    expect(readReviewCursor(home)).toBe(cursor);
  });

  it('does not mistake later reply or revoke sections for revised bodies', () => {
    const { A, B } = world();
    const entry = createEntry(A, { kind: 'request', title: 'Old', to: 'any' });
    review(B);
    reviseEntry(A, entry.id, { title: 'Tightened' });
    replyToRequest(A, entry.id, 'Reply body');
    expect(review(B, { details: true, peek: true }).changed[0]!.revisionChanges).toEqual(['was: Old']);
    revokeEntry(A, entry.id, 'No longer needed');
    expect(review(B, { details: true }).closed[0]!.revisionChanges).toEqual(['was: Old']);
  });

  it('keeps normal items and readable details if part or all of history is unavailable', () => {
    const { home, A, B } = world();
    const entry = createEntry(A, { kind: 'rule', title: 'First' });
    review(B);
    reviseEntry(A, entry.id, { title: 'Second' });
    reviseEntry(A, entry.id, { title: 'Third' });
    const path = join(home, 'revisions', `${entry.id}.jsonl`);
    const bytes = readFileSync(path);
    bytes.fill(120, 0, bytes.indexOf(10)); // damage only the first record, retaining byte offsets
    writeFileSync(path, bytes);
    const item = review(B, { details: true, peek: true }).changed[0]!;
    expect(item.before!.title).toBe('Second');
    expect(item.revisionChanges).toEqual(['was: Second']);
    rmSync(path);
    const missing = review(B, { details: true }).changed[0]!;
    expect(missing.id).toBe(entry.id);
    expect(missing).not.toHaveProperty('before');
    expect(missing).not.toHaveProperty('revisionChanges');
  });

  it('does not read history by default, keeping lightweight counts and optional keys absent', () => {
    const { A, B } = world();
    const entry = createEntry(A, { kind: 'rule', title: 'Old' });
    review(B);
    reviseEntry(A, entry.id, { title: 'New' });
    const spy = vi.spyOn(store, 'readRevision');
    try {
      const data = review(B, { peek: true });
      expect(reviewCounts(data)).toEqual({ new: 0, changed: 1, closed: 0 });
      expect(data.changed[0]).not.toHaveProperty('before');
      expect(data.changed[0]).not.toHaveProperty('revisionChanges');
      expect(spy).not.toHaveBeenCalled();
    } finally { spy.mockRestore(); }
  });
});

describe('owner review', () => {
  it('starts at zero without a cursor, includes every scope and its own changes, then acknowledges once', () => {
    const { home, A } = world();
    expect(readReviewCursor(home)).toBe(0);
    const global = createEntry(A, { kind: 'rule', title: 'Global' });
    const machine = createEntry(A, { kind: 'reference', title: 'Machine', scope: 'machine' });
    const elsewhere = createEntry(A, { kind: 'rule', title: 'Other project', scope: 'project:elsewhere' });
    const data = review(A);
    expect(data.new.map((item) => item.id)).toEqual([global.id, machine.id, elsewhere.id]);
    expect(data.changed).toEqual([]);
    expect(data.closed).toEqual([]);
    expect(renderReview(data)).toBe(`## New
- [${global.id}] rule global: Global (claude-code/abcdefgh, user-stated)
- [${machine.id}] reference machine: Machine (claude-code/abcdefgh, user-stated)
- [${elsewhere.id}] rule project:elsewhere: Other project (claude-code/abcdefgh, user-stated)
`);
    expect(readReviewCursor(home)).toBe(logSize(home));
    expect(JSON.parse(readFileSync(join(home, 'state', 'review.json'), 'utf8'))).toEqual({ offset: logSize(home) });
    expect(review(A)).toEqual(empty);
    expect(renderReview(review(A))).toBe('');
  });

  it('groups New / Changed / Closed once per entry, retaining new entries even after they close', () => {
    const { A, B } = world();
    const request = createEntry(A, { kind: 'request', title: 'Review me', to: 'any' });
    const hold = createEntry(A, { kind: 'hold', title: 'Freeze', release: 'told' });
    review(B);

    replyToRequest(A, request.id, 'first');
    replyToRequest(B, request.id, 'second');
    const fresh = createEntry(A, { kind: 'rule', title: 'Short lived' });
    revokeEntry(B, fresh.id, 'mistake');
    releaseHold(B, hold.id);

    const data = review(B);
    // New entries name their creator; changed and closed ones name who made the change.
    expect(data.new).toMatchObject([{ id: fresh.id, status: 'revoked', harness: 'claude-code', session: 'abcdefgh-1234' }]);
    expect(data.changed).toMatchObject([{ id: request.id, status: 'active', harness: 'pi' }]);
    expect(data.closed).toMatchObject([{ id: hold.id, status: 'released', harness: 'pi' }]);
    expect(renderReview(data).match(/^## .+$/gm)).toEqual(['## New', '## Changed', '## Closed']);
    expect(renderReview(data).match(/^- \[/gm)).toHaveLength(3);
    expect(reviewCounts(data)).toEqual({ new: 1, changed: 1, closed: 1 });
    expect(renderReviewDigest(reviewCounts(data))).toBe('Owner review: 1 new, 1 changed, 1 closed since the last review — run `lb review`');
  });

  it.each<Status>(['released', 'done', 'revoked', 'superseded', 'retired', 'expired'])(
    'classifies an existing entry moved to %s as Closed, even with a later update', (status) => {
      const { home, A } = world();
      const entry = createEntry(A, { kind: 'rule', title: 'Existing' });
      review(A);
      entry.status = status;
      writeEntry(home, entry);
      logChange(A, entry, 'status');
      logChange(A, entry, 'updated');
      expect(review(A)).toMatchObject({ new: [], changed: [], closed: [{ id: entry.id, status }] });
    },
  );

  it('uses the current title and origin from disk, not historical text or the reviewer identity', () => {
    const { home, A, B } = world();
    const entry = createEntry(A, { kind: 'rule', title: 'Old title' });
    entry.title = 'Current title';
    writeEntry(home, entry);
    expect(review(B).new[0]).toEqual({
      id: entry.id, kind: 'rule', scope: 'global', title: 'Current title', status: 'active',
      harness: 'claude-code', session: 'abcdefgh-1234', origin: 'user-stated',
    });
  });

  it('skips missing files but still advances past their events', () => {
    const { home, A } = world();
    const entry = createEntry(A, { kind: 'rule', title: 'Gone' });
    rmSync(join(scopeDir(home, entry.scope), `${entry.id}.md`));
    expect(review(A)).toEqual(empty);
    expect(readReviewCursor(home)).toBe(logSize(home));
  });

  it('peek never creates or advances the review cursor', () => {
    const { home, A } = world();
    createEntry(A, { kind: 'rule', title: 'First' });
    const first = review(A, { peek: true });
    expect(first.new).toHaveLength(1);
    expect(existsSync(join(home, 'state', 'review.json'))).toBe(false);
    expect(review(A)).toEqual(first);
    const cursor = readReviewCursor(home);
    createEntry(A, { kind: 'rule', title: 'Second' });
    expect(review(A, { peek: true }).new).toHaveLength(1);
    expect(readReviewCursor(home)).toBe(cursor);
    expect(review(A).new).toHaveLength(1);
  });

  it('is independent of brief and delta cursors in both directions', () => {
    const { home, A, B } = world();
    brief(B);
    const first = createEntry(A, { kind: 'rule', title: 'First' });
    const sessionCursor = readCursor(home, B.identity.session!);
    review(A);
    expect(readCursor(home, B.identity.session!)).toBe(sessionCursor);
    expect(delta(B).map((item) => item.id)).toEqual([first.id]);
    const ownerCursor = readReviewCursor(home);
    const second = createEntry(A, { kind: 'rule', title: 'Second' });
    expect(delta(B).map((item) => item.id)).toEqual([second.id]);
    brief(B);
    expect(readReviewCursor(home)).toBe(ownerCursor);
    expect(review(A).new.map((item) => item.id)).toEqual([second.id]);
  });

  it('handles empty logs and resets a cursor beyond the end', () => {
    const { home, A } = world();
    expect(review(A, { peek: true })).toEqual(empty);
    expect(existsSync(join(home, 'state'))).toBe(false);
    writeReviewCursor(home, 1000);
    expect(review(A)).toEqual(empty);
    expect(readReviewCursor(home)).toBe(0);
  });

  it.each(['not json', '{"offset":-1}', '{"offset":1.5}', '{"offset":"1"}'])(
    'treats an invalid cursor as unseen: %s', (text) => {
      const { home, A } = world();
      createEntry(A, { kind: 'rule', title: 'Unseen' });
      mkdirSync(join(home, 'state'), { recursive: true });
      writeFileSync(join(home, 'state', 'review.json'), text);
      expect(readReviewCursor(home)).toBe(0);
      expect(review(A).new).toHaveLength(1);
    },
  );

  it('uses byte offsets and leaves partial trailing lines for the next review', () => {
    const { home, A } = world();
    const entry = createEntry(A, { kind: 'rule', title: 'Résumé — café' });
    // Exercise a multibyte log field too; the log does not carry titles.
    appendLog(home, { ts: '2026-10-18T10:00:00Z', id: entry.id, kind: entry.kind, scope: entry.scope,
      event: 'updated', status: 'active', harness: 'pi', session: 'é-session' });
    const end = logSize(home);
    appendFileSync(join(home, 'log.jsonl'), '{"partial":');
    expect(review(A).new).toHaveLength(1);
    expect(readReviewCursor(home)).toBe(end);
    appendFileSync(join(home, 'log.jsonl'), 'bad}\n');
    expect(review(A)).toEqual(empty);
    expect(readReviewCursor(home)).toBe(logSize(home));
  });

  it('does not count updates to an already closed entry as a new closure', () => {
    const { home, A } = world();
    const entry = createEntry(A, { kind: 'rule', title: 'Old' });
    const revoked = revokeEntry(A, entry.id, 'obsolete');
    review(A);
    writeEntry(home, revoked);
    logChange(A, revoked, 'updated');
    expect(review(A)).toEqual(empty);
  });

  it('omits zero counts in the digest and renders nothing for all-zero counts', () => {
    expect(renderReviewDigest({ new: 0, changed: 2, closed: 0 })).toBe('Owner review: 2 changed since the last review — run `lb review`');
    expect(renderReviewDigest({ new: 0, changed: 0, closed: 0 })).toBe('');
  });
});
