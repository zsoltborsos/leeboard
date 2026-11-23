import { appendFileSync, closeSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Ctx } from './context.js';
import { type Entry, type Kind, type Status, timestamp } from './entry.js';
import { readEntry, writeFileAtomic } from './store.js';

/** `purged` is the last line for an id: its entry file and revision history are gone. */
export type LogEvent = 'created' | 'updated' | 'status' | 'revised' | 'purged';

/** One change. No bodies: the log stays small and every line stays under 4 KB. */
export interface LogLine {
  ts: string;
  id: string;
  kind: Kind;
  scope: string;
  event: LogEvent;
  status: Status;
  harness: string | null;
  session: string | null;
  revision?: { offset: number; fields: ('title' | 'body' | 'scope')[] };
}

const MAX_LINE_BYTES = 4096;

function logPath(home: string): string {
  return join(home, 'log.jsonl');
}

export function appendLog(home: string, line: LogLine): void {
  const text = JSON.stringify(line) + '\n';
  if (Buffer.byteLength(text) >= MAX_LINE_BYTES) throw new Error('log line would reach 4 KB');
  mkdirSync(home, { recursive: true });
  appendFileSync(logPath(home), text, { flag: 'a' });
}

/** Record a change made by `ctx.identity` to `entry` (already written). */
export function logChange(ctx: Ctx, entry: Entry, event: LogEvent, revision?: LogLine['revision']): void {
  appendLog(ctx.home, {
    ts: timestamp(ctx.now),
    id: entry.id,
    kind: entry.kind,
    scope: entry.scope,
    event,
    status: entry.status,
    harness: ctx.identity.harness,
    session: ctx.identity.session,
    ...(revision === undefined ? {} : { revision }),
  });
}

export function logSize(home: string): number {
  try {
    return statSync(logPath(home)).size;
  } catch {
    return 0;
  }
}

/**
 * Complete lines from byte `offset` to the end of the log. `end` is the offset
 * to resume from: a partially written trailing line is left for the next read.
 */
export function readLogSince(home: string, offset: number): { lines: LogLine[]; end: number } {
  let fd: number;
  try {
    fd = openSync(logPath(home), 'r');
  } catch {
    return { lines: [], end: 0 };
  }
  try {
    const size = fstatSync(fd).size;
    if (offset >= size) return { lines: [], end: size };
    const buffer = Buffer.alloc(size - offset);
    readSync(fd, buffer, 0, buffer.length, offset);
    const complete = buffer.subarray(0, buffer.lastIndexOf(0x0a) + 1);
    const lines: LogLine[] = [];
    for (const text of complete.toString('utf8').split('\n')) {
      if (text === '') continue;
      try {
        lines.push(JSON.parse(text) as LogLine);
      } catch {
        // a corrupt line must not hide the rest of the log
      }
    }
    return { lines, end: offset + complete.length };
  } finally {
    closeSync(fd);
  }
}

/** The latest log line for an entry, with the entry as it is now. */
export interface LatestChange {
  line: LogLine;
  entry: Entry;
}

/**
 * Fold `lines` to the latest one per entry id, ordered by that latest event, each paired
 * with the entry as it is now. Lines for entries that no longer exist are dropped.
 */
export function latestChanges(home: string, lines: readonly LogLine[]): LatestChange[] {
  const latest = new Map<string, LogLine>();
  for (const line of lines) {
    latest.delete(line.id); // re-insert so the map stays in order of latest event
    latest.set(line.id, line);
  }
  const changes: LatestChange[] = [];
  for (const line of latest.values()) {
    const entry = readEntry(home, line.scope, line.id);
    if (entry) changes.push({ line, entry });
  }
  return changes;
}

function cursorPath(home: string, session: string): string {
  return join(home, 'state', 'cursors', `${session.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 128)}.json`);
}

/** Byte offset into the log this session has seen, or null if it has no cursor yet. */
export function readCursor(home: string, session: string): number | null {
  return readOffset(cursorPath(home, session));
}

function readOffset(path: string): number | null {
  try {
    const { offset } = JSON.parse(readFileSync(path, 'utf8')) as { offset?: unknown };
    return Number.isInteger(offset) && (offset as number) >= 0 ? (offset as number) : null;
  } catch {
    return null;
  }
}

export function writeCursor(home: string, session: string, offset: number): void {
  writeOffset(cursorPath(home, session), offset);
}

function writeOffset(path: string, offset: number): void {
  writeFileAtomic(path, JSON.stringify({ offset }) + '\n');
}

/** The owner's store-wide cursor is independent of every session cursor. */
export function readReviewCursor(home: string): number {
  return readOffset(join(home, 'state', 'review.json')) ?? 0;
}

export function writeReviewCursor(home: string, offset: number): void {
  writeOffset(join(home, 'state', 'review.json'), offset);
}
