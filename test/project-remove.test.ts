import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EXIT } from '../src/errors.js';
import { lb, type LbResult, tempDir } from './helpers.js';

const me = { LEEBOARD_HARNESS: 'claude-code', LEEBOARD_SESSION: 'remover' };

function idOf(result: LbResult): string {
  const id = /\[([a-z]+-[^\]]+)\]/.exec(result.out)?.[1];
  if (!id) throw new Error(`no id in output: ${result.out}${result.err}`);
  return id;
}

async function store() {
  const home = tempDir('lb-home-');
  await lb(home, ['project', 'add', 'old', '--path', '/work/old', '--path', '/gone/old-worktree']);
  await lb(home, ['project', 'add', 'other', '--path', '/work/other']);
  return home;
}

describe('lb project remove', () => {
  it('removes a project with no entries left', async () => {
    const home = await store();
    expect(await lb(home, ['project', 'remove', 'old'], { env: me })).toEqual({ code: 0, err: '', out: 'removed project old\n' });
    expect(existsSync(join(home, 'projects', 'old'))).toBe(false);
    expect((await lb(home, ['project', 'list'])).out).toBe('- other — paths: /work/other\n');
  });

  it('refuses while an entry of any status is scoped to it, until that entry is purged', async () => {
    const home = await store();
    const id = idOf(await lb(home, ['add', 'rule', '--title', 'Old rule', '--scope', 'project:old'], { env: me }));
    await lb(home, ['revoke', id, '--reason', 'done'], { env: me });
    const refused = await lb(home, ['project', 'remove', 'old'], { env: me });
    expect(refused.code).toBe(EXIT.BAD_TRANSITION);
    expect(refused.err).toContain(id);
    expect(existsSync(join(home, 'projects', 'old', 'project.md'))).toBe(true);

    await lb(home, ['purge', id], { env: me });
    expect((await lb(home, ['project', 'remove', 'old'], { env: me })).code).toBe(0);
  });

  it('refuses while an active entry elsewhere is addressed to it', async () => {
    const home = await store();
    const id = idOf(await lb(home, ['request', '--title', 'Please look', '--to', 'project:old', '--scope', 'project:other'], { env: me }));
    const refused = await lb(home, ['project', 'remove', 'old'], { env: me });
    expect(refused.code).toBe(EXIT.BAD_TRANSITION);
    expect(refused.err).toContain(id);
    await lb(home, ['close', id], { env: me });
    expect((await lb(home, ['project', 'remove', 'old'], { env: me })).code).toBe(0);
  });

  it('drops only the given paths with --path', async () => {
    const home = await store();
    const result = await lb(home, ['project', 'remove', 'old', '--path', '/gone/old-worktree'], { env: me });
    expect(result).toEqual({ code: 0, err: '', out: 'dropped 1 path(s)\n- old — paths: /work/old\n' });
    expect(readFileSync(join(home, 'projects', 'old', 'project.md'), 'utf8')).toContain('paths: [/work/old]');
  });

  it('rejects an unknown path, the last path, an unknown project and a missing name', async () => {
    const home = await store();
    for (const args of [
      ['project', 'remove', 'old', '--path', '/nowhere'],
      ['project', 'remove', 'other', '--path', '/work/other'],
      ['project', 'remove', 'nope'],
      ['project', 'remove'],
    ]) {
      expect((await lb(home, args, { env: me })).code).toBe(EXIT.USAGE);
    }
    expect((await lb(home, ['project', 'list'])).out).toContain('/work/other');
  });

  it('is not permitted to Bosun or Helmraiser', async () => {
    const home = await store();
    for (const harness of ['bosun', 'helmraiser']) {
      const result = await lb(home, ['project', 'remove', 'old'], { env: { LEEBOARD_HARNESS: harness, LEEBOARD_SESSION: 'run-1' } });
      expect(result.code).toBe(EXIT.NOT_PERMITTED);
    }
    expect(existsSync(join(home, 'projects', 'old'))).toBe(true);
  });
});
