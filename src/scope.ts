import type { Ctx } from './context.js';
import { type Author, type Entry, kindOfId } from './entry.js';
import type { GitRepo } from './git.js';
import { resolveProject } from './projects.js';

/** Where a command is running: the resolved project (if any) and the scopes that apply there. */
export interface View {
  project: string | null;
  repo: GitRepo | null;
  /** global, machine and, when a project resolves, that project's scope. */
  scopes: string[];
}

export function viewFor(ctx: Ctx): View {
  const { project, repo } = resolveProject(ctx.home, ctx.cwd);
  return { project, repo, scopes: ['global', 'machine', ...(project ? [`project:${project}`] : [])] };
}

/** Handoffs and requests carry their kind in the id, so the inbox scan can skip other files unread. */
export function isInboxId(id: string): boolean {
  const kind = kindOfId(id);
  return kind === 'handoff' || kind === 'request';
}

/** A handoff or request addressed to this project, this session, this harness, or anyone. */
export function addressedToMe(entry: Pick<Entry, 'kind' | 'to'>, view: View, identity: Author): boolean {
  if (entry.kind !== 'handoff' && entry.kind !== 'request') return false;
  const { to } = entry;
  return (
    to === 'any' ||
    (view.project !== null && to === `project:${view.project}`) ||
    (identity.session !== null && to === `session:${identity.session}`) ||
    (identity.harness !== null && to === `harness:${identity.harness}`)
  );
}
