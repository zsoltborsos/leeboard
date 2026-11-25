import { displayStatus, type DisplayStatus, type Entry, KINDS, newestFirst, serializeEntry, STATUSES, summarize, type Summary } from '../entry.js';
import type { Ctx } from '../context.js';
import { usageError } from '../errors.js';
import { jsonLine, ok, type RunResult } from '../result.js';
import { createSuccessorResolver, findEntry, listEntries, scopeDir, type SuccessorResolution } from '../store.js';

export type ReadCtx = Pick<Ctx, 'home' | 'now'>;

export type ReadSummary = Omit<Summary, 'status'> & { status: DisplayStatus };
type ReadEntry = Omit<Entry, 'status'> & { status: DisplayStatus };
export type ShowData = ReadEntry & { supersededBy?: string[]; current?: string | null; chainEnd?: SuccessorResolution['chainEnd'] };

export function showEntry(home: string, idPrefix: string): Entry {
  return findEntry(home, idPrefix);
}

export function showCommand({ home, now }: ReadCtx, idPrefix: string | undefined, flags: { json?: boolean }): RunResult {
  if (idPrefix === undefined) throw usageError('usage: lb show <id>');
  const entry = showEntry(home, idPrefix);
  const status = displayStatus(entry, now);
  let text = serializeEntry({ ...entry, status } as Entry);
  if (entry.status !== 'superseded') return ok(flags.json ? jsonLine({ ...entry, status }) : text);

  const { successors, current, chainEnd } = createSuccessorResolver(listEntries(home), now)(entry.id);
  const lines = successors.map((next) => `Superseded by: ${next.id} — ${next.title}\n`);
  if (successors.length === 0) {
    lines.push('Superseded by: none found\n');
  } else if (!current && chainEnd) {
    const reason = chainEnd.status === 'superseded' ? 'no active successor' : chainEnd.status;
    lines.push(`Current: none — chain ends at ${chainEnd.id} (${reason})\n`);
  } else if (current && !successors.some((next) => next.id === current.id)) {
    lines.push(`Current: ${current.id} — ${current.title}\n`);
  }
  text += (text.endsWith('\n') ? '' : '\n') + lines.join('');
  const data: ShowData = { ...entry, supersededBy: successors.map((next) => next.id), current: current?.id ?? null, chainEnd };
  return ok(flags.json ? jsonLine(data) : text);
}

/**
 * Entries newest first, narrowed by kind, scope, status, author session and harness.
 * Without --status or --all only active entries are listed, unless the filter is on the
 * author (--session, --harness): "what did this run write" wants every status.
 */
export function listCommand(
  { home, now }: ReadCtx,
  flags: { kind?: string; scope?: string; status?: string; session?: string; harness?: string; all?: boolean; json?: boolean },
): RunResult {
  if (flags.kind !== undefined && !(KINDS as readonly string[]).includes(flags.kind)) {
    throw usageError(`unknown kind '${flags.kind}' (use ${KINDS.join(', ')})`);
  }
  if (flags.status !== undefined && ![...STATUSES, 'lapsed'].includes(flags.status)) {
    throw usageError(`unknown status '${flags.status}' (use ${[...STATUSES, 'lapsed'].join(', ')})`);
  }
  if (flags.scope !== undefined) scopeDir(home, flags.scope); // validates the scope
  if (flags.all && flags.status !== undefined) throw usageError('--all does not combine with --status');
  const byAuthor = flags.session !== undefined || flags.harness !== undefined;
  const status = flags.status ?? (flags.all || byAuthor ? undefined : 'active');
  const items = listEntries(home, flags.scope === undefined ? undefined : [flags.scope])
    .filter(
      (entry) =>
        (flags.kind ?? entry.kind) === entry.kind &&
        (status === undefined || status === displayStatus(entry, now)) &&
        (flags.session === undefined || entry.author.session === flags.session) &&
        (flags.harness === undefined || entry.author.harness === flags.harness),
    )
    .sort(newestFirst)
    .map((entry) => ({ ...summarize(entry), status: displayStatus(entry, now) }));
  return ok(flags.json ? jsonLine(items) : renderList(items));
}

export function renderList(items: ReadSummary[]): string {
  return items.map((item) => `- [${item.id}] ${item.status} ${item.scope}: ${item.title}\n`).join('');
}

/** Case-insensitive substring match over title and body, across all scopes; active entries unless `all`. */
export function searchCommand({ home, now }: ReadCtx, text: string, flags: { all?: boolean; json?: boolean }): RunResult {
  const needle = text.trim().toLowerCase();
  if (needle === '') throw usageError('nothing to search for');
  const items = listEntries(home)
    .filter((entry) => flags.all || displayStatus(entry, now) === 'active')
    .filter((entry) => entry.title.toLowerCase().includes(needle) || entry.body.toLowerCase().includes(needle))
    .sort(newestFirst)
    .map((entry) => ({ ...summarize(entry), status: displayStatus(entry, now) }));
  return ok(flags.json ? jsonLine(items) : renderList(items));
}
