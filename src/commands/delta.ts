import type { Ctx } from '../context.js';
import type { Kind, Status } from '../entry.js';
import { describeHold } from '../format.js';
import { latestChanges, logSize, readCursor, readLogSince, writeCursor } from '../log.js';
import { addressedToMe, viewFor } from '../scope.js';
import { createSuccessorResolver, listEntries } from '../store.js';
import { json, ok, type RunResult } from '../result.js';

export interface DeltaItem {
  id: string;
  kind: Kind;
  scope: string;
  event: string;
  status: Status;
  title: string;
  release?: string;
  to?: string;
  supersededBy?: string[];
  /** Rendering only; omitted from CLI JSON. */
  current?: string | null;
}

/**
 * Changes since this session's cursor that apply here: scopes in play for the cwd, or
 * handoffs/requests addressed to this project, session or harness. Skips the session's own
 * changes, keeps the latest event per entry, and moves the cursor to the end of what it read.
 * A session with no cursor starts at the end of the log.
 */
export function delta(ctx: Ctx): DeltaItem[] {
  const { session } = ctx.identity;
  if (!session) return [];
  const cursor = readCursor(ctx.home, session);
  if (cursor === null) {
    writeCursor(ctx.home, session, logSize(ctx.home));
    return [];
  }

  const { lines, end } = readLogSince(ctx.home, cursor);
  if (end !== cursor) writeCursor(ctx.home, session, end);
  if (lines.length === 0) return [];

  const view = viewFor(ctx);
  const items: DeltaItem[] = [];
  let resolveSuccessor: ReturnType<typeof createSuccessorResolver> | undefined;
  for (const { line, entry } of latestChanges(ctx.home, lines)) {
    if (line.session === session) continue;
    if (!view.scopes.includes(line.scope) && !addressedToMe(entry, view, ctx.identity)) continue;
    const item: DeltaItem = {
      id: line.id,
      kind: line.kind,
      scope: line.scope,
      event: line.event,
      status: line.status,
      title: entry.title,
    };
    if (entry.release !== undefined) item.release = entry.release;
    if (entry.to !== undefined) item.to = entry.to;
    if (line.status === 'superseded') {
      resolveSuccessor ??= createSuccessorResolver(listEntries(ctx.home), ctx.now);
      const { successors, current } = resolveSuccessor(line.id);
      item.supersededBy = successors.map((next) => next.id);
      item.current = current?.id ?? null;
    }
    items.push(item);
  }
  return items;
}

/** Own the CLI output without rendering text for JSON delivery. */
export function deltaCommand(ctx: Ctx, jsonOutput: boolean | undefined): RunResult {
  const items = delta(ctx);
  return ok(items.length === 0 ? '' : jsonOutput ? json(items.map(({ current, ...item }) => item)) : renderDelta(items));
}

/** `- [id] <kind> <event or new status>: title`; holds also show their release condition. Empty for no items. */
export function renderDelta(items: DeltaItem[]): string {
  return items
    .map((item) => {
      const what = item.event === 'status' ? item.status : item.event;
      const title = item.kind === 'hold' ? describeHold({ title: item.title, release: item.release }) : item.title;
      const target = item.status === 'superseded' ? item.current ?? item.supersededBy?.[0] : undefined;
      return `- [${item.id}] ${item.kind} ${what}: ${title}${target ? ` → ${target}` : ''}\n`;
    })
    .join('');
}
