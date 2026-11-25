import type { Ctx } from '../context.js';
import { usageError } from '../errors.js';
import { removeProject } from '../project-remove.js';
import { renameProject } from '../project-rename.js';
import { addProject, listProjects, type Project } from '../projects.js';
import { jsonLine, ok, type RunResult } from '../result.js';

export function projectCommand(
  home: string,
  args: string[],
  values: { json?: boolean; path?: string[]; remote?: string[] },
  ctx: () => Ctx,
): RunResult {
  const describe = (p: Project): string =>
    `- ${p.name} — paths: ${p.paths.join(', ')}` +
    (p.remotes.length ? ` — remotes: ${p.remotes.join(', ')}` : '') +
    '\n';
  switch (args[0]) {
    case 'add': {
      const added = addProject(home, {
        name: args[1] ?? fail('usage: lb project add <name> --path <path>'),
        paths: values.path ?? [],
        remotes: values.remote,
      });
      return ok(values.json ? jsonLine(added) : describe(added));
    }
    case 'rename': {
      const [from, to] = [args[1], args[2]];
      if (!from || !to || (values.path?.length ?? 0) > 1) fail('usage: lb project rename <old> <new> [--path <dir>]');
      const renamed = renameProject(ctx(), from!, to!, values.path?.[0]);
      return ok(values.json ? jsonLine(renamed) : describe(renamed));
    }
    case 'remove': {
      if (!args[1] || args.length > 2) fail('usage: lb project remove <name> [--path <dir>]...');
      const result = removeProject(ctx(), args[1]!, values.path);
      if (values.json) return ok(jsonLine(result));
      return ok('removed' in result ? `removed project ${result.removed}\n` : `dropped ${result.droppedPaths.length} path(s)\n${describe(result.project)}`);
    }
    case 'list': {
      const projects = listProjects(home);
      return ok(values.json ? jsonLine(projects) : projects.map(describe).join(''));
    }
    default:
      throw usageError('usage: lb project add|rename|remove|list');
  }
}

function fail(message: string): never {
  throw usageError(message);
}
