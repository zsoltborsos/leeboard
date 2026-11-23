import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { check, renderCheck } from '../src/commands/check.js';
import { createEntry, releaseHold } from '../src/change.js';
import type { Ctx } from '../src/context.js';
import { EXIT, LeeboardError } from '../src/errors.js';
import { addProject } from '../src/projects.js';
import { scopeDir, writeEntry } from '../src/store.js';
import { lb, makeRepo, sampleEntry, tempDir } from './helpers.js';

function world(now = '2026-10-17T14:02:11Z') {
  const home = tempDir();
  const repo = makeRepo();
  addProject(home, { name: 'alpha', paths: [repo] });
  const ctx: Ctx = { home, cwd: repo, now: new Date(now), identity: { harness: 'claude-code', session: 'A', origin: 'agent-inferred' } };
  return { home, repo, ctx };
}

describe('check', () => {
  it('finds nothing when no hold blocks the tag', () => {
    const { ctx } = world();
    createEntry(ctx, { kind: 'hold', title: 'Other', release: 'r', blocks: ['deploy'] });
    createEntry(ctx, { kind: 'rule', title: 'Not a hold' });
    expect(check(ctx, 'helmraiser-run').holds).toEqual([]);
    expect(renderCheck([])).toBe('');
  });

  it('reports every active hold in scope that blocks the tag', () => {
    const { ctx } = world();
    const project = createEntry(ctx, { kind: 'hold', title: 'Tunnel open', release: 'tunnel closed', blocks: ['helmraiser-run', 'deploy'] });
    const global = createEntry(ctx, { kind: 'hold', title: 'Freeze', release: 'the owner says so', blocks: ['helmraiser-run'], scope: 'global' });
    const machine = createEntry(ctx, { kind: 'hold', title: 'Laptop busy', release: 'build done', blocks: ['helmraiser-run'], scope: 'machine' });

    const blocking = check(ctx, 'helmraiser-run').holds;
    expect(blocking.map((hold) => hold.id).sort()).toEqual([project.id, global.id, machine.id].sort());
    expect(renderCheck(blocking)).toContain(`- [${project.id}] Tunnel open — release: tunnel closed — blocks: helmraiser-run, deploy\n`);
    expect(check(ctx, 'deploy').holds.map((hold) => hold.id)).toEqual([project.id]);
  });

  it('ignores released holds and holds whose until has passed', () => {
    const { ctx } = world('2026-11-03T12:00:00Z');
    const released = createEntry(ctx, { kind: 'hold', title: 'Released', release: 'r', blocks: ['t'] });
    createEntry(ctx, { kind: 'hold', title: 'Expired', release: 'r', blocks: ['t'], until: '2026-11-02' });
    const today = createEntry(ctx, { kind: 'hold', title: 'Ends today', release: 'r', blocks: ['t'], until: '2026-11-03' });
    releaseHold(ctx, released.id);

    expect(check(ctx, 't').holds.map((hold) => hold.id)).toEqual([today.id]);
  });

  it('only looks at scopes in play: another project is not consulted, and outside git only global and machine are', () => {
    const { ctx, home } = world();
    createEntry(ctx, { kind: 'hold', title: 'Beta only', release: 'r', blocks: ['t'], scope: 'project:beta' });
    const mine = createEntry(ctx, { kind: 'hold', title: 'Alpha', release: 'r', blocks: ['t'] });
    const global = createEntry(ctx, { kind: 'hold', title: 'Global', release: 'r', blocks: ['t'], scope: 'global' });

    expect(check(ctx, 't').holds.map((hold) => hold.id).sort()).toEqual([mine.id, global.id].sort());
    const outside = { ...ctx, home, cwd: tempDir('lb-plain-') };
    expect(check(outside, 't').holds.map((hold) => hold.id)).toEqual([global.id]);
  });

  it('reports the project it was asked in, and records nothing', () => {
    const { ctx, home } = world();
    expect(check(ctx, 'deploy')).toEqual({ project: 'alpha', holds: [], unreadable: [] });
    expect(existsSync(join(home, 'state'))).toBe(false);
  });

  it.each(['global', 'machine', 'project:alpha'])('fails closed for malformed hold filenames in %s', async (scope) => {
    const { ctx, home, repo } = world();
    mkdirSync(scopeDir(home, scope), { recursive: true });
    const path = join(scopeDir(home, scope), 'hold-broken.md');
    writeFileSync(path, 'no frontmatter');
    const result = check(ctx, 'any-tag');
    expect(result.unreadable).toEqual([{ path, scope, error: expect.stringMatching(/frontmatter/) }]);
    expect(existsSync(join(home, 'state'))).toBe(false);
    const cli = await lb(home, ['check', '--blocks', 'push'], { cwd: repo });
    expect(cli.code).toBe(3);
    expect(cli.err).toBe('');
    expect(cli.out).toContain(`${path} — could not be parsed:`);
    expect(cli.out).toContain('fix or remove this file');
    writeEntry(home, sampleEntry({ id: 'hold-broken', kind: 'hold', scope, blocks: ['push'] }));
    expect(check(ctx, 'push').unreadable).toEqual([]);
    expect(check(ctx, 'push').holds).toHaveLength(1);
    rmSync(path);
    expect(check(ctx, 'push').holds).toEqual([]);
  });

  it('ignores other-project hold failures and non-holds, including outside registered projects', async () => {
    const { ctx, home, repo } = world();
    for (const scope of ['project:beta', 'project:alpha', 'global']) {
      mkdirSync(scopeDir(home, scope), { recursive: true });
      writeFileSync(join(scopeDir(home, scope), scope === 'global' ? 'rule-broken.md' : 'hold-broken.md'), 'broken');
    }
    expect(check(ctx, 'push').unreadable.map((file) => file.scope)).toEqual(['project:alpha']);
    const outside = tempDir();
    expect(check({ ...ctx, cwd: outside }, 'push').unreadable).toEqual([]);
    rmSync(join(scopeDir(home, 'project:alpha'), 'hold-broken.md'));
    expect(await lb(home, ['check', '--blocks', 'push'], { cwd: repo })).toEqual({ code: 0, out: '', err: '' });
  });

  it('renders ordinary holds alongside single-line unreadable diagnostics', () => {
    const { ctx, home } = world();
    const hold = createEntry(ctx, { kind: 'hold', title: 'Freeze', release: 'told', blocks: ['push'] });
    const path = join(scopeDir(home, 'project:alpha'), 'hold-broken.md');
    writeFileSync(path, '---\ntitle: [\n---\n');
    const result = check(ctx, 'push');
    expect(result.unreadable[0]!.error).toContain('\n');
    const text = renderCheck(result.holds, result.unreadable);
    expect(text).toContain(`[${hold.id}] Freeze`);
    expect(text.trim().split('\n')).toHaveLength(2);
  });

  it('keeps JSON an array, appending hold-shaped unreadable files after real holds', async () => {
    const { ctx, home, repo } = world();
    const run = () => lb(home, ['check', '--blocks', 'push', '--json'], { cwd: repo });
    const clear = await run();
    expect(clear.code).toBe(0);
    expect(JSON.parse(clear.out)).toEqual([]);
    const hold = createEntry(ctx, { kind: 'hold', title: 'Freeze', release: 'told', blocks: ['push'] });
    const ordinary = await run();
    expect(ordinary.code).toBe(3);
    expect(JSON.parse(ordinary.out)).toEqual([expect.objectContaining({ id: hold.id, title: 'Freeze', release: 'told' })]);
    const paths = ['hold-broken.md', 'hold-yaml.md'].map((file) => join(scopeDir(home, 'project:alpha'), file));
    writeFileSync(paths[0]!, 'no frontmatter');
    writeFileSync(paths[1]!, '---\ntitle: [\n---\n');
    const blocked = await run();
    expect(blocked.code).toBe(3);
    expect(blocked.err).toBe('');
    const items = JSON.parse(blocked.out);
    expect(Array.isArray(items)).toBe(true);
    expect(items).toEqual([
      JSON.parse(ordinary.out)[0],
      { id: 'hold-broken', kind: 'hold', title: `Unreadable hold file: ${paths[0]} — could not be parsed: entry has no frontmatter`, release: 'fix or remove this file', unreadable: true },
      { id: 'hold-yaml', kind: 'hold', title: expect.stringContaining(`Unreadable hold file: ${paths[1]} — could not be parsed: `), release: 'fix or remove this file', unreadable: true },
    ]);
    expect(items[2].title).not.toMatch(/[\r\n\t]| {2}/);
    expect(items[0]).not.toHaveProperty('unreadable');
  });

  it('needs a tag', () => {
    const { ctx } = world();
    try {
      check(ctx, ' ');
      throw new Error('expected a rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(LeeboardError);
      expect((error as LeeboardError).exitCode).toBe(EXIT.USAGE);
    }
  });
});
