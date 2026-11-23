import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Ctx } from './context.js';
import { EXIT, LeeboardError } from './errors.js';
import { listProjects, type Project } from './projects.js';
import { formatFrontmatter } from './entry.js';
import { listEntries, withRevisionLock, writeFileAtomic } from './store.js';

export type RemoveResult = { removed: string } | { project: Project; droppedPaths: string[] };

/**
 * Take a project out of the registry, or with `paths` only those paths. A whole project is
 * refused while any entry, of any status, is scoped to it or an active entry is addressed to
 * it: purge or move those first, so nothing is left without a folder. Owner's call, as purge.
 */
export function removeProject(ctx: Ctx, name: string, paths: string[] = []): RemoveResult {
  const harness = ctx.identity.harness;
  if (harness === 'bosun' || harness === 'helmraiser') {
    throw new LeeboardError(`${harness} may not remove projects; ask the owner or an interactive session`, EXIT.NOT_PERMITTED);
  }
  const usage = (message: string): never => {
    throw new LeeboardError(message, EXIT.USAGE);
  };
  return withRevisionLock(ctx.home, () => {
    const project = listProjects(ctx.home).find((p) => p.name === name) ?? usage(`no project named '${name}'`);

    if (paths.length > 0) {
      const drop = paths.map((p) => resolve(p));
      const unknown = drop.filter((p) => !project.paths.includes(p));
      if (unknown.length > 0) usage(`'${name}' has no path ${unknown.join(', ')}`);
      const kept = project.paths.filter((p) => !drop.includes(p));
      if (kept.length === 0) usage(`that would leave '${name}' with no path; remove the project instead`);
      const updated = { ...project, paths: kept };
      writeFileAtomic(join(ctx.home, 'projects', name, 'project.md'), formatFrontmatter(updated, ''));
      return { project: updated, droppedPaths: drop };
    }

    const scope = `project:${name}`;
    const blockers = listEntries(ctx.home)
      .filter((entry) => entry.scope === scope || (entry.status === 'active' && entry.to === scope))
      .map((entry) => entry.id);
    const entriesDir = join(ctx.home, 'projects', name, 'entries');
    const files = existsSync(entriesDir) ? readdirSync(entriesDir).filter((f) => f.endsWith('.md')) : [];
    if (blockers.length > 0 || files.length > 0) {
      const ids = blockers.length > 0 ? blockers : files.map((f) => f.replace(/\.md$/, ''));
      throw new LeeboardError(
        `cannot remove project '${name}': entries still belong to it (${ids.join(', ')}). Purge or move them first`,
        EXIT.BAD_TRANSITION,
      );
    }
    rmSync(join(ctx.home, 'projects', name), { recursive: true, force: true });
    return { removed: name };
  });
}
