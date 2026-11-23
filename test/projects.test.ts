import { describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EXIT, LeeboardError } from '../src/errors.js';
import { addProject, listProjects, normalizeRemote, resolveProject } from '../src/projects.js';
import { git, makeRepo, tempDir } from './helpers.js';

describe('project registry', () => {
  it('starts empty', () => {
    expect(listProjects(tempDir())).toEqual([]);
  });

  it('stores a project as projects/<name>/project.md with the fields of the plan', () => {
    const home = tempDir();
    addProject(home, { name: 'api', paths: ['/work/api'], aliases: ['sg'], remotes: ['git@github.com:acme/api.git'] });
    expect(readFileSync(join(home, 'projects', 'api', 'project.md'), 'utf8')).toBe(`---
name: api
aliases: [sg]
paths: [/work/api]
remotes: [git@github.com:acme/api.git]
---
`);
    expect(listProjects(home)).toEqual([
      { name: 'api', aliases: ['sg'], paths: ['/work/api'], remotes: ['git@github.com:acme/api.git'] },
    ]);
  });

  it('adding to an existing project merges paths, aliases and remotes without duplicates', () => {
    const home = tempDir();
    addProject(home, { name: 'api', paths: ['/work/api'], aliases: ['sg'] });
    addProject(home, { name: 'api', paths: ['/work/api', '/other/clone'], remotes: ['https://x.test/a/b'] });
    expect(listProjects(home)).toEqual([
      { name: 'api', aliases: ['sg'], paths: ['/work/api', '/other/clone'], remotes: ['https://x.test/a/b'] },
    ]);
  });

  it('lists projects by name', () => {
    const home = tempDir();
    addProject(home, { name: 'b', paths: ['/b'] });
    addProject(home, { name: 'a', paths: ['/a'] });
    expect(listProjects(home).map((p) => p.name)).toEqual(['a', 'b']);
  });

  it.each(['', '../escape', 'a/b', '.hidden', 'has space'])('rejects the project name %j', (name) => {
    const error = (() => {
      try {
        addProject(tempDir(), { name, paths: ['/x'] });
      } catch (e) {
        return e as LeeboardError;
      }
    })();
    expect(error).toBeInstanceOf(LeeboardError);
    expect(error?.exitCode).toBe(EXIT.USAGE);
  });

  it('requires at least one path', () => {
    expect(() => addProject(tempDir(), { name: 'x', paths: [] })).toThrow(/path/);
  });
});

describe('normalizeRemote', () => {
  it.each([
    ['git@github.com:Acme/Widgets.git', 'github.com/acme/widgets'],
    ['https://github.com/acme/widgets', 'github.com/acme/widgets'],
    ['https://GitHub.com/acme/widgets.git/', 'github.com/acme/widgets'],
    ['ssh://git@github.com/acme/widgets.git', 'github.com/acme/widgets'],
    ['https://user:s3cret@github.com/acme/widgets.git', 'github.com/acme/widgets'],
    ['github.com:acme/widgets', 'github.com/acme/widgets'],
  ])('%s -> %s', (url, expected) => {
    expect(normalizeRemote(url)).toBe(expected);
  });
});

describe('resolveProject', () => {
  it('matches the repository root exactly, from the root or any subdirectory', () => {
    const home = tempDir();
    const repo = makeRepo();
    mkdirSync(join(repo, 'src', 'deep'), { recursive: true });
    addProject(home, { name: 'alpha', paths: [repo] });

    expect(resolveProject(home, repo).project).toBe('alpha');
    expect(resolveProject(home, join(repo, 'src', 'deep')).project).toBe('alpha');
  });

  it('falls back to the longest registered path that contains the working directory', () => {
    const home = tempDir();
    const container = tempDir('lb-container-');
    const repo = join(container, 'repo');
    mkdirSync(repo);
    git(repo, 'init', '-q', '-b', 'main');
    mkdirSync(join(repo, 'packages', 'web', 'src'), { recursive: true });
    mkdirSync(join(repo, 'docs'), { recursive: true });
    addProject(home, { name: 'everything', paths: [container] });
    addProject(home, { name: 'web', paths: [join(repo, 'packages', 'web')] });

    expect(resolveProject(home, join(repo, 'packages', 'web', 'src')).project).toBe('web');
    expect(resolveProject(home, join(repo, 'docs')).project).toBe('everything');
  });

  it('does not treat a sibling directory with a common name prefix as inside a registered path', () => {
    const home = tempDir();
    const parent = tempDir('lb-siblings-');
    const repo = join(parent, 'app-extra');
    mkdirSync(repo);
    git(repo, 'init', '-q', '-b', 'main');
    addProject(home, { name: 'app', paths: [join(parent, 'app')] });

    expect(resolveProject(home, repo).project).toBeNull();
  });

  it('resolves a git worktree to the same project as its main checkout', () => {
    const home = tempDir();
    const repo = makeRepo();
    const worktrees = tempDir('lb-worktrees-');
    const worktree = join(worktrees, 'feature');
    git(repo, 'worktree', 'add', '-q', '-b', 'feature', worktree);
    addProject(home, { name: 'alpha', paths: [repo] });

    const resolved = resolveProject(home, worktree);
    expect(resolved.project).toBe('alpha');
    expect(resolved.repo).toEqual({ toplevel: worktree, root: repo });
    expect(resolveProject(home, repo).repo).toEqual({ toplevel: repo, root: repo });
  });

  it('matches the origin remote when no path matches', () => {
    const home = tempDir();
    const repo = makeRepo();
    git(repo, 'remote', 'add', 'origin', 'git@github.com:Acme/Widgets.git');
    addProject(home, { name: 'widgets', paths: ['/somewhere/else'], remotes: ['https://github.com/acme/widgets'] });

    expect(resolveProject(home, repo).project).toBe('widgets');
  });

  it('prefers a path match over a remote match', () => {
    const home = tempDir();
    const repo = makeRepo();
    git(repo, 'remote', 'add', 'origin', 'https://github.com/acme/widgets');
    addProject(home, { name: 'by-remote', paths: ['/elsewhere'], remotes: ['https://github.com/acme/widgets'] });
    addProject(home, { name: 'by-path', paths: [repo] });

    expect(resolveProject(home, repo).project).toBe('by-path');
  });

  it('matches a registered path outside a git repository (a folder holding repos and notes)', () => {
    const home = tempDir();
    const container = tempDir('lb-plain-');
    mkdirSync(join(container, 'notes'));
    addProject(home, { name: 'alpha', paths: [container] });

    expect(resolveProject(home, container)).toEqual({ project: 'alpha', repo: null });
    expect(resolveProject(home, join(container, 'notes'))).toEqual({ project: 'alpha', repo: null });
  });

  it('is null outside a git repository under no registered path', () => {
    const home = tempDir();
    addProject(home, { name: 'alpha', paths: [tempDir('lb-plain-')] });

    expect(resolveProject(home, tempDir('lb-elsewhere-'))).toEqual({ project: null, repo: null });
  });

  it('is null for an unregistered repository but still reports the repository', () => {
    const home = tempDir();
    const repo = makeRepo();
    addProject(home, { name: 'other', paths: ['/not/this/one'] });

    expect(resolveProject(home, repo)).toEqual({ project: null, repo: { toplevel: repo, root: repo } });
  });

  it('never registers anything on its own', () => {
    const home = tempDir();
    const repo = makeRepo();
    resolveProject(home, repo);
    expect(listProjects(home)).toEqual([]);
  });

  it('is null for a working directory that does not exist', () => {
    expect(resolveProject(tempDir(), '/definitely/not/here')).toEqual({ project: null, repo: null });
  });
});
