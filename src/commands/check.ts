import { basename } from 'node:path';
import type { Ctx } from '../context.js';
import { isActive, kindOfId, newestFirst, summarize, type Summary } from '../entry.js';
import { EXIT, usageError } from '../errors.js';
import { describeHold } from '../format.js';
import { jsonLine, result, type RunResult } from '../result.js';
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
  if (tag.trim() === '') throw usageError('--blocks <tag> is required');
  const view = viewFor(ctx);
  const { entries, unreadable } = listEntriesWithDiagnostics(ctx.home, view.scopes, (id) => kindOfId(id) === 'hold');
  const holds = entries
    .filter((entry) => entry.kind === 'hold' && isActive(entry, ctx.now) && entry.blocks?.includes(tag))
    .sort(newestFirst)
    .map(summarize);
  return { project: view.project, holds, unreadable };
}

/** Query and record the call best-effort, owning the CLI output and exit code. */
export function checkCommand(ctx: Ctx, { tag, json }: { tag: string; json?: boolean }): RunResult {
  const data = check(ctx, tag);
  const blocked = data.holds.length > 0 || data.unreadable.length > 0;
  appendUsage(ctx, data.project, { command: 'check', tag, blocked });
  return result(blocked ? EXIT.CHECK_BLOCKED : 0, json ? jsonLine([
    ...data.holds,
    ...data.unreadable.map(({ path, error }) => ({
      id: basename(path, '.md'),
      kind: 'hold',
      title: `Unreadable hold file: ${path} — could not be parsed: ${error.replace(/\s+/g, ' ').trim()}`,
      release: 'fix or remove this file',
      unreadable: true,
    })),
  ]) : renderCheck(data.holds, data.unreadable));
}

/** One line per blocking hold or unreadable hold file; empty when none. */
export function renderCheck(holds: Summary[], unreadable: UnreadableEntryFile[] = []): string {
  return holds.map((hold) => `- [${hold.id}] ${describeHold(hold)}\n`).join('') +
    unreadable.map(({ path, error }) => `- ${path} — could not be parsed: ${error.replace(/\s+/g, ' ').trim()} — fix or remove this file\n`).join('');
}
