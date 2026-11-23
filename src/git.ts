import { execFileSync } from 'node:child_process';
import { basename, dirname } from 'node:path';

export interface GitRepo {
  /** Root of the current work tree (a linked worktree's own directory). */
  toplevel: string;
  /** Root of the main checkout; the same for every worktree of a repository. */
  root: string;
}

/** Trimmed stdout of `git <args>` in `cwd`, or null if git fails (not a repo, bad path, ...). */
export function git(cwd: string, args: string[]): string | null {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    }).trim();
  } catch {
    return null;
  }
}

export function findRepo(cwd: string): GitRepo | null {
  const out = git(cwd, ['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir']);
  if (!out) return null;
  const [toplevel, commonDir] = out.split('\n');
  if (!toplevel || !commonDir) return null;
  return { toplevel, root: basename(commonDir) === '.git' ? dirname(commonDir) : toplevel };
}
