import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Ctx } from './context.js';
import { assertNoCredentials } from './credentials.js';
import { timestamp } from './entry.js';

/** Hard cap on a usage line, including the trailing newline. */
export const MAX_USAGE_BYTES = 4096;

export interface BriefUsageLine {
  ts: string;
  command: 'brief';
  harness: string | null;
  session: string | null;
  project: string | null;
  cwd: string;
  entries: number;
  chars: number;
}

export interface CheckUsageLine {
  ts: string;
  command: 'check';
  harness: string | null;
  session: string | null;
  project: string | null;
  cwd: string;
  tag: string;
  blocked: boolean;
}

export type UsageLine = BriefUsageLine | CheckUsageLine;

export type UsageDetails =
  | { command: 'brief'; entries: number; chars: number }
  | { command: 'check'; tag: string; blocked: boolean };

/**
 * Append one best-effort usage record. Any failure, including credential-like text, is
 * swallowed: `brief` and `check` are on every session's hot path and their output and
 * exit code must not depend on telemetry. No subprocesses, no network.
 */
export function appendUsage(ctx: Ctx, project: string | null, details: UsageDetails): void {
  try {
    assertNoCredentials({
      session: ctx.identity.session ?? undefined,
      project: project ?? undefined,
      cwd: ctx.cwd,
      ...(details.command === 'check' ? { tag: details.tag } : {}),
    });

    const base = {
      ts: timestamp(ctx.now),
      harness: ctx.identity.harness,
      session: ctx.identity.session,
      project,
      cwd: ctx.cwd,
    };
    let record: UsageLine =
      details.command === 'brief'
        ? { ...base, command: 'brief', entries: details.entries, chars: details.chars }
        : { ...base, command: 'check', tag: details.tag, blocked: details.blocked };

    // Only `cwd` is allowed to shrink, and only the JSON payload, never the caller's value.
    let text = JSON.stringify(record) + '\n';
    while (Buffer.byteLength(text, 'utf8') >= MAX_USAGE_BYTES && record.cwd.length > 0) {
      record = { ...record, cwd: record.cwd.slice(0, Math.floor(record.cwd.length / 2)) };
      text = JSON.stringify(record) + '\n';
    }
    if (Buffer.byteLength(text, 'utf8') >= MAX_USAGE_BYTES) return;

    mkdirSync(join(ctx.home, 'state'), { recursive: true });
    appendFileSync(join(ctx.home, 'state', 'usage.jsonl'), text, { flag: 'a' });
  } catch {
    // telemetry is never allowed to affect the command
  }
}

const isNullableString = (value: unknown): value is string | null => value === null || typeof value === 'string';
const isNonNegativeInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0;

function parseUsageLine(raw: string): UsageLine | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;
  if (typeof obj.ts !== 'string' || Number.isNaN(Date.parse(obj.ts))) return null;
  if (!isNullableString(obj.harness) || !isNullableString(obj.session) || !isNullableString(obj.project)) return null;
  if (typeof obj.cwd !== 'string') return null;
  const common = { ts: obj.ts, harness: obj.harness, session: obj.session, project: obj.project, cwd: obj.cwd };
  if (obj.command === 'brief') {
    if (!isNonNegativeInteger(obj.entries) || !isNonNegativeInteger(obj.chars)) return null;
    return { ...common, command: 'brief', entries: obj.entries, chars: obj.chars };
  }
  if (obj.command === 'check') {
    if (typeof obj.tag !== 'string' || typeof obj.blocked !== 'boolean') return null;
    return { ...common, command: 'check', tag: obj.tag, blocked: obj.blocked };
  }
  return null;
}

/**
 * Usage records, oldest first. Missing file is empty. Only newline-terminated records are
 * read, so a partially written trailing line is ignored; malformed lines are skipped
 * without hiding later valid ones. Never creates anything.
 */
export function readUsage(home: string): UsageLine[] {
  let text: string;
  try {
    text = readFileSync(join(home, 'state', 'usage.jsonl'), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const records: UsageLine[] = [];
  const parts = text.split('\n');
  for (let index = 0; index < parts.length - 1; index++) {
    const line = parseUsageLine(parts[index]!);
    if (line !== null) records.push(line);
  }
  return records;
}

/** A count with its sample size; `lowSample` marks any sample under 10. */
export interface Metric {
  count: number;
  n: number;
  lowSample: boolean;
}

export interface HarnessSessions {
  harness: string | null;
  sessions: Metric;
}

export interface ProjectCalls {
  project: string | null;
  calls: Metric;
}

export interface TagCalls {
  tag: string;
  calls: Metric;
}

export interface UsageReport {
  since: string | null;
  brief: {
    calls: Metric;
    sessions: Metric;
    anonymous: Metric;
    byHarness: HarnessSessions[];
    byProject: ProjectCalls[];
  };
  check: {
    calls: Metric;
    blocked: Metric;
    sessions: Metric;
    anonymous: Metric;
    byTag: TagCalls[];
  };
}

const metric = (count: number, n: number): Metric => ({ count, n, lowSample: n < 10 });

function sessionKey(line: UsageLine): string | null {
  return line.session === null ? null : `${line.harness ?? ''}\u0000${line.session}`;
}

/** Distinct `(harness, session)` pairs, over the identified calls that carry a session id. */
function sessionMetric(lines: UsageLine[]): Metric {
  const identified = lines.filter((line) => line.session !== null);
  return metric(new Set(identified.map((line) => sessionKey(line)!)).size, identified.length);
}

function groupBy<T, K>(items: T[], key: (item: T) => K): Map<K, T[]> {
  const groups = new Map<K, T[]>();
  for (const item of items) {
    const k = key(item);
    const group = groups.get(k);
    if (group) group.push(item);
    else groups.set(k, [item]);
  }
  return groups;
}

/** Null keys sort first, then plain code-point order; independent of locale. */
function compareNullable(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  return a < b ? -1 : 1;
}

function harnessBreakdown(briefs: BriefUsageLine[]): HarnessSessions[] {
  const identified = briefs.filter((line) => line.session !== null);
  return [...groupBy(identified, (line) => line.harness).entries()]
    .map(([harness, group]) => ({ harness, sessions: sessionMetric(group) }))
    .sort((a, b) => compareNullable(a.harness, b.harness));
}

function projectBreakdown(briefs: BriefUsageLine[]): ProjectCalls[] {
  return [...groupBy(briefs, (line) => line.project).entries()]
    .map(([project, group]) => ({ project, calls: metric(group.length, group.length) }))
    .sort((a, b) => compareNullable(a.project, b.project));
}

function tagBreakdown(checks: CheckUsageLine[]): TagCalls[] {
  return [...groupBy(checks, (line) => line.tag).entries()]
    .map(([tag, group]) => ({ tag, calls: metric(group.length, group.length) }))
    .sort((a, b) => (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0));
}

/** Aggregate records in the window. `since` is inclusive; null means all complete records. */
export function summarizeUsage(lines: UsageLine[], since: Date | null): UsageReport {
  const cutoff = since?.getTime() ?? null;
  const inWindow = cutoff === null ? lines : lines.filter((line) => Date.parse(line.ts) >= cutoff);
  const briefs = inWindow.filter((line): line is BriefUsageLine => line.command === 'brief');
  const checks = inWindow.filter((line): line is CheckUsageLine => line.command === 'check');

  return {
    since: since?.toISOString() ?? null,
    brief: {
      calls: metric(briefs.length, briefs.length),
      sessions: sessionMetric(briefs),
      anonymous: metric(briefs.filter((line) => line.session === null).length, briefs.length),
      byHarness: harnessBreakdown(briefs),
      byProject: projectBreakdown(briefs),
    },
    check: {
      calls: metric(checks.length, checks.length),
      blocked: metric(checks.filter((line) => line.blocked).length, checks.length),
      sessions: sessionMetric(checks),
      anonymous: metric(checks.filter((line) => line.session === null).length, checks.length),
      byTag: tagBreakdown(checks),
    },
  };
}
