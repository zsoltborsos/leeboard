import { beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { type Entry, timestamp } from '../src/entry.js';
import { appendLog, logSize, writeCursor } from '../src/log.js';
import { addProject } from '../src/projects.js';
import { listEntries, writeEntry } from '../src/store.js';
import { commitFile, makeRepo, sampleEntry, tempDir } from './helpers.js';

const CLI = join(import.meta.dirname, '..', 'dist', 'cli.js');
const BUDGET_MS = 200;

beforeAll(() => {
  if (!existsSync(CLI)) throw new Error('dist/cli.js is missing: run `npm run build` before `npm test`');
});

const SCOPES = ['global', 'machine', 'project:P', 'project:other'];

/** 300 entries spread over four scopes and every kind, each also logged as created by session A. */
function populate(home: string, count = 300): void {
  for (let i = 0; i < count; i++) addEntry(home, i, 'A');
}

function addEntry(home: string, i: number, session: string): void {
  const slot = i % 10;
  const kind: Entry['kind'] = slot === 0 ? 'hold' : slot === 1 ? 'grant' : slot <= 6 ? 'rule' : slot <= 8 ? 'reference' : 'handoff';
  const entry = sampleEntry({
    id: `${kind}-entry-number-${i}-${(i % 65536).toString(16).padStart(4, '0')}`,
    kind,
    scope: SCOPES[i % 4]!,
    title: `Entry number ${i}: keep the generated store realistic and long enough to matter`,
    body: 'Why this exists, in a few lines.\nSecond line of the reason.\n',
    author: { harness: 'claude-code', session, origin: 'agent-inferred' },
    created: '2026-10-17T10:00:00Z',
    updated: '2026-10-17T10:00:00Z',
    ...(kind === 'hold' ? { release: 'when told', blocks: ['helmraiser-run'] } : {}),
    ...(kind === 'grant' ? { holder: 'someone' } : {}),
    ...(kind === 'handoff' ? { to: i % 20 === 9 ? 'harness:pi' : 'any' } : {}),
  });
  writeEntry(home, entry);
  appendLog(home, {
    ts: timestamp(new Date('2026-10-17T10:00:00Z')),
    id: entry.id,
    kind: entry.kind,
    scope: entry.scope,
    event: 'created',
    status: 'active',
    harness: 'claude-code',
    session,
  });
}

function world() {
  const home = tempDir('lb-home-');
  const repo = makeRepo();
  commitFile(repo, 'TASKS.md', '# tasks\n', 'tasks');
  commitFile(repo, 'CURRENT_STATE.md', '# state\n', 'state');
  addProject(home, { name: 'P', paths: [repo] });
  populate(home);
  const env = { ...process.env, LEEBOARD_HOME: home, LEEBOARD_SESSION: 'B', LEEBOARD_HARNESS: 'pi' };
  const lb = (...args: string[]) => spawnSync('node', [CLI, ...args], { cwd: repo, env, encoding: 'utf8' });
  return { home, repo, lb };
}

/** Median wall time in ms of `runs` calls, after one warm-up call. */
function medianMs(fn: () => void, runs = 5): number {
  fn();
  const times: number[] = [];
  for (let i = 0; i < runs; i++) {
    const start = performance.now();
    fn();
    times.push(performance.now() - start);
  }
  return times.sort((a, b) => a - b)[Math.floor(runs / 2)]!;
}

describe('a store of 300 entries', () => {
  it('really holds 300 entries of five kinds across four scopes, so the numbers below mean something', () => {
    const { home } = world();
    const entries = listEntries(home);
    expect(entries).toHaveLength(300);
    expect(new Set(entries.map((entry) => entry.kind))).toEqual(new Set(['hold', 'grant', 'rule', 'reference', 'handoff']));
    expect(new Set(entries.map((entry) => entry.scope)).size).toBe(4);
  });

  it('keeps the brief under 8,000 characters', () => {
    const { lb } = world();
    const result = lb('brief');
    expect(result.status).toBe(0);
    expect(result.stdout.length).toBeLessThanOrEqual(8000);
    expect(result.stdout).toMatch(/… \d+ more — lb list/);
    expect(result.stdout).toContain('## Holds');
    expect(result.stdout).toContain('## Inbox');
  });

  it.skipIf(process.env.CI)(`answers brief and delta each in under ${BUDGET_MS} ms (wall time, node startup included)`, () => {
    const { home, lb } = world();

    const briefMs = medianMs(() => {
      expect(lb('brief').status).toBe(0);
    });

    // Delta workload: 25 changes by another session since B last looked.
    const cursor = logSize(home);
    for (let i = 300; i < 325; i++) addEntry(home, i, 'A');
    const deltaMs = medianMs(() => {
      writeCursor(home, 'B', cursor);
      const result = lb('delta');
      expect(result.status).toBe(0);
      expect(result.stdout).not.toBe('');
    });
    const emptyDeltaMs = medianMs(() => {
      expect(lb('delta').stdout).toBe('');
    });

    console.info(`300 entries, median of 5: brief ${briefMs.toFixed(0)} ms, delta with 25 changes ${deltaMs.toFixed(0)} ms, empty delta ${emptyDeltaMs.toFixed(0)} ms`);
    expect(briefMs).toBeLessThan(BUDGET_MS);
    expect(deltaMs).toBeLessThan(BUDGET_MS);
    expect(emptyDeltaMs).toBeLessThan(BUDGET_MS);
  });
});
