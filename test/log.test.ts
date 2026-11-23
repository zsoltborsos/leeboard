import { describe, expect, it } from 'vitest';
import { appendFileSync, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { appendLog, latestChanges, type LogLine, logSize, readCursor, readLogSince, writeCursor } from '../src/log.js';
import { writeEntry } from '../src/store.js';
import { sampleEntry, tempDir } from './helpers.js';

function line(id: string, overrides: Partial<LogLine> = {}): LogLine {
  return {
    ts: '2026-10-17T14:02:11Z',
    id,
    kind: 'rule',
    scope: 'global',
    event: 'created',
    status: 'active',
    harness: 'claude-code',
    session: 'A',
    ...overrides,
  };
}

describe('change log', () => {
  it('appends one JSON object per line and never rewrites earlier lines', () => {
    const home = tempDir();
    appendLog(home, line('rule-a-0001'));
    const first = readFileSync(join(home, 'log.jsonl'), 'utf8');
    appendLog(home, line('rule-b-0002', { event: 'status', status: 'revoked' }));
    const both = readFileSync(join(home, 'log.jsonl'), 'utf8');

    expect(both.startsWith(first)).toBe(true);
    const lines = both.trimEnd().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toEqual(line('rule-a-0001'));
    expect(JSON.parse(lines[1]!)).toEqual(line('rule-b-0002', { event: 'status', status: 'revoked' }));
  });

  it('refuses a line of 4 KB or more and writes nothing', () => {
    const home = tempDir();
    appendLog(home, line('rule-a-0001'));
    const before = readFileSync(join(home, 'log.jsonl'), 'utf8');
    expect(() => appendLog(home, line('rule-b-0002', { session: 's'.repeat(4096) }))).toThrow(/4 KB/);
    expect(readFileSync(join(home, 'log.jsonl'), 'utf8')).toBe(before);
  });

  it('reports size 0 and no lines when the log does not exist yet', () => {
    const home = tempDir();
    expect(logSize(home)).toBe(0);
    expect(readLogSince(home, 0)).toEqual({ lines: [], end: 0 });
  });

  it('reads only what was appended after a byte offset, counting bytes not characters', () => {
    const home = tempDir();
    appendLog(home, line('rule-a-0001', { session: 'séssion-日本' }));
    const offset = logSize(home);
    expect(offset).toBe(statSync(join(home, 'log.jsonl')).size);
    appendLog(home, line('rule-b-0002'));
    appendLog(home, line('rule-c-0003'));

    const { lines, end } = readLogSince(home, offset);
    expect(lines.map((l) => l.id)).toEqual(['rule-b-0002', 'rule-c-0003']);
    expect(end).toBe(statSync(join(home, 'log.jsonl')).size);
    expect(readLogSince(home, end)).toEqual({ lines: [], end });
  });

  it('does not consume a partially written trailing line', () => {
    const home = tempDir();
    appendLog(home, line('rule-a-0001'));
    const whole = logSize(home);
    const partial = JSON.stringify(line('rule-b-0002'));
    appendFileSync(join(home, 'log.jsonl'), partial.slice(0, 20));

    const first = readLogSince(home, 0);
    expect(first.lines.map((l) => l.id)).toEqual(['rule-a-0001']);
    expect(first.end).toBe(whole);

    appendFileSync(join(home, 'log.jsonl'), partial.slice(20) + '\n');
    expect(readLogSince(home, first.end).lines.map((l) => l.id)).toEqual(['rule-b-0002']);
  });

  it('skips corrupt lines', () => {
    const home = tempDir();
    appendLog(home, line('rule-a-0001'));
    appendFileSync(join(home, 'log.jsonl'), 'not json\n');
    appendLog(home, line('rule-b-0002'));
    expect(readLogSince(home, 0).lines.map((l) => l.id)).toEqual(['rule-a-0001', 'rule-b-0002']);
  });

  it('treats an offset beyond the end of the log as "nothing new"', () => {
    const home = tempDir();
    appendLog(home, line('rule-a-0001'));
    const size = logSize(home);
    expect(readLogSince(home, size + 500)).toEqual({ lines: [], end: size });
  });
});

describe('session cursors', () => {
  it('has no cursor until one is written, then round-trips the offset', () => {
    const home = tempDir();
    expect(readCursor(home, 'A')).toBeNull();
    writeCursor(home, 'A', 1234);
    expect(readCursor(home, 'A')).toBe(1234);
    expect(readCursor(home, 'B')).toBeNull();
    writeCursor(home, 'A', 99);
    expect(readCursor(home, 'A')).toBe(99);
  });

  it('keeps cursor files inside state/cursors whatever the session id looks like', () => {
    const home = tempDir();
    writeCursor(home, '../../escape/me', 7);
    expect(readCursor(home, '../../escape/me')).toBe(7);
    expect(readdirSync(home)).toEqual(['state']);
    expect(readdirSync(join(home, 'state'))).toEqual(['cursors']);
    expect(readdirSync(join(home, 'state', 'cursors'))).toHaveLength(1);
    expect(existsSync(join(home, '..', 'escape'))).toBe(false);
  });
});

describe('latest change per entry', () => {
  it('keeps each entry once, at its latest event, ordered by that event, with the entry as it is now', () => {
    const home = tempDir();
    writeEntry(home, sampleEntry({ id: 'rule-a-0001', title: 'A now' }));
    writeEntry(home, sampleEntry({ id: 'rule-b-0002', title: 'B now' }));
    const changes = latestChanges(home, [
      line('rule-a-0001', { event: 'created' }),
      line('rule-b-0002', { event: 'created' }),
      line('rule-a-0001', { event: 'updated', session: 'B' }),
    ]);

    expect(changes.map((change) => change.line.id)).toEqual(['rule-b-0002', 'rule-a-0001']);
    expect(changes[1]!.line).toEqual(line('rule-a-0001', { event: 'updated', session: 'B' }));
    expect(changes.map((change) => change.entry.title)).toEqual(['B now', 'A now']);
  });

  it('skips entries that no longer exist, and has nothing for no lines', () => {
    const home = tempDir();
    writeEntry(home, sampleEntry({ id: 'rule-a-0001' }));
    const changes = latestChanges(home, [line('rule-gone-0009'), line('rule-a-0001'), line('rule-gone-0009', { event: 'updated' })]);

    expect(changes.map((change) => change.line.id)).toEqual(['rule-a-0001']);
    expect(latestChanges(home, [])).toEqual([]);
  });
});
