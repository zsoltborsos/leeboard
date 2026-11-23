import { readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { formatFrontmatter, parseFrontmatter } from './entry.js';
import { EXIT, LeeboardError } from './errors.js';
import { findRepo, git, type GitRepo } from './git.js';
import { PROJECT_NAME, writeFileAtomic } from './store.js';

export interface Project {
  name: string;
  aliases: string[];
  paths: string[];
  remotes: string[];
}

function projectFile(home: string, name: string): string {
  return join(home, 'projects', name, 'project.md');
}

function readProject(file: string): Project | null {
  try {
    const { data } = parseFrontmatter(readFileSync(file, 'utf8'));
    const list = (value: unknown) => (Array.isArray(value) ? value.map(String) : []);
    return { name: String(data.name), aliases: list(data.aliases), paths: list(data.paths), remotes: list(data.remotes) };
  } catch {
    return null;
  }
}

const union = (a: string[], b: string[] = []) => [...new Set([...a, ...b])];

/** Register a project, or add paths/aliases/remotes to an existing one. */
export function addProject(
  home: string,
  input: { name: string; paths: string[]; aliases?: string[]; remotes?: string[] },
): Project {
  if (!PROJECT_NAME.test(input.name)) throw new LeeboardError(`invalid project name '${input.name}'`, EXIT.USAGE);
  if (input.paths.length === 0) throw new LeeboardError('a project needs at least one --path', EXIT.USAGE);
  const existing = readProject(projectFile(home, input.name));
  const project: Project = {
    name: input.name,
    aliases: union(existing?.aliases ?? [], input.aliases),
    paths: union(existing?.paths ?? [], input.paths.map((p) => resolve(p))),
    remotes: union(existing?.remotes ?? [], input.remotes),
  };
  writeFileAtomic(projectFile(home, input.name), formatFrontmatter(project, ''));
  return project;
}

export function listProjects(home: string): Project[] {
  let names: string[];
  try {
    names = readdirSync(join(home, 'projects'));
  } catch {
    return [];
  }
  return names
    .sort()
    .map((name) => readProject(projectFile(home, name)))
    .filter((project): project is Project => project !== null);
}

/** `git@github.com:Acme/X.git`, `https://user:pw@GitHub.com/acme/x/` ... -> `github.com/acme/x`. */
export function normalizeRemote(url: string): string {
  let text = url.trim();
  const scp = !text.includes('://') && /^(?:[^@/\s]+@)?([^:/\s]+):(.+)$/.exec(text);
  text = scp ? `${scp[1]}/${scp[2]}` : text.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/^[^@/]*@/, '');
  return text.replace(/\/+$/, '').replace(/\.git$/, '').toLowerCase();
}

function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function contains(parent: string, child: string): boolean {
  return child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}

export interface Resolution {
  project: string | null;
  /** The git repository `cwd` is in, or null. Set even when no project matches. */
  repo: GitRepo | null;
}

/**
 * cwd -> git repository -> registered project: the main repo root matches a
 * registered path exactly, else the longest registered path containing the cwd,
 * else the origin remote. Outside git, only the longest registered path containing
 * the cwd counts (a folder of repos and notes). No match: no project.
 */
export function resolveProject(home: string, cwd: string): Resolution {
  const repo = findRepo(cwd);
  const projects = listProjects(home);
  const here = canonical(cwd);
  if (!repo) {
    let best: { name: string; length: number } | undefined;
    for (const project of projects) {
      for (const path of project.paths.map(canonical)) {
        if (contains(path, here) && (!best || path.length > best.length)) best = { name: project.name, length: path.length };
      }
    }
    return { project: best?.name ?? null, repo: null };
  }

  let best: { name: string; length: number } | undefined;
  for (const project of projects) {
    for (const path of project.paths.map(canonical)) {
      if (path === repo.root) return { project: project.name, repo };
      if ((contains(path, here) || contains(path, repo.root)) && (!best || path.length > best.length)) {
        best = { name: project.name, length: path.length };
      }
    }
  }
  if (best) return { project: best.name, repo };

  if (projects.some((project) => project.remotes.length > 0)) {
    const origin = git(repo.toplevel, ['remote', 'get-url', 'origin']);
    if (origin) {
      const wanted = normalizeRemote(origin);
      const match = projects.find((project) => project.remotes.some((remote) => normalizeRemote(remote) === wanted));
      if (match) return { project: match.name, repo };
    }
  }
  return { project: null, repo };
}
