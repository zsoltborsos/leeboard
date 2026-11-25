import { displayStatus, type DisplayStatus, type Entry, KINDS, newestFirst, serializeEntry, STATUSES, summarize, type Summary } from '../entry.js';
import { EXIT, LeeboardError } from '../errors.js';
import { createSuccessorResolver, findEntry, listEntries, scopeDir, type SuccessorResolution } from '../store.js';

type ReadSummary = Omit<Summary, 'status'> & { status: DisplayStatus };

export function showEntry(home: string, idPrefix: string): Entry {
  return findEntry(home, idPrefix);
}

export function showCommand(home: string, idPrefix: string): {
  data: Entry & { supersededBy?: string[]; current?: string | null; chainEnd?: SuccessorResolution['chainEnd'] };
  text: string;
} {
  const entry = showEntry(home, idPrefix);
  let text = serializeEntry(entry);
  if (entry.status !== 'superseded') return { data: entry, text };

  const { successors, current, chainEnd } = createSuccessorResolver(listEntries(home))(entry.id);
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
  return { data: { ...entry, supersededBy: successors.map((next) => next.id), current: current?.id ?? null, chainEnd }, text };
}

function usage(message: string): LeeboardError {
  return new LeeboardError(message, EXIT.USAGE);
}

/**
 * Entries newest first, narrowed by kind, scope, status, author session and harness.
 * Without --status or --all only active entries are listed, unless the filter is on the
 * author (--session, --harness): "what did this run write" wants every status.
 */
export function listCommand(
  home: string,
  filter: { kind?: string; scope?: string; status?: string; session?: string; harness?: string; all?: boolean },
): ReadSummary[] {
  if (filter.kind !== undefined && !(KINDS as readonly string[]).includes(filter.kind)) {
    throw usage(`unknown kind '${filter.kind}' (use ${KINDS.join(', ')})`);
  }
  if (filter.status !== undefined && ![...STATUSES, 'lapsed'].includes(filter.status)) {
    throw usage(`unknown status '${filter.status}' (use ${[...STATUSES, 'lapsed'].join(', ')})`);
  }
  if (filter.scope !== undefined) scopeDir(home, filter.scope); // validates the scope
  if (filter.all && filter.status !== undefined) throw usage('--all does not combine with --status');
  const now = new Date();
  const byAuthor = filter.session !== undefined || filter.harness !== undefined;
  const status = filter.status ?? (filter.all || byAuthor ? undefined : 'active');
  return listEntries(home, filter.scope === undefined ? undefined : [filter.scope])
    .filter(
      (entry) =>
        (filter.kind ?? entry.kind) === entry.kind &&
        (status === undefined || status === displayStatus(entry, now)) &&
        (filter.session === undefined || entry.author.session === filter.session) &&
        (filter.harness === undefined || entry.author.harness === filter.harness),
    )
    .sort(newestFirst)
    .map((entry) => ({ ...summarize(entry), status: displayStatus(entry, now) }));
}

export function renderList(items: ReadSummary[]): string {
  return items.map((item) => `- [${item.id}] ${item.status} ${item.scope}: ${item.title}\n`).join('');
}

/** Case-insensitive substring match over title and body, across all scopes; active entries unless `all`. */
export function searchEntries(home: string, text: string, options: { all?: boolean } = {}): ReadSummary[] {
  const now = new Date();
  const needle = text.trim().toLowerCase();
  if (needle === '') throw usage('nothing to search for');
  return listEntries(home)
    .filter((entry) => options.all || displayStatus(entry, now) === 'active')
    .filter((entry) => entry.title.toLowerCase().includes(needle) || entry.body.toLowerCase().includes(needle))
    .sort(newestFirst)
    .map((entry) => ({ ...summarize(entry), status: displayStatus(entry, now) }));
}
