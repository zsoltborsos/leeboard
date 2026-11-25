import type { Ctx } from '../context.js';
import { usageError } from '../errors.js';
import { removeProject } from '../project-remove.js';
import { renameProject } from '../project-rename.js';
import { addProject, listProjects, type Project } from '../projects.js';
import { jsonLine, ok, type RunResult } from '../result.js';

interface ProjectFlags {
  json?: boolean;
  path?: string[];
  remote?: string[];
}

interface ProjectContext {
  home: string;
  /** Add/list need no identity; rename/remove validate arguments before resolving it. */
  ctx: () => Ctx;
}

export function projectCommand({ home, ctx }: ProjectContext, args: string[], flags: ProjectFlags): RunResult {
  const describe = (p: Project): string =>
    `- ${p.name} — paths: ${p.paths.join(', ')}` +
    (p.remotes.length ? ` — remotes: ${p.remotes.join(', ')}` : '') +
    '\n';
  switch (args[0]) {
    case 'add': {
      const name = args[1];
      if (name === undefined) throw usageError('usage: lb project add <name> --path <path>');
      const added = addProject(home, {
        name,
        paths: flags.path ?? [],
        remotes: flags.remote,
      });
      return ok(flags.json ? jsonLine(added) : describe(added));
    }
    case 'rename': {
      const [from, to] = [args[1], args[2]];
      if (!from || !to || (flags.path?.length ?? 0) > 1) throw usageError('usage: lb project rename <old> <new> [--path <dir>]');
      const renamed = renameProject(ctx(), from, to, flags.path?.[0]);
      return ok(flags.json ? jsonLine(renamed) : describe(renamed));
    }
    case 'remove': {
      if (!args[1] || args.length > 2) throw usageError('usage: lb project remove <name> [--path <dir>]...');
      const result = removeProject(ctx(), args[1], flags.path);
      if (flags.json) return ok(jsonLine(result));
      return ok('removed' in result ? `removed project ${result.removed}\n` : `dropped ${result.droppedPaths.length} path(s)\n${describe(result.project)}`);
    }
    case 'list': {
      const projects = listProjects(home);
      return ok(flags.json ? jsonLine(projects) : projects.map(describe).join(''));
    }
    default:
      throw usageError('usage: lb project add|rename|remove|list');
  }
}
