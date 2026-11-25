import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Ctx } from '../context.js';
import { isActive, type Kind, newestFirst, staleHoldDays, summarize, type Summary } from '../entry.js';
import { clip, describeHold, plural } from '../format.js';
import { git, type GitRepo } from '../git.js';
import { logSize, writeCursor } from '../log.js';
import { showsOwnerReview } from '../policy.js';
import { jsonLine, ok, type RunResult } from '../result.js';
import { addressedToMe, isInboxId, viewFor } from '../scope.js';
import { listEntries, listEntriesWithDiagnostics } from '../store.js';
import { appendUsage } from '../usage.js';
import { renderReviewDigest, review, reviewCounts, type ReviewCounts } from './review.js';

const MAX_CHARS = 8000;
const DAY_MS = 86_400_000;
const STATE_FILES = ['TASKS.md', 'CURRENT_STATE.md'];

export interface BriefHold extends Summary {
  /** Whole days since the hold was last touched, when that is 7 or more. */
  untouchedDays?: number;
}

export interface RepoFileState {
  path: string;
  /** Null when the file exists but has never been committed. */
  lastCommit: string | null;
  daysAgo?: number;
  commitsSince?: number;
}

export interface BriefData {
  project: string | null;
  /** Main checkout of the git repository the cwd is in, when it is not a registered project. */
  unregisteredRepo: string | null;
  holds: BriefHold[];
  grants: Summary[];
  rules: Summary[];
  references: Summary[];
  inbox: Summary[];
  repoState: RepoFileState[];
  ownerReview?: ReviewCounts;
  unreadableCount: number;
}

/** Gather the session-start orientation, then move this session's cursor to the end of the log. */
export function brief(ctx: Ctx): BriefData {
  // Read the log size first: a change written while we read is then seen by the next delta.
  const cursor = logSize(ctx.home);
  const view = viewFor(ctx);

  const { entries, unreadable } = listEntriesWithDiagnostics(ctx.home, view.scopes);
  const inScope = entries
    .filter((entry) => isActive(entry, ctx.now))
    .sort(newestFirst);
  const ofKind = (kind: Kind) => inScope.filter((entry) => entry.kind === kind);

  const inbox = listEntries(ctx.home, undefined, isInboxId)
    .filter((entry) => isActive(entry, ctx.now) && addressedToMe(entry, view, ctx.identity))
    .sort(newestFirst);

  const data: BriefData = {
    project: view.project,
    unregisteredRepo: view.project === null && view.repo ? view.repo.root : null,
    holds: ofKind('hold').map((hold) => {
      const days = staleHoldDays(hold, ctx.now);
      return days !== undefined ? { ...summarize(hold), untouchedDays: days } : summarize(hold);
    }),
    grants: ofKind('grant').map(summarize),
    rules: ofKind('rule').map(summarize),
    references: ofKind('reference').map(summarize),
    inbox: inbox.map(summarize),
    repoState: repoState(ctx.now, view.repo),
    unreadableCount: unreadable.length,
  };
  if (showsOwnerReview(ctx.identity)) {
    const counts = reviewCounts(review(ctx, { peek: true }));
    if (counts.new + counts.changed + counts.closed > 0) data.ownerReview = counts;
  }
  if (ctx.identity.session) writeCursor(ctx.home, ctx.identity.session, cursor);
  return data;
}

/**
 * The CLI entry point for `brief`: gather and render, then record the call. The usage
 * write is best-effort; JSON mode still records the rendered text's size and count.
 */
export function briefCommand(ctx: Ctx, flags: { json?: boolean }): RunResult {
  const data = brief(ctx);
  const { text, entries } = renderBriefWithCount(data);
  appendUsage(ctx, data.project, { command: 'brief', entries, chars: text.length });
  return ok(flags.json ? jsonLine(data) : text);
}

function repoState(now: Date, repo: GitRepo | null): RepoFileState[] {
  if (!repo) return [];
  const states: RepoFileState[] = [];
  for (const path of STATE_FILES) {
    if (!existsSync(join(repo.toplevel, path))) continue;
    const last = git(repo.toplevel, ['log', '-1', '--format=%H %cI', '--', path]);
    if (!last) {
      states.push({ path, lastCommit: null });
      continue;
    }
    const [sha, date] = last.split(' ') as [string, string];
    states.push({
      path,
      lastCommit: date.slice(0, 10),
      daysAgo: Math.floor((now.getTime() - Date.parse(date)) / DAY_MS),
      commitsSince: Number(git(repo.toplevel, ['rev-list', '--count', `${sha}..HEAD`]) ?? 0),
    });
  }
  return states;
}

interface Section {
  title: string;
  lines: string[];
  dropped: number;
}

/** Markdown, at most 8,000 characters: the longest section is trimmed until it fits. */
export function renderBrief(data: BriefData): string {
  return renderBriefWithCount(data).text;
}

/**
 * `renderBrief`, plus how many entries the text shows after trimming: entry lines only,
 * never headings, omission notices or repo-state lines.
 */
export function renderBriefWithCount(data: BriefData): { text: string; entries: number } {
  const header = [`# Leeboard: ${data.project ? `project ${data.project}` : 'no registered project'}`];
  if (data.unregisteredRepo) {
    header.push(`This git repository is unregistered. Register it: lb project add <name> --path ${data.unregisteredRepo}`);
  }
  const scopeSuffix = (entry: Summary) => (entry.scope.startsWith('project:') ? '' : ` (${entry.scope})`);

  const entrySections: Section[] = [
    {
      title: 'Holds',
      lines: data.holds.map(
        (hold) =>
          `- [${hold.id}] ${describeHold(hold)}` +
          (hold.untouchedDays === undefined ? '' : ` (untouched ${plural(hold.untouchedDays, 'day')})`),
      ),
    },
    { title: 'Grants', lines: data.grants.map((grant) => `- [${grant.id}] ${grant.title} — holder: ${grant.holder}`) },
    { title: 'Rules', lines: data.rules.map((rule) => `- [${rule.id}] ${rule.title}${scopeSuffix(rule)}`) },
    { title: 'References', lines: data.references.map((ref) => `- [${ref.id}] ${ref.title}${scopeSuffix(ref)}`) },
    { title: 'Inbox', lines: data.inbox.map((item) => `- [${item.id}] ${item.kind} to ${item.to}: ${item.title}`) },
  ].map(({ title, lines }) => ({ title, lines: lines.map(clip), dropped: 0 }));
  const sections: Section[] = [
    ...entrySections,
    { title: 'Repo state', lines: data.repoState.map((file) => clip(describeRepoFile(file))), dropped: 0 },
  ];

  // Keep both footers outside the trimmable sections, but include them in the size budget.
  const digest = data.ownerReview ? renderReviewDigest(data.ownerReview) : '';
  const warning = data.unreadableCount > 0
    ? `Unreadable entry files: ${data.unreadableCount} — run \`lb bosun --quick\` for details`
    : '';
  const render = () =>
    [
      header.join('\n'),
      ...sections
        .filter((section) => section.lines.length > 0)
        .map((section) =>
          [`## ${section.title}`, ...section.lines, ...(section.dropped ? [`… ${section.dropped} more — lb list`] : [])].join('\n'),
        ),
      ...(digest ? [digest] : []),
      ...(warning ? [warning] : []),
    ].join('\n\n') + '\n';

  const size = (section: Section) => section.lines.reduce((total, line) => total + line.length + 1, 0);
  const longest = () =>
    sections
      .filter((section) => section.lines.length > 0)
      .reduce<Section | undefined>((best, section) => (!best || size(section) >= size(best) ? section : best), undefined);

  // Drop lines from the longest section until about the excess is freed, then measure again
  // (the "… N more" lines add a little back), rather than re-rendering after every line.
  const entries = () => entrySections.reduce((total, section) => total + section.lines.length, 0);
  let text = render();
  while (text.length > MAX_CHARS) {
    let freed = 0;
    while (freed < text.length - MAX_CHARS) {
      const section = longest();
      if (!section) return { text, entries: entries() };
      freed += section.lines.pop()!.length + 1;
      section.dropped++;
    }
    text = render();
  }
  return { text, entries: entries() };
}

function describeRepoFile(file: RepoFileState): string {
  if (file.lastCommit === null) return `- ${file.path}: not committed yet`;
  const age = `${plural(file.daysAgo!, 'day')} ago`;
  return `- ${file.path}: last committed ${file.lastCommit} (${age}), ${plural(file.commitsSince!, 'commit')} since`;
}
