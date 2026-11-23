import type { Ctx } from '../context.js';
import { isActive, kindOfId, newestFirst, summarize, type Summary } from '../entry.js';
import { EXIT, LeeboardError } from '../errors.js';
import { describeHold } from '../format.js';
import { viewFor } from '../scope.js';
import { listEntriesWithDiagnostics, type UnreadableEntryFile } from '../store.js';
import { appendUsage } from '../usage.js';

export interface CheckData {
  project: string | null;
  /** Active holds in scope for the cwd whose `blocks` include the tag. Any hold means "blocked". */
  holds: Summary[];
  /** Unreadable hold-prefixed files in scope also block, regardless of tag. */
  unreadable: UnreadableEntryFile[];
}

/** Which holds block `tag` here. Reads only: it records nothing. */
export function check(ctx: Ctx, tag: string): CheckData {
  if (tag.trim() === '') throw new LeeboardError('--blocks <tag> is required', EXIT.USAGE);
  const view = viewFor(ctx);
  const { entries, unreadable } = listEntriesWithDiagnostics(ctx.home, view.scopes, (id) => kindOfId(id) === 'hold');
  const holds = entries
    .filter((entry) => entry.kind === 'hold' && isActive(entry, ctx.now) && entry.blocks?.includes(tag))
    .sort(newestFirst)
    .map(summarize);
  return { project: view.project, holds, unreadable };
}

/**
 * The CLI entry point for `check`: query, then record the call. The usage write is
 * best-effort; the returned data is exactly what `check` found.
 */
export function checkCommand(ctx: Ctx, tag: string): CheckData {
  const data = check(ctx, tag);
  appendUsage(ctx, data.project, { command: 'check', tag, blocked: data.holds.length > 0 || data.unreadable.length > 0 });
  return data;
}

/** One line per blocking hold or unreadable hold file; empty when none. */
export function renderCheck(holds: Summary[], unreadable: UnreadableEntryFile[] = []): string {
  return holds.map((hold) => `- [${hold.id}] ${describeHold(hold)}\n`).join('') +
    unreadable.map(({ path, error }) => `- ${path} — could not be parsed: ${error.replace(/\s+/g, ' ').trim()} — fix or remove this file\n`).join('');
}
