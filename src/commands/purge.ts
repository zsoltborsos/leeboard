import type { Ctx } from '../context.js';
import { usageError } from '../errors.js';
import { KEEP_CLOSED_DAYS, purgeEntries, renderPurge } from '../purge.js';
import { jsonLine, ok, type RunResult } from '../result.js';

export const PURGE_CLOSED_DESCRIPTION =
  `delete entries closed more than n days ago (default ${KEEP_CLOSED_DAYS})`;

export interface PurgeFlags {
  closed?: boolean;
  days?: string;
  dryRun?: boolean;
  json?: boolean;
}

/** Lazy ctx keeps flag validation ahead of identity resolution. */
export function purgeCommand(ctx: () => Ctx, ids: string[], flags: PurgeFlags): RunResult {
  if (Boolean(flags.closed) === (ids.length > 0)) throw usageError('usage: lb purge <id>... | lb purge --closed [--days <n>]');
  if (flags.days !== undefined && !flags.closed) throw usageError('--days goes with --closed');
  const days = flags.days === undefined ? KEEP_CLOSED_DAYS : Number(flags.days);
  if (!Number.isInteger(days) || days < 0) throw usageError('--days must be a whole number of days, 0 or more');
  const result = purgeEntries(ctx(), flags.closed ? { closed: true, days } : { ids }, { dryRun: flags.dryRun });
  return ok(flags.json ? jsonLine(result) : renderPurge(result));
}
