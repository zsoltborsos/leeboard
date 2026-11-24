import { describe, expect, it } from 'vitest';
import { type Entry, entryIdsIn, isActive, staleHoldDays, KINDS, parseEntry, serializeEntry } from '../src/entry.js';

describe('entry file format', () => {
  const hold: Entry = {
    id: 'hold-no-helmraiser-runs-7f3a',
    kind: 'hold',
    scope: 'project:api',
    status: 'active',
    title: 'No Helmraiser runs while the Webshop prod tunnel is open',
    author: { harness: 'claude-code', session: 'd58c4a89', origin: 'user-stated' },
    created: '2026-10-17T14:02:11Z',
    updated: '2026-10-17T14:02:11Z',
    until: '2026-11-03',
    release: 'Webshop prod SSH tunnel closed, or the owner says so',
    blocks: ['helmraiser-run'],
    body: 'Prod ops and Helmraiser runs contend for the same tunnel.\n',
  };

  // Written by hand from design section 5.2, not produced by serializeEntry.
  const holdFile = `---
id: hold-no-helmraiser-runs-7f3a
kind: hold
scope: project:api
status: active
title: No Helmraiser runs while the Webshop prod tunnel is open
author:
  harness: claude-code
  session: d58c4a89
  origin: user-stated
created: 2026-10-17T14:02:11Z
updated: 2026-10-17T14:02:11Z
until: 2026-11-03
release: Webshop prod SSH tunnel closed, or the owner says so
blocks: [helmraiser-run]
---
Prod ops and Helmraiser runs contend for the same tunnel.
`;

  it('serialises to the layout of design section 5.2', () => {
    expect(serializeEntry(hold)).toBe(holdFile);
  });

  it('parses that layout back to the same entry', () => {
    expect(parseEntry(holdFile)).toEqual(hold);
  });

  it('round-trips an anonymous author, an empty body and every optional field', () => {
    const full: Entry = {
      id: 'request-review-x-0001',
      kind: 'request',
      scope: 'global',
      status: 'done',
      title: 'Review x',
      author: { harness: null, session: null, origin: 'agent-inferred' },
      created: '2026-10-17T14:02:11Z',
      updated: '2026-10-18T09:00:00Z',
      until: '2026-12-01T10:00:00Z',
      release: 'when done',
      holder: 'api-93',
      to: 'harness:pi',
      supersedes: ['rule-a-0001', 'rule-b-0002'],
      blocks: ['a', 'b'],
      body: '',
    };
    expect(parseEntry(serializeEntry(full))).toEqual(full);
  });

  it.each([
    'Colon: inside, # hash and "quotes"',
    "- leading dash and 'single quotes'",
    'yes',
    'null',
    '12345',
    '日本語 title with ünïcode',
    'A very long title '.repeat(12).trim(),
  ])('round-trips the title %j', (title) => {
    const entry = { ...hold, title, author: { ...hold.author, session: '42' } };
    expect(parseEntry(serializeEntry(entry))).toEqual(entry);
  });

  it('keeps a body that itself contains a --- line', () => {
    const entry = { ...hold, body: 'before\n---\nafter\n' };
    expect(parseEntry(serializeEntry(entry))).toEqual(entry);
  });

  it('rejects text without frontmatter', () => {
    expect(() => parseEntry('just text\n')).toThrow(/frontmatter/);
  });
});

describe('entryIdsIn', () => {
  it('recognizes all kinds, multi-segment slugs and hexadecimal suffixes', () => {
    const ids = KINDS.map((kind) => `${kind}-many-words-42-ab9f`);
    expect(entryIdsIn(ids.join(' '))).toEqual(ids.sort());
  });

  it('accepts prose punctuation, inline code and Markdown links; deduplicates and sorts', () => {
    expect(entryIdsIn('See `rule-z-abcd`, [hold-a-1234](reference-docs-a0ef); (rule-z-abcd)!'))
      .toEqual(['hold-a-1234', 'reference-docs-a0ef', 'rule-z-abcd']);
  });

  it.each([
    'unknown-slug-1234', 'rule-1234', 'rule--1234', 'rule-a--b-1234',
    'rule-a-123', 'rule-a-12345', 'rule-a-12gh', 'rule-a-ABCD', 'Rule-a-abcd',
    'xrule-a-abcd', '0rule-a-abcd', '_rule-a-abcd', '-rule-a-abcd',
    'rule-a-abcdx', 'rule-a-abcd0', 'rule-a-abcd_', 'rule-a-abcd-',
  ])('rejects malformed or embedded ids: %s', (text) => {
    expect(entryIdsIn(text)).toEqual([]);
  });

  it('handles empty input and repeated calls without leaking regex state', () => {
    expect(entryIdsIn('')).toEqual([]);
    for (let i = 0; i < 3; i++) expect(entryIdsIn('rule-a-abcd')).toEqual(['rule-a-abcd']);
  });
});

describe('staleHoldDays', () => {
  const now = new Date('2026-10-17T12:00:00Z');

  it.each([
    ['2026-10-10T12:00:00Z', 7],
    ['2026-10-10T12:00:00.001Z', undefined],
    ['2026-10-07T00:00:00Z', 10],
    ['2026-10-18T12:00:00Z', undefined],
    ['not a timestamp', undefined],
  ])('reports whole stale days for %s', (updated, expected) => {
    expect(staleHoldDays({ updated }, now)).toBe(expected);
  });
});

describe('isActive', () => {
  const now = new Date('2026-11-03T12:00:00Z');
  const base = { status: 'active' as const };

  it('is active without an until', () => {
    expect(isActive(base, now)).toBe(true);
  });

  it('is not active once the status moved on', () => {
    for (const status of ['released', 'revoked', 'superseded', 'done', 'retired'] as const) {
      expect(isActive({ status }, now)).toBe(false);
    }
  });

  it('treats a date-only until as the whole of that day', () => {
    expect(isActive({ ...base, until: '2026-11-04' }, now)).toBe(true);
    expect(isActive({ ...base, until: '2026-11-03' }, now)).toBe(true);
    expect(isActive({ ...base, until: '2026-11-02' }, now)).toBe(false);
  });

  it('treats a date-time until as that instant', () => {
    expect(isActive({ ...base, until: '2026-11-03T12:00:01Z' }, now)).toBe(true);
    expect(isActive({ ...base, until: '2026-11-03T11:59:59Z' }, now)).toBe(false);
  });

  it('stays active when until cannot be read, so a hold fails closed', () => {
    expect(isActive({ ...base, until: 'next tuesday' }, now)).toBe(true);
  });
});
