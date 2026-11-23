import { afterEach } from 'vitest';
import type { Entry } from '../src/entry.js';
import { run } from '../src/run.js';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const created: string[] = [];

/** A fresh temporary directory (realpath'd), removed after the test. */
export function tempDir(prefix = 'lb-test-'): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  created.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Run git in `cwd`; env isolation comes from test/setup.ts. */
export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: process.env }).trim();
}

/** A real temporary git repository on branch main with one empty commit. */
export function makeRepo(): string {
  const repo = tempDir('lb-repo-');
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'init');
  return repo;
}

/** Write a file and commit it, optionally at a fixed ISO date. */
export function commitFile(repo: string, file: string, content: string, message: string, isoDate?: string): void {
  writeFileSync(join(repo, file), content);
  git(repo, 'add', file);
  const env = isoDate ? { ...process.env, GIT_AUTHOR_DATE: isoDate, GIT_COMMITTER_DATE: isoDate } : process.env;
  execFileSync('git', ['commit', '-q', '-m', message], { cwd: repo, env });
}

export interface LbResult {
  code: number;
  out: string;
  err: string;
}

/**
 * `lb` in-process (src/run.ts) against `home`; `options.env` carries the session identity.
 * Stdin is not wired up: `--body -` needs the spawned binary.
 */
export async function lb(home: string, args: string[], options: { env?: Record<string, string>; cwd?: string } = {}): Promise<LbResult> {
  const result = await run(args, { ...process.env, LEEBOARD_HOME: home, ...options.env }, options.cwd ?? tempDir('lb-cwd-'));
  return { code: result.code, out: result.stdout, err: result.stderr };
}

/** A valid entry to build on; override what the test cares about. */
export function sampleEntry(overrides: Partial<Entry> = {}): Entry {
  return {
    id: 'rule-sample-0001',
    kind: 'rule',
    scope: 'global',
    status: 'active',
    title: 'Sample',
    author: { harness: 'claude-code', session: 'A', origin: 'agent-inferred' },
    created: '2026-10-17T10:00:00Z',
    updated: '2026-10-17T10:00:00Z',
    body: '',
    ...overrides,
  };
}

const REPO = join(import.meta.dirname, '..');
export const CLI = join(REPO, 'dist', 'cli.js');

/** Call from `beforeAll` in tests that spawn the built binary, or an `lb` that runs it. */
export function requireBuild(): void {
  if (!existsSync(CLI)) throw new Error('dist/cli.js is missing: run `npm run build` before `npm test`');
}

/**
 * A bin directory with fake `pi` and `claude` (test/fixtures/fake-runner.mjs) and an `lb`
 * that runs this repository's build; put it first on PATH.
 */
export function fakeRunnerBin(): string {
  const bin = tempDir('lb-bin-');
  const shim = (name: string, ...command: string[]) => {
    writeFileSync(join(bin, name), `#!/bin/sh\nexec node ${command.map((part) => `"${part}"`).join(' ')} "$@"\n`);
    chmodSync(join(bin, name), 0o755);
  };
  for (const runner of ['pi', 'claude']) shim(runner, join(REPO, 'test', 'fixtures', 'fake-runner.mjs'), runner);
  shim('lb', CLI);
  return bin;
}
