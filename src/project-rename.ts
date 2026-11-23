import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Ctx } from './context.js';
import { EXIT, LeeboardError } from './errors.js';
import { logChange } from './log.js';
import { addProject, listProjects, type Project } from './projects.js';
import { listEntries, listEntriesWithDiagnostics, PROJECT_NAME, withRevisionLock, writeEntry } from './store.js';

/**
 * Rename a registered project: its folder, `scope: project:<old>` on every entry in it and
 * `to: project:<old>` on every entry anywhere, whatever the status (lb writes an entry into
 * the folder its scope names, so a closed entry left behind would recreate the old folder).
 * `path` becomes the first path; the old paths stay. Ids, bodies and timestamps do not change.
 * Safe to run again after an interruption: entries already moved are left as they are.
 */
export function renameProject(ctx: Ctx, from: string, to: string, path?: string): Project {
  const fail = (message: string): never => {
    throw new LeeboardError(message, EXIT.USAGE);
  };
  if (!PROJECT_NAME.test(to)) fail(`invalid project name '${to}'`);
  return withRevisionLock(ctx.home, () => {
    const projects = listProjects(ctx.home);
    const old = projects.find((project) => project.name === from) ?? fail(`no project named '${from}'`);
    if (projects.some((project) => project.name === to)) fail(`project '${to}' already exists`);

    const oldScope = `project:${from}`;
    const newScope = `project:${to}`;
    // A file lb cannot parse would be left behind and keep the old folder alive.
    const [unreadable] = listEntriesWithDiagnostics(ctx.home, [oldScope]).unreadable;
    if (unreadable) fail(`cannot rename project '${from}': unreadable entry file ${unreadable.path}; fix or remove it first`);
    for (const entry of listEntries(ctx.home)) {
      if (entry.scope !== oldScope && entry.to !== oldScope) continue;
      const previousScope = entry.scope;
      const moved = { ...entry, scope: entry.scope === oldScope ? newScope : entry.scope };
      if (entry.to === oldScope) moved.to = newScope;
      writeEntry(ctx.home, moved, previousScope);
      logChange(ctx, moved, 'updated');
    }

    const renamed = addProject(ctx.home, {
      name: to,
      paths: path === undefined ? old.paths : [resolve(path), ...old.paths],
      aliases: old.aliases,
      remotes: old.remotes,
    });
    const oldDir = join(ctx.home, 'projects', from);
    const entriesDir = join(oldDir, 'entries');
    if (existsSync(entriesDir) && readdirSync(entriesDir).some((name) => name.endsWith('.md'))) {
      throw new Error(`entries are left in ${entriesDir}; nothing was removed`);
    }
    rmSync(oldDir, { recursive: true, force: true });
    return renamed;
  });
}
