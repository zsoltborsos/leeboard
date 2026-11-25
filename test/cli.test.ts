import { beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CLI, lb, type LbResult, makeRepo, requireBuild, sampleEntry, tempDir } from './helpers.js';
import { initStore, scopeDir, writeEntry } from '../src/store.js';
import { perfExclude } from '../vitest.config.js';

const sessionA = { LEEBOARD_SESSION: 'A', LEEBOARD_HARNESS: 'claude-code' };
const sessionB = { LEEBOARD_SESSION: 'B', LEEBOARD_HARNESS: 'pi' };

function idOf(result: LbResult): string {
  const id = /\[([a-z]+-[^\]]+)\]/.exec(result.out)?.[1];
  if (!id) throw new Error(`no id in output: ${result.out}`);
  return id;
}

/** A store with project P registered at a real git repository. */
async function projectWorld() {
  const home = tempDir('lb-home-');
  const repo = makeRepo();
  expect((await lb(home, ['project', 'add', 'P', '--path', repo])).code).toBe(0);
  return { home, repo };
}

describe('performance test opt-in', () => {
  it('excludes the wall-clock perf file unless LEEBOARD_PERF=1', () => {
    expect(perfExclude({})).toEqual(['test/perf.test.ts']);
    expect(perfExclude({ LEEBOARD_PERF: '0' })).toEqual(['test/perf.test.ts']);
    expect(perfExclude({ LEEBOARD_PERF: 'true' })).toEqual(['test/perf.test.ts']);
    expect(perfExclude({ LEEBOARD_PERF: '1' })).toEqual([]);
  });
});

describe('acceptance: two sessions sharing one store', () => {
  it('sees each other\'s holds through delta, and check follows the hold', async () => {
    const { home, repo } = await projectWorld();
    const run = (env: Record<string, string>, ...args: string[]) => lb(home, args, { env, cwd: repo });

    expect((await run(sessionA, 'brief')).code).toBe(0);

    // A places a helmraiser-run hold in project P.
    const placed = await run(sessionA, 'hold', '--title', 'No Helmraiser runs while the tunnel is open', '--release', 'tunnel closed', '--blocks', 'helmraiser-run');
    expect(placed.code).toBe(0);
    const holdId = idOf(placed);

    // B's brief lists it; B's next delta is empty.
    const briefB = await run(sessionB, 'brief');
    expect(briefB.code).toBe(0);
    expect(briefB.out).toContain('# Leeboard: project P');
    expect(briefB.out).toContain(`## Holds\n- [${holdId}] No Helmraiser runs while the tunnel is open — release: tunnel closed — blocks: helmraiser-run`);
    expect(await run(sessionB, 'delta')).toEqual({ code: 0, out: '', err: '' });

    // A adds a rule: B's delta shows it, A's own delta does not.
    const rule = await run(sessionA, 'add', 'rule', '--title', 'Use pipefail before commit', '--body', 'tail returns its own status');
    expect(rule.code).toBe(0);
    expect(await run(sessionB, 'delta')).toEqual({ code: 0, out: `- [${idOf(rule)}] rule created: Use pipefail before commit\n`, err: '' });
    expect(await run(sessionA, 'delta')).toEqual({ code: 0, out: '', err: '' });

    // The hold blocks helmraiser-run: exit 3 and the hold is printed.
    const blocked = await run(sessionB, 'check', '--blocks', 'helmraiser-run');
    expect(blocked.code).toBe(3);
    expect(blocked.out).toContain(`[${holdId}] No Helmraiser runs while the tunnel is open`);
    expect(await run(sessionB, 'check', '--blocks', 'something-else')).toEqual({ code: 0, out: '', err: '' });

    // A releases it: B's delta shows the release, and check passes.
    expect((await run(sessionA, 'release', holdId.slice(0, 14))).code).toBe(0);
    expect((await run(sessionB, 'delta')).out).toBe(`- [${holdId}] hold released: No Helmraiser runs while the tunnel is open — release: tunnel closed\n`);
    expect(await run(sessionB, 'check', '--blocks', 'helmraiser-run')).toEqual({ code: 0, out: '', err: '' });
  });

  it('delivers a handoff to a pi session until it is acknowledged', async () => {
    const { home, repo } = await projectWorld();
    const run = (env: Record<string, string>, ...args: string[]) => lb(home, args, { env, cwd: repo });

    const handoff = await run(sessionA, 'handoff', '--title', 'Continue the Expo 55 step', '--to', 'harness:pi', '--body', 'Branch X, tests red in Y.');
    expect(handoff.code).toBe(0);
    const id = idOf(handoff);

    expect((await run(sessionB, 'brief')).out).toContain(`## Inbox\n- [${id}] handoff to harness:pi: Continue the Expo 55 step`);
    expect((await run(sessionA, 'brief')).out).not.toContain('## Inbox');

    expect((await run(sessionB, 'ack', id)).code).toBe(0);
    expect((await run(sessionB, 'brief')).out).not.toContain('Inbox');
  });
});

describe('exit codes and errors', () => {
  it.each([
    ['--version'],
    ['-v'],
    ['init', '--version'],
    ['-v', 'init'],
    ['frobnicate', '--version'],
    ['--version', '--json'],
  ])('prints the package version without accessing the store: %j', async (...args) => {
    const { version } = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { version: string };
    const home = join(tempDir('lb-parent-'), 'store');
    expect(await lb(home, args)).toEqual({ code: 0, out: `${version}\n`, err: '' });
    expect(existsSync(home)).toBe(false);
  });

  it('preserves help precedence over version', async () => {
    const home = join(tempDir('lb-parent-'), 'store');
    expect(await lb(home, ['--help', '--version'])).toEqual(await lb(home, ['--help']));
  });

  it('2 for credential-like text: names the field, never echoes the value, writes nothing', async () => {
    const home = tempDir('lb-home-');
    const secret = 'ghp_' + 'a1b2c3d4e5'.repeat(3);
    const result = await lb(home, ['add', 'rule', '--title', 'Harmless', '--body', `token ${secret}`]);
    expect(result.code).toBe(2);
    expect(result.err).toContain('body');
    expect(result.err).not.toContain(secret);
    expect(result.out).not.toContain(secret);
    expect(await lb(home, ['list'])).toEqual({ code: 0, out: '', err: '' });
  });

  it('4 for an unknown id and for an ambiguous prefix, listing the candidates on stderr', async () => {
    const home = tempDir('lb-home-');
    const one = idOf(await lb(home, ['hold', '--title', 'No runs', '--release', 'r']));
    const two = idOf(await lb(home, ['hold', '--title', 'No pushes', '--release', 'r']));
    expect((await lb(home, ['release', 'hold-zzz'])).code).toBe(4);
    const ambiguous = await lb(home, ['show', 'hold-no-']);
    expect(ambiguous.code).toBe(4);
    expect(ambiguous.err).toContain(one);
    expect(ambiguous.err).toContain(two);
  });

  it('5 for a lifecycle command the entry does not allow', async () => {
    const home = tempDir('lb-home-');
    const rule = idOf(await lb(home, ['add', 'rule', '--title', 'A rule']));
    expect((await lb(home, ['release', rule])).code).toBe(5);
    expect((await lb(home, ['ack', rule])).code).toBe(5);
    expect((await lb(home, ['revoke', rule, '--reason', 'obsolete'])).code).toBe(0);
    expect((await lb(home, ['revoke', rule, '--reason', 'again'])).code).toBe(5);
  });

  it('1 for usage mistakes: missing title, unknown command or flag, a hold without --release', async () => {
    const home = tempDir('lb-home-');
    for (const args of [['add', 'rule'], ['frobnicate'], ['list', '--nonsense'], ['hold', '--title', 'x'], []]) {
      const result = await lb(home, args);
      expect(result.code, args.join(' ')).toBe(1);
      expect(result.err).toMatch(/^lb: /);
    }
  });

  it('prints usage for --help and exits 0, advertising the list filters and exit code 6', async () => {
    const result = await lb(tempDir('lb-home-'), ['--help']);
    expect(result.code).toBe(0);
    expect(result.out).toContain('lb brief');
    expect(result.out).toContain('--version');
    expect(result.out.split(/\s+/)).toContain('-v');
    expect(result.out).not.toContain('--alias');
    expect(result.out).toContain('[--session <id>]');
    expect(result.out).toContain('[--harness <name>]');
    expect(result.out).toContain('6 not permitted');
    expect(result.out).toContain('lb usage');
    expect(result.out).toContain('--since');
    expect(result.out).toContain('lb bosun [--quick] [--dry-run] [--json]');
    expect(result.out).toContain('lb review [--peek] [--json]');
  });
});

describe('commands', () => {
  it('init creates the layout in LEEBOARD_HOME and nothing under the real home', async () => {
    const home = join(tempDir('lb-parent-'), 'store');
    expect((await lb(home, ['init'])).code).toBe(0);
    expect(readdirSync(home).sort()).toEqual(['.gitignore', 'global', 'log.jsonl', 'machine', 'projects', 'state']);
    expect(existsSync(join(process.env.HOME!, '.leeboard'))).toBe(false);
  });

  it('init --json reports the store it initialised', async () => {
    const home = join(tempDir('lb-parent-'), 'store');
    expect(JSON.parse((await lb(home, ['init', '--json'])).out)).toEqual({ home });
  });

  it('writes to the project that resolves, and --scope overrides', async () => {
    const { home, repo } = await projectWorld();
    const inProject = await lb(home, ['add', 'rule', '--title', 'Project rule'], { cwd: repo });
    expect(inProject.out).toContain('project:P');
    const machine = await lb(home, ['add', 'rule', '--title', 'Machine rule', '--scope', 'machine'], { cwd: repo });
    expect(machine.out).toContain('machine');
    const elsewhere = await lb(home, ['add', 'rule', '--title', 'Global rule']);
    expect(elsewhere.out).toContain('global');
  });

  it('supports grant, request, reply, close and supersede', async () => {
    const home = tempDir('lb-home-');
    expect((await lb(home, ['grant', '--title', 'Api merges', '--holder', 'api-93'])).code).toBe(0);
    const request = idOf(await lb(home, ['request', '--title', 'Review Y', '--to', 'any']));
    expect((await lb(home, ['reply', request, '--body', 'Looks good'], { env: sessionB })).code).toBe(0);
    expect((await lb(home, ['show', request])).out).toContain('## Reply (');
    expect((await lb(home, ['close', request])).code).toBe(0);
    const old = idOf(await lb(home, ['add', 'rule', '--title', 'Old']));
    const next = idOf(await lb(home, ['add', 'rule', '--title', 'New']));
    expect((await lb(home, ['supersede', old, '--by', next])).code).toBe(0);
    expect((await lb(home, ['list', '--status', 'superseded'])).out).toContain(old);
    expect((await lb(home, ['show', next])).out).toContain(`supersedes: [${old}]`);
  });

  it('lists and searches', async () => {
    const home = tempDir('lb-home-');
    await lb(home, ['add', 'rule', '--title', 'Use pipefail', '--body', 'tail hides failures']);
    await lb(home, ['add', 'reference', '--title', 'Logs live here']);
    expect((await lb(home, ['list', '--kind', 'rule'])).out).toMatch(/^- \[rule-use-pipefail-[0-9a-f]{4}\] active global: Use pipefail\n$/);
    expect((await lb(home, ['search', 'HIDES'])).out).toContain('Use pipefail');
    expect((await lb(home, ['search', 'nothing like this'])).out).toBe('');
  });

  it('project add and list, with --json', async () => {
    const home = tempDir('lb-home-');
    expect((await lb(home, ['project', 'add', 'api', '--path', '/work/api', '--remote', 'git@github.com:acme/api.git'])).code).toBe(0);
    expect(JSON.parse((await lb(home, ['project', 'list', '--json'])).out)).toEqual([
      { name: 'api', paths: ['/work/api'], remotes: ['git@github.com:acme/api.git'] },
    ]);
    expect((await lb(home, ['project', 'list'])).out).toBe('- api — paths: /work/api — remotes: git@github.com:acme/api.git\n');
  });

  it('rejects --alias as an unknown option without registering a project', async () => {
    const home = tempDir('lb-home-');
    const result = await lb(home, ['project', 'add', 'demo', '--path', '/work/demo', '--alias', 'd']);
    expect(result.code).toBe(1);
    expect(result.out).toBe('');
    expect(result.err).toMatch(/^lb: Unknown option '--alias'/);
    expect(JSON.parse((await lb(home, ['project', 'list', '--json'])).out)).toEqual([]);
  });

  it('--json gives structured output for add, show, brief, delta and check', async () => {
    const home = tempDir('lb-home-');
    const added = JSON.parse((await lb(home, ['hold', '--title', 'No runs', '--release', 'r', '--blocks', 't', '--json'], { env: sessionA })).out);
    expect(added).toMatchObject({ kind: 'hold', scope: 'global', status: 'active', title: 'No runs', release: 'r', blocks: ['t'] });
    expect(JSON.parse((await lb(home, ['show', added.id, '--json'])).out)).toMatchObject({ id: added.id, body: '', author: { session: 'A' } });
    expect(JSON.parse((await lb(home, ['brief', '--json'], { env: sessionB })).out).holds[0].id).toBe(added.id);
    await lb(home, ['add', 'rule', '--title', 'Later'], { env: sessionA });
    expect(JSON.parse((await lb(home, ['delta', '--json'], { env: sessionB })).out)).toHaveLength(1);
    const blocked = await lb(home, ['check', '--blocks', 't', '--json']);
    expect(blocked.code).toBe(3);
    expect(JSON.parse(blocked.out)[0].id).toBe(added.id);
  });

  it('--cwd selects the directory for project resolution', async () => {
    const { home, repo } = await projectWorld();
    await lb(home, ['hold', '--title', 'In P', '--release', 'r', '--blocks', 't'], { cwd: repo });
    expect((await lb(home, ['check', '--blocks', 't'])).code).toBe(0);
    expect((await lb(home, ['check', '--blocks', 't', '--cwd', repo])).code).toBe(3);
  });

  it('filters list by author session and harness, combining with kind, scope and status', async () => {
    const home = tempDir('lb-home-');
    const runA = { LEEBOARD_HARNESS: 'helmraiser', LEEBOARD_SESSION: 'run-1' };
    const runB = { LEEBOARD_HARNESS: 'helmraiser', LEEBOARD_SESSION: 'run-2' };
    const piA = { LEEBOARD_HARNESS: 'pi', LEEBOARD_SESSION: 'run-1' };
    const aHold = idOf(await lb(home, ['request', '--title', 'A request', '--to', 'any'], { env: runA }));
    const bRule = idOf(await lb(home, ['add', 'rule', '--title', 'B rule', '--scope', 'machine'], { env: runB }));
    const piRef = idOf(await lb(home, ['add', 'reference', '--title', 'Pi ref'], { env: piA }));
    const anon = idOf(await lb(home, ['add', 'rule', '--title', 'Anon']));

    const ids = async (env: Record<string, string> | undefined, ...args: string[]) =>
      (JSON.parse((await lb(home, ['list', '--json', ...args], { env })).out) as { id: string }[]).map((entry) => entry.id).sort();

    expect(await ids(undefined, '--session', 'run-1')).toEqual([aHold, piRef].sort());
    expect(await ids(undefined, '--harness', 'helmraiser')).toEqual([aHold, bRule].sort());
    expect(await ids(undefined, '--session', 'run-2', '--harness', 'helmraiser')).toEqual([bRule]);
    expect(await ids(undefined, '--session', 'run-1', '--kind', 'reference')).toEqual([piRef]);
    expect(await ids(undefined, '--harness', 'helmraiser', '--scope', 'machine', '--kind', 'rule', '--status', 'active')).toEqual([bRule]);

    // Unknown values match nothing; text listing is empty.
    expect(await ids(undefined, '--session', 'run-9')).toEqual([]);
    expect(await ids(undefined, '--harness', 'bosun')).toEqual([]);
    expect(await lb(home, ['list', '--session', 'run-9'])).toEqual({ code: 0, out: '', err: '' });

    // No author flags: the caller environment does not implicitly filter.
    expect(await ids(runA)).toEqual([aHold, bRule, piRef, anon].sort());
  });

  it('adds author, created and updated to list and search JSON, matching show, without a body', async () => {
    const home = tempDir('lb-home-');
    const env = { LEEBOARD_HARNESS: 'helmraiser', LEEBOARD_SESSION: 'run-7' };
    const added = JSON.parse((await lb(home, ['add', 'reference', '--title', 'A grant-like reference', '--json'], { env })).out);
    const shown = JSON.parse((await lb(home, ['show', added.id, '--json'])).out);
    const listed = JSON.parse((await lb(home, ['list', '--json', '--harness', 'helmraiser'])).out)[0];
    const searched = JSON.parse((await lb(home, ['search', 'grant', '--json'], { env })).out)[0];
    for (const summary of [listed, searched]) {
      expect(summary).toMatchObject({
        id: added.id,
        author: { harness: 'helmraiser', session: 'run-7', origin: 'agent-inferred' },
        created: shown.created,
        updated: shown.updated,
      });
      expect(summary).not.toHaveProperty('body');
    }
  });
});

describe.each(['helmraiser'])('%s permission guards through the CLI', (harness) => {
  const run = { LEEBOARD_HARNESS: harness, LEEBOARD_SESSION: 'run-42' };

  /** The raw bytes of the named global entry files plus `log.jsonl`. */
  function bytes(home: string, ids: string[]): string {
    const files = ids.map((id) => readFileSync(join(home, 'global', 'entries', `${id}.md`), 'utf8'));
    return JSON.stringify([files, readFileSync(join(home, 'log.jsonl'), 'utf8')]);
  }

  /** Assert a refusal: exit 6, empty stdout, one stderr line, and no writes. */
  async function rejects(home: string, args: string[], ids: string[], env: Record<string, string> = run): Promise<LbResult> {
    const before = bytes(home, ids);
    const result = await lb(home, args, { env });
    expect(result.code, args.join(' ')).toBe(6);
    expect(result.out).toBe('');
    expect(result.err.trimEnd().split('\n')).toHaveLength(1);
    expect(result.err).toMatch(/owner|interactive session/);
    expect(bytes(home, ids)).toBe(before);
    return result;
  }

  it('refuses release and revoke of a protected hold or grant, writing nothing', async () => {
    const home = tempDir('lb-home-');
    const hold = idOf(await lb(home, ['hold', '--title', 'No runs', '--release', 'r', '--blocks', 'helmraiser-run'], { env: sessionA }));
    const grant = idOf(await lb(home, ['grant', '--title', 'A grant', '--holder', 'x'], { env: sessionA }));
    for (const id of [hold, grant]) {
      expect((await rejects(home, ['release', id], [hold, grant])).err).toContain(id);
      expect((await rejects(home, ['revoke', id, '--reason', 'why'], [hold, grant])).err).toContain(id);
    }
  });

  it('refuses supersede of a protected hold or grant, writing neither entry', async () => {
    const home = tempDir('lb-home-');
    const hold = idOf(await lb(home, ['hold', '--title', 'No runs', '--release', 'r'], { env: sessionA }));
    const grant = idOf(await lb(home, ['grant', '--title', 'A grant', '--holder', 'x'], { env: sessionA }));
    const replacement = idOf(await lb(home, ['add', 'rule', '--title', 'Replacement'], { env: sessionA }));
    for (const id of [hold, grant]) {
      expect((await rejects(home, ['supersede', id, '--by', replacement], [hold, grant, replacement])).err).toContain(id);
    }
  });

  it("lets a worker retract its own entries but not another session's", async () => {
    const home = tempDir('lb-home-');
    const own = idOf(await lb(home, ['add', 'rule', '--title', 'Own rule'], { env: run }));
    const foreign = idOf(await lb(home, ['add', 'rule', '--title', 'Foreign rule'], { env: { LEEBOARD_HARNESS: harness, LEEBOARD_SESSION: 'run-99' } }));
    expect((await lb(home, ['revoke', foreign, '--reason', 'nope'], { env: run })).code).toBe(6);
    expect((await lb(home, ['revoke', own, '--reason', 'done'], { env: run })).code).toBe(0);

    const old = idOf(await lb(home, ['add', 'reference', '--title', 'Own ref'], { env: run }));
    const replacement = idOf(await lb(home, ['add', 'rule', '--title', 'Replacement'], { env: run }));
    expect((await lb(home, ['supersede', old, '--by', replacement], { env: run })).code).toBe(0);

    // An explicit --session flag overrides the environment.
    const flagOwn = idOf(await lb(home, ['add', 'rule', '--title', 'Flag own'], { env: run }));
    expect((await lb(home, ['revoke', flagOwn, '--reason', 'x', '--session', 'run-99'], { env: run })).code).toBe(6);
    expect((await lb(home, ['revoke', flagOwn, '--reason', 'x', '--session', 'run-42'], { env: { LEEBOARD_HARNESS: harness, LEEBOARD_SESSION: 'run-99' } })).code).toBe(0);
  });

  it('uses the resolved harness, not the environment, for the guard', async () => {
    const home = tempDir('lb-home-');
    const first = idOf(await lb(home, ['hold', '--title', 'First hold', '--release', 'r'], { env: sessionA }));
    const second = idOf(await lb(home, ['hold', '--title', 'Second hold', '--release', 'r'], { env: sessionA }));
    // A runner --harness flag under a Pi environment triggers the guard.
    expect((await lb(home, ['release', first, '--harness', harness], { env: sessionB })).code).toBe(6);
    // An explicit --harness pi under a runner environment keeps Pi behaviour.
    expect((await lb(home, ['release', second, '--harness', 'pi'], { env: run })).code).toBe(0);
  });

  it('refuses holds and grants from Helmraiser workers but leaves other creation, ack, reply and close available', async () => {
    const home = tempDir('lb-home-');
    expect((await lb(home, ['hold', '--title', 'Worker hold', '--release', 'r'], { env: run })).code).toBe(6);
    expect((await lb(home, ['grant', '--title', 'Worker grant', '--holder', 'x'], { env: run })).code).toBe(6);
    expect((await lb(home, ['add', 'rule', '--title', 'Worker rule'], { env: run })).code).toBe(0);
    expect((await lb(home, ['request', '--title', 'Worker question', '--to', 'any'], { env: run })).code).toBe(0);
    const handoff = idOf(await lb(home, ['handoff', '--title', 'Continue', '--to', 'any'], { env: sessionA }));
    expect((await lb(home, ['ack', handoff], { env: run })).code).toBe(0);
    const request = idOf(await lb(home, ['request', '--title', 'Review', '--to', 'any'], { env: sessionA }));
    expect((await lb(home, ['reply', request, '--body', 'ok'], { env: run })).code).toBe(0);
    expect((await lb(home, ['close', request], { env: run })).code).toBe(0);
  });

  it('cannot lift the hold that gates Helmraiser runs, while an interactive session still can', async () => {
    const home = tempDir('lb-home-');
    const hold = idOf(await lb(home, ['hold', '--title', 'No Helmraiser runs', '--release', 'tunnel closed', '--blocks', 'helmraiser-run'], { env: sessionA }));
    expect((await lb(home, ['release', hold], { env: run })).code).toBe(6);
    const blocked = await lb(home, ['check', '--blocks', 'helmraiser-run', '--json']);
    expect(blocked.code).toBe(3);
    expect(JSON.parse(blocked.out)[0].id).toBe(hold);
    expect((await lb(home, ['release', hold], { env: sessionA })).code).toBe(0);
    expect(await lb(home, ['check', '--blocks', 'helmraiser-run'])).toEqual({ code: 0, out: '', err: '' });
  });
});

describe('lb review', () => {
  it('shows text and matching JSON with --peek, acknowledges by default, then prints nothing', async () => {
    const home = tempDir('lb-home-');
    const actor = { LEEBOARD_HARNESS: 'claude-code', LEEBOARD_SESSION: 'abcdefgh-12345678' };
    const id = idOf(await lb(home, ['add', 'rule', '--title', 'New rule', '--origin', 'user-stated'], { env: actor }));
    const peek = await lb(home, ['review', '--peek']);
    expect(peek).toEqual({ code: 0, out: `## New\n- [${id}] rule global: New rule (claude-code/abcdefgh, user-stated)\n`, err: '' });
    expect(existsSync(join(home, 'state', 'review.json'))).toBe(false);
    const jsonPeek = await lb(home, ['review', '--peek', '--json']);
    expect(jsonPeek.code).toBe(0);
    expect(JSON.parse(jsonPeek.out)).toEqual({ new: [{
      id, kind: 'rule', scope: 'global', title: 'New rule', status: 'active',
      harness: 'claude-code', session: 'abcdefgh-12345678', origin: 'user-stated',
    }], changed: [], closed: [] });
    expect(existsSync(join(home, 'state', 'review.json'))).toBe(false);
    expect(await lb(home, ['review', '--json'])).toEqual(jsonPeek);
    expect(await lb(home, ['review'])).toEqual({ code: 0, out: '', err: '' });
    expect(await lb(home, ['review', '--json'])).toEqual({ code: 0, out: '', err: '' });
  });

  it('groups later changes and closures, with brief and delta independent of owner review', async () => {
    const home = tempDir('lb-home-');
    const request = idOf(await lb(home, ['request', '--title', 'Review this', '--to', 'any'], { env: sessionA }));
    const hold = idOf(await lb(home, ['hold', '--title', 'Freeze', '--release', 'told'], { env: sessionA }));
    expect((await lb(home, ['review'])).code).toBe(0);
    expect((await lb(home, ['brief'], { env: sessionB })).code).toBe(0);
    expect((await lb(home, ['reply', request, '--body', 'Updated'], { env: sessionA })).code).toBe(0);
    expect((await lb(home, ['release', hold], { env: sessionA })).code).toBe(0);
    const rule = idOf(await lb(home, ['add', 'rule', '--title', 'New elsewhere', '--scope', 'project:other'], { env: sessionA }));
    const brief = await lb(home, ['brief'], { env: sessionB });
    expect(brief.out).toMatch(/Owner review: 1 new, 1 changed, 1 closed since the last review — run `lb review`\n$/);
    const data = JSON.parse((await lb(home, ['review', '--peek', '--json'])).out);
    expect(data.new.map((item: any) => item.id)).toEqual([rule]);
    expect(data.changed.map((item: any) => item.id)).toEqual([request]);
    expect(data.closed.map((item: any) => item.id)).toEqual([hold]);
    const text = await lb(home, ['review']);
    expect(text.code).toBe(0);
    expect(text.out.match(/^## .+$/gm)).toEqual(['## New', '## Changed', '## Closed']);
    expect((await lb(home, ['brief'], { env: sessionB })).out).not.toContain('Owner review:');
    expect(await lb(home, ['review'])).toEqual({ code: 0, out: '', err: '' });
  });

  it('prints nothing for an empty store, in text and JSON', async () => {
    const home = tempDir('lb-home-');
    expect(await lb(home, ['review', '--peek'])).toEqual({ code: 0, out: '', err: '' });
    expect(existsSync(join(home, 'state'))).toBe(false);
    expect(await lb(home, ['review', '--json'])).toEqual({ code: 0, out: '', err: '' });
  });
});

describe('unreadable entry CLI compatibility', () => {
  it('fails closed in text and JSON, preserves ordinary hold JSON, and clears after repair/removal', async () => {
    const { home, repo } = await projectWorld();
    initStore(home);
    const path = join(scopeDir(home, 'project:P'), 'hold-broken.md');
    mkdirSync(scopeDir(home, 'project:P'), { recursive: true });
    writeFileSync(path, 'broken');
    const run = (...args: string[]) => lb(home, args, { cwd: repo });
    const diagnostic = {
      id: 'hold-broken', kind: 'hold',
      title: `Unreadable hold file: ${path} — could not be parsed: entry has no frontmatter`,
      release: 'fix or remove this file', unreadable: true,
    };
    const text = await run('check', '--blocks', 'push');
    expect(text.code).toBe(3);
    expect(text.err).toBe('');
    expect(text.out).toContain(`${path} — could not be parsed:`);
    expect(text.out).toContain('fix or remove this file');
    const failed = await run('check', '--blocks', 'push', '--json');
    expect(failed.code).toBe(3);
    expect(JSON.parse(failed.out)).toEqual([diagnostic]);
    expect((await run('brief')).out).toMatch(/Unreadable entry files: 1 — run `lb bosun --quick` for details\n$/);
    expect(JSON.parse((await run('brief', '--json')).out).unreadableCount).toBe(1);

    const valid = sampleEntry({ id: 'hold-valid-0001', kind: 'hold', scope: 'project:P', title: 'Freeze', blocks: ['push'], release: 'told' });
    writeEntry(home, valid);
    const mixed = await run('check', '--blocks', 'push', '--json');
    expect(mixed.code).toBe(3);
    expect(JSON.parse(mixed.out)).toEqual([expect.objectContaining({ id: valid.id }), diagnostic]);
    writeEntry(home, sampleEntry({ id: 'hold-broken', kind: 'hold', scope: 'project:P', status: 'released' }));
    const repaired = await run('check', '--blocks', 'push', '--json');
    expect(repaired.code).toBe(3);
    expect(JSON.parse(repaired.out)).toEqual([expect.objectContaining({ id: valid.id })]);
    expect((await run('brief')).out).not.toContain('Unreadable entry files:');
    expect(JSON.parse((await run('bosun', '--quick', '--json')).out).unreadable).toEqual([]);
    rmSync(path);
    rmSync(join(scopeDir(home, 'project:P'), `${valid.id}.md`));
    writeFileSync(join(scopeDir(home, 'global'), 'rule-broken.md'), 'broken non-hold');
    const clear = await run('check', '--blocks', 'push', '--json');
    expect(clear.code).toBe(0);
    expect(clear.err).toBe('');
    expect(JSON.parse(clear.out)).toEqual([]);
    rmSync(join(scopeDir(home, 'global'), 'rule-broken.md'));
    expect(JSON.parse((await run('brief', '--json')).out).unreadableCount).toBe(0);
  });

  it('reports failures through default/quick/dry-run Bosun without changing file or log bytes', async () => {
    const home = tempDir('lb-home-');
    initStore(home);
    const path = join(scopeDir(home, 'global'), 'hold-broken.md');
    const content = '---\ntitle: [\n---\n';
    writeFileSync(path, content);
    const log = readFileSync(join(home, 'log.jsonl'), 'utf8');
    for (const flags of [[], ['--quick'], ['--quick', '--dry-run']]) {
      const text = await lb(home, ['bosun', ...flags]);
      expect(text.code).toBe(0);
      expect(text.out).toContain(`## Unreadable files\n- ${path} (global) — `);
      expect(text.out.trim().split('\n')).toHaveLength(2);
      const structured = await lb(home, ['bosun', ...flags, '--json']);
      expect(structured.code).toBe(0);
      expect(JSON.parse(structured.out).unreadable).toEqual([{ path, scope: 'global', error: expect.stringContaining('\n') }]);
    }
    expect(readFileSync(path, 'utf8')).toBe(content);
    expect(readFileSync(join(home, 'log.jsonl'), 'utf8')).toBe(log);
    rmSync(path);
    expect(await lb(home, ['bosun', '--quick'])).toEqual({ code: 0, out: 'Bosun: nothing to do\n', err: '' });
    expect(JSON.parse((await lb(home, ['bosun', '--json'])).out).unreadable).toEqual([]);
  });
});

describe('lb bosun', () => {
  it('defaults to quick, accepts --quick, and refuses an incomplete --full without touching the store', async () => {
    const home = tempDir('lb-home-');
    expect(await lb(home, ['bosun'])).toEqual({ code: 0, out: 'Bosun: nothing to do\n', err: '' });
    expect(await lb(home, ['bosun', '--quick'])).toEqual({ code: 0, out: 'Bosun: nothing to do\n', err: '' });
    for (const [args, message] of [[['bosun', '--full'], '--runner'], [['bosun', '--quick', '--full', '--json'], '--quick']] as const) {
      const result = await lb(home, [...args]);
      expect(result.code).toBe(1);
      expect(result.out).toBe('');
      expect(result.err).toContain(message);
    }
    expect(readdirSync(home)).toEqual([]);
  });

  it('supports dry-run and JSON, expires on disk with caller attribution, then reports nothing new', async () => {
    const home = tempDir('lb-home-');
    const added = await lb(home, ['hold', '--title', 'Lapsed hold', '--release', 'r', '--until', '2000-01-01', '--json'], { env: sessionA });
    expect(added.code).toBe(0);
    const id = JSON.parse(added.out).id;
    const file = join(home, 'global', 'entries', `${id}.md`);
    const before = [readFileSync(file, 'utf8'), readFileSync(join(home, 'log.jsonl'), 'utf8')];
    const dry = await lb(home, ['bosun', '--dry-run', '--json'], { env: sessionB });
    expect(dry.code).toBe(0);
    expect(JSON.parse(dry.out)).toMatchObject({ dryRun: true, expired: [{ id, status: 'expired' }], deadReferences: [], staleReferences: [], duplicates: [], staleHolds: [] });
    expect([readFileSync(file, 'utf8'), readFileSync(join(home, 'log.jsonl'), 'utf8')]).toEqual(before);
    expect((await lb(home, ['bosun', '--dry-run'])).out).toContain('## Expired (would expire)');

    const applied = await lb(home, ['bosun', '--quick', '--json', '--session', 'flag-session'], { env: sessionB });
    expect(applied.code).toBe(0);
    expect(JSON.parse(applied.out)).toMatchObject({ dryRun: false, expired: [{ id, status: 'expired' }] });
    const shown = JSON.parse((await lb(home, ['show', id, '--json'])).out);
    expect(shown.status).toBe('expired');
    expect(shown.body).toBe(`## Expired (${shown.updated}, bosun)\n`);
    const lines = readFileSync(join(home, 'log.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatchObject({ id, event: 'status', status: 'expired', harness: 'bosun', session: 'flag-session' });
    expect((await lb(home, ['list', '--status', 'expired'])).out).toContain(id);
    expect((await lb(home, ['bosun'])).out).toBe('Bosun: nothing to do\n');
  });

  it('reports stale citations through default/quick/JSON without writes, and recognizes an in-place repair', async () => {
    const home = tempDir('lb-home-');
    const old = sampleEntry({ id: 'rule-old-0001', title: 'Old instruction', status: 'superseded' });
    const current = sampleEntry({ id: 'rule-current-0001', title: 'Current instruction', supersedes: [old.id] });
    const revoked = sampleEntry({ id: 'rule-revoked-0001', title: 'Revoked instruction', status: 'revoked' });
    const missing = 'rule-missing-abcd';
    const citing = sampleEntry({ id: 'rule-citing-0001', title: 'Follow the instruction', body: `${old.id} ${revoked.id} ${missing}` });
    const entries = [old, current, revoked, citing];
    initStore(home);
    for (const entry of entries) writeEntry(home, entry);
    const files = [...entries.map((entry) => join(home, 'global', 'entries', `${entry.id}.md`)), join(home, 'log.jsonl')];
    const bytes = () => files.map((file) => readFileSync(file, 'utf8'));
    const before = bytes();
    const line = `- [${citing.id}] ${citing.title} — cites ${missing} (missing), ${old.id} (superseded; now ${current.id}), ${revoked.id} (revoked)`;
    for (const flags of [[], ['--quick']]) {
      expect(await lb(home, ['bosun', ...flags])).toEqual({ code: 0, out: `## Stale entry references\n${line}\n`, err: '' });
    }
    const expected = [{ entry: expect.objectContaining({ id: citing.id }), citations: [
      { id: missing, status: 'missing', current: null },
      { id: old.id, status: 'superseded', current: current.id },
      { id: revoked.id, status: 'revoked', current: null },
    ] }];
    for (const flags of [['--json'], ['--quick', '--dry-run', '--json']]) {
      const result = await lb(home, ['bosun', ...flags]);
      expect(result.code).toBe(0);
      expect(JSON.parse(result.out).staleReferences).toEqual(expected);
    }
    expect(bytes()).toEqual(before);
    expect((await lb(home, ['revise', citing.id, '--body', `Follow ${current.id}.`])).code).toBe(0);
    const repaired = await lb(home, ['bosun', '--quick', '--json']);
    expect(repaired.code).toBe(0);
    expect(JSON.parse(repaired.out).staleReferences).toEqual([]);
  });

  it('renders report-only findings in text and as the same structured JSON data', async () => {
    const home = tempDir('lb-home-');
    const missing = join(home, 'missing');
    writeEntry(home, sampleEntry({ id: 'reference-dead-0001', kind: 'reference', scope: 'machine', title: `Read ${missing}` }));
    writeEntry(home, sampleEntry({ id: 'rule-dupe-0001', title: 'Same!', body: 'rule-missing-abcd' }));
    const unreadablePath = join(scopeDir(home, 'global'), 'rule-broken.md');
    writeFileSync(unreadablePath, 'broken');
    writeEntry(home, sampleEntry({ id: 'rule-dupe-0002', title: 'same' }));
    writeEntry(home, sampleEntry({ id: 'hold-stale-0001', kind: 'hold', title: 'Old hold', updated: '2000-01-01T00:00:00Z' }));
    const text = await lb(home, ['bosun']);
    expect(text.code).toBe(0);
    expect(text.out.match(/^## .+$/gm)).toEqual(['## Dead references', '## Stale entry references', '## Exact duplicates', '## Stale holds', '## Unreadable files']);
    expect(text.out).toContain(missing);
    const json = await lb(home, ['bosun', '--json']);
    expect(json.code).toBe(0);
    expect(JSON.parse(json.out)).toMatchObject({
      expired: [],
      deadReferences: [{ entry: { id: 'reference-dead-0001' }, paths: [missing] }],
      staleReferences: [{ entry: { id: 'rule-dupe-0001' }, citations: [{ id: 'rule-missing-abcd', status: 'missing', current: null }] }],
      unreadable: [{ path: unreadablePath, scope: 'global', error: expect.stringMatching(/frontmatter/) }],
      duplicates: [{ scope: 'global', title: 'same', entries: [{ id: 'rule-dupe-0001' }, { id: 'rule-dupe-0002' }] }],
      staleHolds: [{ entry: { id: 'hold-stale-0001' }, untouchedDays: expect.any(Number) }],
    });
  });
});

/** Raw usage records, read without the CLI. */
function usageRecords(home: string): any[] {
  const path = join(home, 'state', 'usage.jsonl');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line));
}

describe('lb usage', () => {
  it('reports zero usage for a missing log without creating one, in text and JSON', async () => {
    const home = tempDir('lb-home-');
    const text = await lb(home, ['usage']);
    expect(text.code).toBe(0);
    expect(text.out).toContain('Command');
    expect(text.out).toContain('calls');
    const structured = await lb(home, ['usage', '--json']);
    expect(structured.code).toBe(0);
    const report = JSON.parse(structured.out);
    expect(report.brief.calls).toEqual({ count: 0, n: 0, lowSample: true });
    expect(report.check.calls).toEqual({ count: 0, n: 0, lowSample: true });
    expect(existsSync(join(home, 'state'))).toBe(false);
  });

  it('records real brief and check calls and reports the expected numbers', async () => {
    const { home, repo } = await projectWorld();
    const cwd = repo;

    expect((await lb(home, ['brief'], { env: sessionA, cwd })).code).toBe(0);
    expect((await lb(home, ['brief'], { env: sessionB, cwd })).code).toBe(0);
    expect((await lb(home, ['brief', '--harness', 'pi', '--session', 'flag'], { env: sessionA, cwd })).code).toBe(0);
    expect((await lb(home, ['brief'], { cwd: tempDir('lb-cwd-') })).code).toBe(0);
    expect((await lb(home, ['brief', '--json'], { env: sessionB, cwd })).code).toBe(0);
    expect((await lb(home, ['check', '--blocks', 'deploy'], { env: sessionB, cwd })).code).toBe(0);
    await lb(home, ['hold', '--title', 'No deploys', '--release', 'r', '--blocks', 'deploy'], { env: sessionA, cwd });
    expect((await lb(home, ['check', '--blocks', 'deploy'], { env: sessionB, cwd })).code).toBe(3);

    const records = usageRecords(home);
    expect(records).toHaveLength(7);
    expect(records[0]).toMatchObject({ command: 'brief', harness: 'claude-code', session: 'A', project: 'P', cwd, entries: 0 });
    expect(records[1]).toMatchObject({ command: 'brief', harness: 'pi', session: 'B', project: 'P' });
    expect(records[2]).toMatchObject({ command: 'brief', harness: 'pi', session: 'flag', project: 'P' });
    expect(records[3]).toMatchObject({ command: 'brief', harness: null, session: null, project: null });
    expect(records[4]).toMatchObject({ command: 'brief', harness: 'pi', session: 'B', project: 'P' });
    expect(records[5]).toMatchObject({ command: 'check', harness: 'pi', session: 'B', project: 'P', tag: 'deploy', blocked: false });
    expect(records[6]).toMatchObject({ command: 'check', harness: 'pi', session: 'B', project: 'P', tag: 'deploy', blocked: true });

    const report = JSON.parse((await lb(home, ['usage', '--json'])).out);
    expect(report.brief.calls).toEqual({ count: 5, n: 5, lowSample: true });
    expect(report.brief.sessions).toEqual({ count: 3, n: 4, lowSample: true });
    expect(report.brief.anonymous).toEqual({ count: 1, n: 5, lowSample: true });
    expect(report.brief.byHarness).toEqual([
      { harness: 'claude-code', sessions: { count: 1, n: 1, lowSample: true } },
      { harness: 'pi', sessions: { count: 2, n: 3, lowSample: true } },
    ]);
    expect(report.brief.byProject).toEqual([
      { project: null, calls: { count: 1, n: 1, lowSample: true } },
      { project: 'P', calls: { count: 4, n: 4, lowSample: true } },
    ]);
    expect(report.check.calls).toEqual({ count: 2, n: 2, lowSample: true });
    expect(report.check.blocked).toEqual({ count: 1, n: 2, lowSample: true });
    expect(report.check.sessions).toEqual({ count: 1, n: 2, lowSample: true });
    expect(report.check.anonymous).toEqual({ count: 0, n: 2, lowSample: true });
    expect(report.check.byTag).toEqual([{ tag: 'deploy', calls: { count: 2, n: 2, lowSample: true } }]);

    const text = (await lb(home, ['usage'])).out;
    expect(text).toContain('sessions by harness claude-code');
    expect(text).toContain('calls by project (none)');
    expect(text).toContain('calls by tag deploy');
    expect(text).toContain(`n=${report.brief.calls.n}`);
  });

  it('logs neither usage, help, delta nor list calls', async () => {
    const home = tempDir('lb-home-');
    expect((await lb(home, ['usage'])).code).toBe(0);
    expect((await lb(home, ['--help'])).code).toBe(0);
    expect((await lb(home, ['delta'], { env: sessionA })).code).toBe(0);
    expect((await lb(home, ['list'])).code).toBe(0);
    expect(usageRecords(home)).toEqual([]);
  });

  it('honours --since over a seeded log and rejects a malformed cutoff', async () => {
    const home = tempDir('lb-home-');
    mkdirSync(join(home, 'state'), { recursive: true });
    const seeded = [
      { ts: '2026-10-01T00:00:00Z', command: 'brief', harness: 'pi', session: 'A', project: 'P', cwd: '/w', entries: 0, chars: 0 },
      { ts: '2026-09-01T00:00:00Z', command: 'brief', harness: 'pi', session: 'B', project: 'P', cwd: '/w', entries: 0, chars: 0 },
    ];
    writeFileSync(join(home, 'state', 'usage.jsonl'), seeded.map((record) => JSON.stringify(record)).join('\n') + '\n');
    const report = JSON.parse((await lb(home, ['usage', '--since', '2026-09-15', '--json'])).out);
    expect(report.brief.calls.count).toBe(1);
    expect(report.since).toBe('2026-09-15T00:00:00.000Z');
    const bad = await lb(home, ['usage', '--since', 'nope']);
    expect(bad.code).toBe(1);
    expect(bad.err).toMatch(/^lb: /);
  });

  it('leaves brief and check results unchanged when the usage log cannot be written', async () => {
    const { home, repo } = await projectWorld();
    await lb(home, ['hold', '--title', 'No deploys', '--release', 'r', '--blocks', 'deploy'], { env: sessionA, cwd: repo });

    const runs: Array<[string[], { env?: Record<string, string>; cwd?: string }]> = [
      [['brief'], { env: sessionB, cwd: repo }],
      [['brief', '--json'], { env: sessionB, cwd: repo }],
      [['check', '--blocks', 'deploy'], { env: sessionB, cwd: repo }],
      [['check', '--blocks', 'deploy', '--json'], { env: sessionB, cwd: repo }],
      [['check', '--blocks', 'other'], { env: sessionB, cwd: repo }],
    ];
    const runAll = async () => {
      const results: LbResult[] = [];
      for (const [args, options] of runs) results.push(await lb(home, args, options));
      return results;
    };
    const baseline = await runAll();

    rmSync(join(home, 'state', 'usage.jsonl'), { force: true });
    mkdirSync(join(home, 'state', 'usage.jsonl'), { recursive: true });

    const after = await runAll();
    expect(after).toEqual(baseline);
  });
});

describe('the built CLI (spawned)', () => {
  beforeAll(requireBuild);

  /** `dist/cli.js` as a process: the only route through the bin wrapper, real stdin and the process exit code. */
  function spawnLb(home: string, args: string[], input?: string): LbResult {
    const run = spawnSync('node', [CLI, ...args], {
      cwd: tempDir('lb-cwd-'),
      env: { ...process.env, LEEBOARD_HOME: home },
      input,
      encoding: 'utf8',
    });
    return { code: run.status ?? -1, out: run.stdout, err: run.stderr };
  }

  it.each(['--version', '-v'])('prints the installed version from an unrelated cwd: %s', (flag) => {
    const { version } = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { version: string };
    const home = join(tempDir('lb-parent-'), 'store');
    expect(spawnLb(home, [flag])).toEqual({ code: 0, out: `${version}\n`, err: '' });
    expect(existsSync(home)).toBe(false);
  });

  it('reads --body from stdin with --body -', async () => {
    const home = tempDir('lb-home-');
    const id = idOf(spawnLb(home, ['add', 'reference', '--title', 'From stdin', '--body', '-'], 'line one\nline two\n'));
    expect((await lb(home, ['show', id])).out).toContain('\nline one\nline two\n');
  });

  it('reads a reply from stdin with --body -', async () => {
    const home = tempDir('lb-home-');
    const id = idOf(spawnLb(home, ['request', '--title', 'Plan it', '--to', 'any']));
    expect(spawnLb(home, ['reply', id, '--body', '-'], 'line one\nline two\n').code).toBe(0);
    const shown = (await lb(home, ['show', id])).out;
    expect(shown).toMatch(/## Reply \([^)]*\)\nline one\nline two\n/);
    expect(shown).not.toMatch(/\n-\n/);
  });

  it('writes stdout and stderr and exits with the code of the command', () => {
    const home = tempDir('lb-home-');
    const hold = idOf(spawnLb(home, ['hold', '--title', 'No runs', '--release', 'r', '--blocks', 't']));
    const blocked = spawnLb(home, ['check', '--blocks', 't']);
    expect(blocked.code).toBe(3);
    expect(blocked.out).toContain(`[${hold}] No runs`);
    expect(blocked.err).toBe('');
    expect(spawnLb(home, ['check', '--blocks', 'other'])).toEqual({ code: 0, out: '', err: '' });
    const unknown = spawnLb(home, ['release', 'hold-zzz']);
    expect(unknown.code).toBe(4);
    expect(unknown.out).toBe('');
    expect(unknown.err).toMatch(/^lb: /);
    expect(spawnLb(home, ['frobnicate'])).toMatchObject({ code: 1, out: '', err: expect.stringMatching(/^lb: unknown command/) });
  });

  it('runs directly through its shebang', () => {
    const run = spawnSync(CLI, ['--help'], { env: process.env, encoding: 'utf8' });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('lb brief');
  });
});
