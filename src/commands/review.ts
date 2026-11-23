import type { Ctx } from '../context.js';
import { isActive, type Kind, type Origin, type RevisionBefore, type Status } from '../entry.js';
import { latestChanges, type LogLine, readLogSince, readReviewCursor, writeReviewCursor } from '../log.js';
import { createSuccessorResolver, listEntries, readRevision } from '../store.js';

export interface ReviewItem {
  id: string;
  kind: Kind;
  scope: string;
  title: string;
  status: Status;
  harness: string | null;
  session: string | null;
  origin: Origin;
  before?: RevisionBefore;
  revisionChanges?: string[];
  supersededBy?: string[];
  /** Rendering only; omitted from CLI JSON. */
  current?: string | null;
}

export interface ReviewData {
  new: ReviewItem[];
  changed: ReviewItem[];
  closed: ReviewItem[];
}

export interface ReviewCounts {
  new: number;
  changed: number;
  closed: number;
}

/** Latest changes across the whole store, acknowledging them unless this is a peek. */
export function review(ctx: Ctx, options: { peek?: boolean; details?: boolean } = {}): ReviewData {
  const { lines, end } = readLogSince(ctx.home, readReviewCursor(ctx.home));
  const created = new Set<string>();
  const closed = new Set<string>();
  const revised = new Set<string>();
  const revisions = new Map<string, LogLine[]>();
  for (const line of lines) {
    if (line.event === 'created') created.add(line.id);
    if (line.event === 'revised') revised.add(line.id);
    if (line.event === 'status' && line.status !== 'active') closed.add(line.id);
    if (options.details && line.event === 'revised' && line.revision) {
      const events = revisions.get(line.id) ?? [];
      events.push(line);
      revisions.set(line.id, events);
    }
  }

  const data: ReviewData = { new: [], changed: [], closed: [] };
  for (const { line, entry } of latestChanges(ctx.home, lines)) {
    const group = created.has(line.id) ? data.new
      : line.status !== 'active' && closed.has(line.id) ? data.closed
      : isActive(entry, ctx.now) || (entry.status === 'active' && revised.has(line.id)) ? data.changed : null;
    if (!group) continue;
    const item: ReviewItem = {
      id: line.id,
      kind: line.kind,
      scope: line.scope,
      title: entry.title,
      status: line.status,
      harness: line.harness,
      session: line.session,
      origin: entry.author.origin,
    };
    for (const event of revisions.get(line.id) ?? []) {
      const record = readRevision(ctx.home, line.id, event.revision!.offset);
      if (!record) continue;
      item.before ??= record.before;
      item.revisionChanges ??= [];
      const { fields } = event.revision!;
      if (fields.includes('title')) item.revisionChanges.push(`was: ${record.before.title}`);
      if (fields.includes('scope')) item.revisionChanges.push(`scope: ${record.before.scope} → ${event.scope}`);
      if (fields.includes('body')) item.revisionChanges.push('body revised');
    }
    group.push(item);
  }
  if (!options.peek) writeReviewCursor(ctx.home, end);
  return data;
}

/** CLI details and successor enrichment; brief intentionally uses lightweight review() instead. */
export function reviewCommand(ctx: Ctx, options: { peek?: boolean } = {}): ReviewData {
  const data = review(ctx, { peek: options.peek, details: true });
  let resolveSuccessor: ReturnType<typeof createSuccessorResolver> | undefined;
  for (const group of [data.new, data.changed, data.closed]) {
    for (const item of group) {
      if (item.status !== 'superseded') continue;
      resolveSuccessor ??= createSuccessorResolver(listEntries(ctx.home));
      const { successors, current } = resolveSuccessor(item.id);
      item.supersededBy = successors.map((next) => next.id);
      item.current = current?.id ?? null;
    }
  }
  return data;
}

export function reviewCounts(data: ReviewData): ReviewCounts {
  return { new: data.new.length, changed: data.changed.length, closed: data.closed.length };
}

export function renderReview(data: ReviewData): string {
  return (['new', 'changed', 'closed'] as const)
    .filter((group) => data[group].length > 0)
    .map((group) => [
      `## ${group[0]!.toUpperCase()}${group.slice(1)}`,
      ...data[group].flatMap((item) => {
        const target = item.status === 'superseded' ? item.current ?? item.supersededBy?.[0] : undefined;
        return [
          `- [${item.id}] ${item.kind} ${item.scope}: ${item.title} (${item.harness ?? 'unknown'}/${item.session?.slice(0, 8) ?? 'unknown'}, ${item.origin})${target ? ` → ${target}` : ''}`,
          ...(item.revisionChanges ?? []).map((hint) => `  ${hint}`),
        ];
      }),
    ].join('\n') + '\n')
    .join('\n');
}

export function renderReviewDigest(counts: ReviewCounts): string {
  const parts = (['new', 'changed', 'closed'] as const)
    .filter((group) => counts[group] > 0)
    .map((group) => `${counts[group]} ${group}`);
  return parts.length === 0 ? '' : `Owner review: ${parts.join(', ')} since the last review — run \`lb review\``;
}
