import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createEntry } from '../src/change.js';
import type { Ctx } from '../src/context.js';
import { parseEntry } from '../src/entry.js';
import { EXIT, LeeboardError } from '../src/errors.js';
import { readLogSince } from '../src/log.js';
import { addProject } from '../src/projects.js';
import { makeRepo, tempDir } from './helpers.js';

const NOW = new Date('2026-10-17T14:02:11Z');

function makeCtx(overrides: Partial<Ctx> = {}): Ctx {
  return {
    home: tempDir(),
    now: NOW,
    cwd: tempDir('lb-cwd-'),
    identity: { harness: 'claude-code', session: 'A', origin: 'agent-inferred' },
    ...overrides,
  };
}

function failure(fn: () => unknown): LeeboardError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(LeeboardError);
    return error as LeeboardError;
  }
  throw new Error('expected a LeeboardError');
}

describe.each(['helmraiser'] as const)('createEntry as a %s worker', (harness) => {
  const runner = { harness, session: 'run-1', origin: 'agent-inferred' } as const;

  it.each([
    ['a hold', { kind: 'hold', title: 'No runs', release: 'later', blocks: ['helmraiser-run'] }],
    ['a grant', { kind: 'grant', title: 'Run owns merges', holder: 'run-1' }],
  ])('refuses %s with the not-permitted exit code, writing nothing', (_name, input) => {
    const ctx = makeCtx({ identity: { ...runner } });
    const error = failure(() => createEntry(ctx, input as never));
    expect(error.exitCode).toBe(EXIT.NOT_PERMITTED);
    expect(error.message).toMatch(/\(Helmraiser\)/);
    expect(existsSync(join(ctx.home, 'log.jsonl'))).toBe(false);
    expect(existsSync(join(ctx.home, 'global'))).toBe(false);
  });

  it.each([
    ['a rule', { kind: 'rule', title: 'Use pipefail' }],
    ['a reference', { kind: 'reference', title: 'CI runner lives here' }],
    ['a handoff', { kind: 'handoff', title: 'Review branch X', to: 'any' }],
    ['a request', { kind: 'request', title: 'Which base?', to: 'harness:claude-code' }],
  ])('still writes %s', (_name, input) => {
    const ctx = makeCtx({ identity: { ...runner } });
    expect(createEntry(ctx, input as never).author.harness).toBe(harness);
  });

  it('lets every other harness create holds and grants', () => {
    for (const harness of ['claude-code', 'pi', 'funkyoctopus', 'bosun', 'user', null] as const) {
      const ctx = makeCtx({ identity: { harness, session: 's', origin: 'user-stated' } });
      expect(createEntry(ctx, { kind: 'hold', title: 'h', release: 'r' }).kind).toBe('hold');
      expect(createEntry(ctx, { kind: 'grant', title: 'g', holder: 'x' }).kind).toBe('grant');
    }
  });
});

describe('createEntry', () => {
  it('checks raw credentials before kind, shape and permission errors without echoing them', () => {
    const secret = 'ghp_' + 'a1b2c3d4e5'.repeat(3);
    for (const kind of ['unknown', 'hold']) {
      const ctx = makeCtx({ identity: { harness: 'helmraiser', session: 'run', origin: 'agent-inferred' } });
      const error = failure(() => createEntry(ctx, { kind, title: '', scope: secret }));
      expect(error.exitCode).toBe(EXIT.CREDENTIAL);
      expect(error.message).toContain('scope');
      expect(error.message).not.toContain(secret);
      expect(readdirSync(ctx.home)).toEqual([]);
    }
    expect(failure(() => createEntry(makeCtx(), { kind: secret, title: 't' })).exitCode).toBe(EXIT.CREDENTIAL);
  });

  it.each(['2026-11-03', '2024-02-29', '2026-11-03T12:34:56Z', '2026-11-03T12:34:56.123+02:00'])(
    'accepts ISO date %s', (until) => {
      expect(createEntry(makeCtx(), { kind: 'rule', title: 't', until }).until).toBe(until);
    },
  );

  it.each(['November 3, 2026', '2026-02-29', '2026-04-31', '2026-11-03T12:34:56', '9999-99-99'])(
    'rejects non-ISO or invalid date %s', (until) => {
      const ctx = makeCtx();
      expect(failure(() => createEntry(ctx, { kind: 'rule', title: 't', until })).exitCode).toBe(EXIT.USAGE);
      expect(readdirSync(ctx.home)).toEqual([]);
    },
  );
  it('writes a hold into the resolved project, with author, timestamps and a log line', () => {
    const home = tempDir();
    const repo = makeRepo();
    addProject(home, { name: 'alpha', paths: [repo] });
    const ctx = makeCtx({ home, cwd: repo });

    const entry = createEntry(ctx, {
      kind: 'hold',
      title: 'No Helmraiser runs while the tunnel is open',
      release: 'Tunnel closed, or the owner says so',
      blocks: ['helmraiser-run'],
      until: '2026-11-03',
      body: 'Prod ops and runs share the tunnel.',
    });

    expect(entry).toMatchObject({
      kind: 'hold',
      scope: 'project:alpha',
      status: 'active',
      title: 'No Helmraiser runs while the tunnel is open',
      author: { harness: 'claude-code', session: 'A', origin: 'agent-inferred' },
      created: '2026-10-17T14:02:11Z',
      updated: '2026-10-17T14:02:11Z',
      until: '2026-11-03',
      release: 'Tunnel closed, or the owner says so',
      blocks: ['helmraiser-run'],
      body: 'Prod ops and runs share the tunnel.\n',
    });
    expect(entry.id).toMatch(/^hold-no-helmraiser-runs-while-the-tunnel-is-o-[0-9a-f]{4}$/);

    const dir = join(home, 'projects', 'alpha', 'entries');
    expect(readdirSync(dir)).toEqual([`${entry.id}.md`]);
    expect(parseEntry(readFileSync(join(dir, `${entry.id}.md`), 'utf8'))).toEqual(entry);

    expect(readLogSince(home, 0).lines).toEqual([
      {
        ts: '2026-10-17T14:02:11Z',
        id: entry.id,
        kind: 'hold',
        scope: 'project:alpha',
        event: 'created',
        status: 'active',
        harness: 'claude-code',
        session: 'A',
      },
    ]);
  });

  it('defaults to global outside a registered project, and --scope overrides', () => {
    const ctx = makeCtx();
    expect(createEntry(ctx, { kind: 'rule', title: 'Use pipefail' }).scope).toBe('global');
    expect(createEntry(ctx, { kind: 'rule', title: 'Laptop only', scope: 'machine' }).scope).toBe('machine');
    expect(existsSync(join(ctx.home, 'machine', 'entries'))).toBe(true);
    expect(createEntry(ctx, { kind: 'rule', title: 'Elsewhere', scope: 'project:beta' }).scope).toBe('project:beta');
  });

  it('records an anonymous author as nulls', () => {
    const ctx = makeCtx({ identity: { harness: null, session: null, origin: 'user-stated' } });
    const entry = createEntry(ctx, { kind: 'reference', title: 'Where the logs are' });
    expect(entry.author).toEqual({ harness: null, session: null, origin: 'user-stated' });
    expect(readLogSince(ctx.home, 0).lines[0]).toMatchObject({ harness: null, session: null });
  });

  it('normalises the title to one line and the body to end with a newline', () => {
    const entry = createEntry(makeCtx(), { kind: 'rule', title: '  Two\nlines   here ', body: 'text\n\n\n' });
    expect(entry.title).toBe('Two lines here');
    expect(entry.body).toBe('text\n');
    expect(createEntry(makeCtx(), { kind: 'rule', title: 'No body' }).body).toBe('');
  });

  it('keeps the kind-specific fields: grant holder, handoff and request target', () => {
    const ctx = makeCtx();
    expect(createEntry(ctx, { kind: 'grant', title: 'Api merges', holder: 'api-93' }).holder).toBe('api-93');
    expect(createEntry(ctx, { kind: 'handoff', title: 'Continue X', to: 'project:api' }).to).toBe('project:api');
    expect(createEntry(ctx, { kind: 'request', title: 'Review Y', to: 'harness:pi' }).to).toBe('harness:pi');
    expect(createEntry(ctx, { kind: 'request', title: 'Anyone', to: 'any' }).to).toBe('any');
    expect(createEntry(ctx, { kind: 'handoff', title: 'To one session', to: 'session:abc-1' }).to).toBe('session:abc-1');
  });

  it.each([
    ['a hold without a release condition', { kind: 'hold', title: 't' }, /release/],
    ['a grant without a holder', { kind: 'grant', title: 't' }, /holder/],
    ['a handoff without a target', { kind: 'handoff', title: 't' }, /--to/],
    ['a request without a target', { kind: 'request', title: 't' }, /--to/],
    ['a target that is not project:/session:/harness:/any', { kind: 'handoff', title: 't', to: 'api' }, /--to/],
    ['an unknown harness target', { kind: 'handoff', title: 't', to: 'harness:emacs' }, /--to/],
    ['an unreadable until', { kind: 'hold', title: 't', release: 'r', until: 'soon' }, /until/],
    ['an unknown kind', { kind: 'note', title: 't' }, /kind/],
    ['an empty title', { kind: 'rule', title: '  \n ' }, /title/],
    ['a malformed scope', { kind: 'rule', title: 't', scope: 'project:../x' }, /scope/],
  ])('refuses %s with the usage exit code, writing nothing', (_name, input, message) => {
    const ctx = makeCtx();
    const error = failure(() => createEntry(ctx, input as never));
    expect(error.exitCode).toBe(EXIT.USAGE);
    expect(error.message).toMatch(message);
    expect(existsSync(join(ctx.home, 'log.jsonl'))).toBe(false);
    expect(existsSync(join(ctx.home, 'global'))).toBe(false);
  });

  it.each([
    ['scope', { kind: 'rule', title: 'ok', scope: 'ghp_' + 'a1b2c3d4e5'.repeat(3) }],
    ['title', { kind: 'rule', title: 'key ghp_' + 'a1b2c3d4e5'.repeat(3) }],
    ['body', { kind: 'rule', title: 'ok', body: 'psql postgres://admin:hunter2pass@db.example.test/app' }],
    ['release', { kind: 'hold', title: 'ok', release: 'when Bearer abcdefghijklmnop12345 is rotated' }],
    ['holder', { kind: 'grant', title: 'ok', holder: 'ghp_' + 'a1b2c3d4e5'.repeat(3) }],
    ['to', { kind: 'handoff', title: 'ok', to: 'session:ghp_' + 'a1b2c3d4e5'.repeat(3) }],
    ['blocks', { kind: 'hold', title: 'ok', release: 'r', blocks: ['deploy', 'sk-' + 'abcDEF0123456789'.repeat(2)] }],
    // Not an ISO date either: the credential is reported, not the shape.
    ['until', { kind: 'hold', title: 'ok', release: 'r', until: 'ghp_' + 'a1b2c3d4e5'.repeat(3) }],
  ])('rejects a credential in the %s with exit 2 and persists nothing', (field, input) => {
    const ctx = makeCtx();
    const error = failure(() => createEntry(ctx, input as never));
    expect(error.exitCode).toBe(EXIT.CREDENTIAL);
    expect(error.message).toContain(field);
    expect(existsSync(join(ctx.home, 'log.jsonl'))).toBe(false);
    expect(existsSync(join(ctx.home, 'global'))).toBe(false);
  });
});
