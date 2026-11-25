import { usageError } from '../errors.js';
import { jsonLine, ok, type RunResult } from '../result.js';
import { readUsage, summarizeUsage, type Metric, type UsageReport } from '../usage.js';

const DATE_ONLY = /^(\d{4}-\d{2}-\d{2})$/;
const ISO_TIMESTAMP = /^(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;

/** The report for `home`, restricted to calls at or after `since` when given. */
export function usage(home: string, since?: string): UsageReport {
  return summarizeUsage(readUsage(home), parseSince(since));
}

export function usageCommand(home: string, flags: { since?: string; json?: boolean }): RunResult {
  const report = usage(home, flags.since);
  return ok(flags.json ? jsonLine(report) : renderUsage(report));
}

/**
 * Accept an ISO calendar date (UTC midnight) or an ISO timestamp with an explicit
 * timezone. Reject anything else, including calendar dates that normalize (2026-02-30).
 */
function parseSince(value: string | undefined): Date | null {
  if (value === undefined) return null;
  const match = DATE_ONLY.exec(value) ?? ISO_TIMESTAMP.exec(value);
  const day = match?.[1];
  const date = match ? new Date(value) : new Date(NaN);
  const calendar = day ? new Date(`${day}T00:00:00Z`) : new Date(NaN);
  if (
    !match ||
    Number.isNaN(date.getTime()) ||
    Number.isNaN(calendar.getTime()) ||
    calendar.toISOString().slice(0, 10) !== day
  ) {
    throw usageError(`invalid --since '${value}' (use an ISO date or timestamp with timezone)`);
  }
  return date;
}

const display = (value: string | null): string => value ?? '(none)';
const padRight = (text: string, width: number): string => text.padEnd(width);
const padLeft = (text: string, width: number): string => text.padStart(width);
const sample = (metric: Metric): string => `n=${metric.n}${metric.lowSample ? ' (n<10)' : ''}`;

/** A compact table, one row per figure, each carrying its sample size. */
export function renderUsage(report: UsageReport): string {
  const rows: Array<[string, string, Metric]> = [
    ['brief', 'calls', report.brief.calls],
    ['brief', 'sessions', report.brief.sessions],
    ['brief', 'anonymous', report.brief.anonymous],
    ...report.brief.byHarness.map(
      (entry): [string, string, Metric] => ['brief', `sessions by harness ${display(entry.harness)}`, entry.sessions],
    ),
    ...report.brief.byProject.map(
      (entry): [string, string, Metric] => ['brief', `calls by project ${display(entry.project)}`, entry.calls],
    ),
    ['check', 'calls', report.check.calls],
    ['check', 'blocked', report.check.blocked],
    ['check', 'sessions', report.check.sessions],
    ['check', 'anonymous', report.check.anonymous],
    ...report.check.byTag.map((entry): [string, string, Metric] => ['check', `calls by tag ${entry.tag}`, entry.calls]),
  ];

  const commandWidth = Math.max('Command'.length, ...rows.map((row) => row[0].length));
  const metricWidth = Math.max('Metric'.length, ...rows.map((row) => row[1].length));
  const countWidth = Math.max('Count'.length, ...rows.map((row) => String(row[2].count).length));
  const header = `${padRight('Command', commandWidth)}  ${padRight('Metric', metricWidth)}  ${padLeft('Count', countWidth)}  Sample`;
  const body = rows.map(
    ([command, metric, value]) =>
      `${padRight(command, commandWidth)}  ${padRight(metric, metricWidth)}  ${padLeft(String(value.count), countWidth)}  ${sample(value)}`,
  );
  return [header, ...body].join('\n') + '\n';
}
