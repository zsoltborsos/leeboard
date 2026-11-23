import { rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Ctx } from './context.js';
import { type Entry, entryIdsIn, summarize, type Summary } from './entry.js';
import { EXIT, LeeboardError } from './errors.js';
import { logChange } from './log.js';
import { findEntry, listEntries, scopeDir, withRevisionLock, writeEntry } from './store.js';

/** How long `lb purge --closed` keeps a closed entry, counted from its last change. */
export const KEEP_CLOSED_DAYS = 30;

export interface PurgeResult {
  dryRun: boolean;
  purged: Summary[];
  /** Closed entries `--closed` left in place because an active entry still cites them. */
  kept: { entry: Summary; citedBy: string[] }[];
}

export type PurgeTarget = { ids: string[] } | { closed: true; days: number };

/**
 * Remove entries from the store for good: the entry file and its revision history go,
 * other entries' `supersedes` lists drop the id, and the change log gains one `purged`
 * line (id only, as every log line). The store's git history still holds the text.
 * Only interactive sessions may purge: Bosun and unattended runners never delete.
 */
export function purgeEntries(ctx: Ctx, target: PurgeTarget, options: { dryRun?: boolean } = {}): PurgeResult {
  const harness = ctx.identity.harness;
  if (harness === 'bosun' || harness === 'helmraiser') {
    throw new LeeboardError(`${harness} may not purge entries; ask the owner or an interactive session`, EXIT.NOT_PERMITTED);
  }
  return withRevisionLock(ctx.home, () => {
    const all = listEntries(ctx.home);
    const chosen = 'ids' in target
      ? [...new Map(target.ids.map((prefix) => findEntry(ctx.home, prefix)).map((entry) => [entry.id, entry])).values()]
      : all.filter((entry) => entry.status !== 'active' && closedLongEnough(entry, ctx.now, target.days));

    const ids = new Set(chosen.map((entry) => entry.id));
    const citedBy = new Map<string, string[]>();
    for (const entry of all) {
      if (entry.status !== 'active' || ids.has(entry.id)) continue;
      for (const id of entryIdsIn(`${entry.title}\n${entry.body}`)) {
        if (ids.has(id)) citedBy.set(id, [...(citedBy.get(id) ?? []), entry.id]);
      }
    }
    if ('ids' in target && citedBy.size > 0) {
      const lines = [...citedBy].map(([id, by]) => `${id} is cited by ${by.join(', ')}`);
      throw new LeeboardError(`cannot purge: ${lines.join('; ')}. Revise the citing entries first`, EXIT.BAD_TRANSITION);
    }

    const result: PurgeResult = { dryRun: options.dryRun ?? false, purged: [], kept: [] };
    for (const entry of chosen) {
      const by = citedBy.get(entry.id);
      if (by) {
        result.kept.push({ entry: summarize(entry), citedBy: by });
        ids.delete(entry.id);
      }
    }
    const purged = chosen.filter((entry) => ids.has(entry.id));
    result.purged = purged.map(summarize);
    if (result.dryRun) return result;

    for (const entry of all) {
      if (ids.has(entry.id) || !entry.supersedes?.some((id) => ids.has(id))) continue;
      const remaining = entry.supersedes.filter((id) => !ids.has(id));
      if (remaining.length > 0) entry.supersedes = remaining;
      else delete entry.supersedes;
      writeEntry(ctx.home, entry);
      logChange(ctx, entry, 'updated');
    }
    for (const entry of purged) {
      rmSync(join(scopeDir(ctx.home, entry.scope), `${entry.id}.md`));
      rmSync(join(ctx.home, 'revisions', `${entry.id}.jsonl`), { force: true });
      logChange(ctx, entry, 'purged');
    }
    return result;
  });
}

function closedLongEnough(entry: Entry, now: Date, days: number): boolean {
  return Date.parse(entry.updated) <= now.getTime() - days * 86_400_000;
}

export function renderPurge(result: PurgeResult): string {
  const verb = result.dryRun ? 'would purge' : 'purged';
  const lines = result.purged.map((item) => `- [${item.id}] ${item.status} ${item.scope}: ${item.title}`);
  const kept = result.kept.map(({ entry, citedBy }) => `- [${entry.id}] kept: cited by ${citedBy.join(', ')}`);
  return [
    `${verb} ${result.purged.length} ${result.purged.length === 1 ? 'entry' : 'entries'}`,
    ...lines,
    ...(kept.length > 0 ? [`kept ${kept.length} closed ${kept.length === 1 ? 'entry' : 'entries'} still cited by active ones:`, ...kept] : []),
  ].join('\n') + '\n';
}
