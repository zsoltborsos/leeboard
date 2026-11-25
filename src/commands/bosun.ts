import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, sep } from 'node:path';
import { expireLapsed } from '../change.js';
import type { Ctx } from '../context.js';
import { entryIdsIn, isActive, staleHoldDays, summarize, type Summary } from '../entry.js';
import { usageError } from '../errors.js';
import { listProjects } from '../projects.js';
import { jsonLine, ok, type RunResult } from '../result.js';
import { createSuccessorResolver, listEntriesWithDiagnostics, type UnreadableEntryFile } from '../store.js';
import type { FullContext, FullFlags } from './bosun-full.js';

export interface BosunReport {
  dryRun: boolean;
  /** The resulting summaries, or the proposed results in a dry run. */
  expired: Summary[];
  deadReferences: { entry: Summary; paths: string[] }[];
  staleReferences: {
    entry: Summary;
    citations: { id: string; status: 'superseded' | 'revoked' | 'missing'; current: string | null }[];
  }[];
  duplicates: { scope: string; title: string; entries: Summary[] }[];
  staleHolds: { entry: Summary; untouchedDays: number }[];
  unreadable: UnreadableEntryFile[];
}

interface BosunFlags extends FullFlags {
  full?: boolean;
  quick?: boolean;
  dryRun?: boolean;
}

export async function bosunCommand(context: FullContext, flags: BosunFlags): Promise<RunResult> {
  if (flags.full) {
    if (flags.dryRun || flags.quick) throw usageError('bosun --full does not combine with --quick or --dry-run');
    // Loaded only here, so brief, delta and check never pay for the runner code.
    const { bosunFullCommand } = await import('./bosun-full.js');
    return bosunFullCommand(context, flags);
  }
  const report = bosun(context.ctx(), { dryRun: flags.dryRun });
  return ok(flags.json ? jsonLine(report) : renderBosun(report));
}

/** Deterministic maintenance across the whole store, not just the caller's scope. */
export function bosun(ctx: Ctx, options: { dryRun?: boolean } = {}): BosunReport {
  const scan = listEntriesWithDiagnostics(ctx.home);
  const report: BosunReport = {
    dryRun: options.dryRun ?? false, expired: [], deadReferences: [], staleReferences: [], duplicates: [], staleHolds: [],
    unreadable: scan.unreadable.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
  };
  const entries = scan.entries.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const resolveSuccessor = createSuccessorResolver(entries, ctx.now);
  const groups = new Map<string, BosunReport['duplicates'][number]>();
  const actor: Ctx = { ...ctx, identity: { ...ctx.identity, harness: 'bosun' } };
  const localRoots = [homedir(), ...listProjects(ctx.home).flatMap((project) => project.paths)];

  for (const entry of entries) {
    if (expireLapsed(actor, entry, { dryRun: report.dryRun })) report.expired.push(summarize(entry));
    if (!isActive(entry, ctx.now)) continue;

    const summary = summarize(entry);
    const citations: BosunReport['staleReferences'][number]['citations'] = [];
    for (const id of entryIdsIn(entry.body)) {
      if (id === entry.id || entry.supersedes?.includes(id)) continue;
      const target = byId.get(id);
      if (!target) citations.push({ id, status: 'missing', current: null });
      else if (target.status === 'revoked') citations.push({ id, status: 'revoked', current: null });
      else if (target.status === 'superseded') {
        citations.push({ id, status: 'superseded', current: resolveSuccessor(id).current?.id ?? null });
      }
    }
    if (citations.length > 0) report.staleReferences.push({ entry: summary, citations });

    if (entry.kind === 'reference') {
      const paths = referencePaths(`${entry.title}\n${entry.body}`)
        .filter((path) => existsSync(topLevel(path)) && (entry.scope === 'machine' || isOwnedHere(path, localRoots)))
        .filter((path) => !existsSync(expandHome(path)));
      if (paths.length > 0) report.deadReferences.push({ entry: summary, paths });
    }

    const title = entry.title.toLowerCase().replace(/\p{P}/gu, '').replace(/\s+/g, ' ').trim();
    const key = JSON.stringify([entry.scope, title]);
    const group = groups.get(key) ?? { scope: entry.scope, title, entries: [] };
    group.entries.push(summary);
    groups.set(key, group);

    if (entry.kind === 'hold') {
      const untouchedDays = staleHoldDays(entry, ctx.now);
      if (untouchedDays !== undefined) report.staleHolds.push({ entry: summary, untouchedDays });
    }
  }
  report.duplicates = [...groups.values()].filter((group) => group.entries.length > 1);
  return report;
}

function expandHome(path: string): string {
  return path.startsWith('~/') ? join(homedir(), path.slice(2)) : path;
}

/** `/health` and `/api/x` are routes, not files: their top-level directory does not exist. */
function topLevel(path: string): string {
  return path.startsWith('~/') ? homedir() : `/${path.split('/')[1]}`;
}

/**
 * A path outside machine scope is checked only under the home directory or a registered
 * project path: references also name paths on remote hosts and API routes, which are not
 * missing just because this machine lacks them.
 */
function isOwnedHere(path: string, roots: string[]): boolean {
  const full = expandHome(path);
  return roots.some((root) => full === root || full.startsWith(root.endsWith(sep) ? root : root + sep));
}

/** Literal path tokens only; prose punctuation and Markdown delimiters are not part of a path. */
function referencePaths(text: string): string[] {
  const literal = text
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s`<>]+/gi, ' ')
    .replace(/(`+)([^\n]*?)\1/g, (_match, _ticks: string, code: string) =>
      /[\s*?<>]/.test(code) ? ' ' : ` ${code} `,
    );
  const paths = new Set<string>();
  for (const match of literal.matchAll(/(?:^|[\s([{"'=,:])((?:~\/|\/)[^\s`"'<>()[\]{},;]+)/g)) {
    const path = match[1]!.replace(/[.!?:]+$/, '');
    if (path !== '' && path !== '/') paths.add(path);
  }
  return [...paths].sort();
}

/** Only nonempty sections are emitted. Dry runs label proposed status changes explicitly. */
export function renderBosun(report: BosunReport): string {
  const sections = [
    { title: report.dryRun ? 'Expired (would expire)' : 'Expired', lines: report.expired.map((entry) => `- [${entry.id}] ${entry.title}`) },
    { title: 'Dead references', lines: report.deadReferences.map(({ entry, paths }) => `- [${entry.id}] ${entry.title} — missing: ${paths.join(', ')}`) },
    { title: 'Stale entry references', lines: report.staleReferences.map(({ entry, citations }) =>
      `- [${entry.id}] ${entry.title} — cites ${citations.map(({ id, status, current }) =>
        `${id} (${status === 'superseded' ? `superseded; ${current ? `now ${current}` : 'no active successor'}` : status})`,
      ).join(', ')}`,
    ) },
    { title: 'Exact duplicates', lines: report.duplicates.map(({ scope, title, entries }) => `- ${scope}: ${title} — ${entries.map((entry) => `[${entry.id}]`).join(', ')}`) },
    { title: 'Stale holds', lines: report.staleHolds.map(({ entry, untouchedDays }) => `- [${entry.id}] ${entry.title} — untouched ${untouchedDays} days`) },
    { title: 'Unreadable files', lines: report.unreadable.map(({ path, scope, error }) => `- ${path} (${scope}) — ${error.replace(/\s+/g, ' ').trim()}`) },
  ];
  const text = sections.filter((section) => section.lines.length > 0)
    .map((section) => [`## ${section.title}`, ...section.lines].join('\n')).join('\n\n');
  return text === '' ? 'Bosun: nothing to do\n' : text + '\n';
}
