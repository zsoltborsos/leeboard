import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EXIT } from '../src/errors.js';
import { lb, type LbResult, tempDir } from './helpers.js';

const me = { LEEBOARD_HARNESS: 'claude-code', LEEBOARD_SESSION: 'renamer' };
const other = { LEEBOARD_HARNESS: 'pi', LEEBOARD_SESSION: 'other' };

function idOf(result: LbResult): string {
  const id = /\[([a-z]+-[^\]]+)\]/.exec(result.out)?.[1];
  if (!id) throw new Error(`no id in output: ${result.out}${result.err}`);
  return id;
}

/** A store with project `old` holding an active rule and a closed request, plus a request to it from elsewhere. */
async function storeWithProject() {
  const home = tempDir('lb-home-');
  await lb(home, ['project', 'add', 'old', '--path', '/work/old']);
  await lb(home, ['project', 'add', 'other', '--path', '/work/other']);
  const rule = idOf(await lb(home, ['add', 'rule', '--title', 'Keep it small', '--scope', 'project:old'], { env: me }));
  const closed = idOf(await lb(home, ['request', '--title', 'Done already', '--to', 'project:old', '--scope', 'project:old'], { env: me }));
  await lb(home, ['close', closed], { env: me });
  const inbound = idOf(await lb(home, ['request', '--title', 'Please look', '--to', 'project:old', '--scope', 'project:other'], { env: me }));
  return { home, rule, closed, inbound };
}

const file = (home: string, project: string, id: string) => join(home, 'projects', project, 'entries', `${id}.md`);

describe('lb project rename', () => {
  it.each(['bosun', 'helmraiser'])('refuses %s before changing entries or project metadata', async (harness) => {
    const { home, rule, closed, inbound } = await storeWithProject();
    const held = await lb(home, ['hold', '--title', 'Keep the project', '--scope', 'project:old', '--release', 'Owner agrees'], { env: me });
    expect(held).toMatchObject({ code: 0, err: '' });
    const hold = idOf(held);
    const paths = [
      join(home, 'projects', 'old', 'project.md'),
      join(home, 'projects', 'other', 'project.md'),
      file(home, 'old', rule),
      file(home, 'old', closed),
      file(home, 'other', inbound),
      file(home, 'old', hold),
      join(home, 'log.jsonl'),
    ];
    const before = paths.map((path) => readFileSync(path, 'utf8'));
    const entries = readdirSync(join(home, 'projects', 'old', 'entries')).sort();

    const result = await lb(home, ['project', 'rename', 'old', 'new', '--path', '/work/new'], {
      env: { LEEBOARD_HARNESS: harness, LEEBOARD_SESSION: 'run-1' },
    });
    expect(result).toEqual({
      code: EXIT.NOT_PERMITTED,
      out: '',
      err: `lb: ${harness} may not rename projects; ask the owner or an interactive session\n`,
    });
    expect(paths.map((path) => readFileSync(path, 'utf8'))).toEqual(before);
    expect(readdirSync(join(home, 'projects', 'old', 'entries')).sort()).toEqual(entries);
    expect(existsSync(join(home, 'projects', 'old'))).toBe(true);
    expect(existsSync(join(home, 'projects', 'new'))).toBe(false);
  });

  it('moves the project, every entry of any status, and requests addressed to it', async () => {
    const { home, rule, closed, inbound } = await storeWithProject();
    const result = await lb(home, ['project', 'rename', 'old', 'new', '--path', '/work/new'], { env: me });
    expect(result).toMatchObject({ code: 0, err: '' });

    expect(existsSync(join(home, 'projects', 'old'))).toBe(false);
    expect(readFileSync(join(home, 'projects', 'new', 'project.md'), 'utf8')).toBe(`---
name: new
paths: [/work/new, /work/old]
remotes: []
---
`);
    expect(readFileSync(file(home, 'new', rule), 'utf8')).toContain('\nscope: project:new\n');
    const closedText = readFileSync(file(home, 'new', closed), 'utf8');
    expect(closedText).toContain('\nscope: project:new\n');
    expect(closedText).toContain('\nto: project:new\n');
    expect(closedText).toContain('\nstatus: done\n');
    const inboundText = readFileSync(file(home, 'other', inbound), 'utf8');
    expect(inboundText).toContain('\nscope: project:other\n');
    expect(inboundText).toContain('\nto: project:new\n');
  });

  it('leaves ids, bodies and timestamps alone, and logs one line per moved entry', async () => {
    const { home, rule, closed, inbound } = await storeWithProject();
    const before = readFileSync(file(home, 'old', rule), 'utf8');
    const logBefore = readFileSync(join(home, 'log.jsonl'), 'utf8');
    await lb(home, ['project', 'rename', 'old', 'new'], { env: me });
    expect(readFileSync(file(home, 'new', rule), 'utf8')).toBe(before.replace('scope: project:old', 'scope: project:new'));
    const added = readFileSync(join(home, 'log.jsonl'), 'utf8').slice(logBefore.length).trim().split('\n').map((line) => JSON.parse(line));
    expect(added.map((line) => [line.id, line.scope, line.event, line.session]).sort()).toEqual(
      [
        [closed, 'project:new', 'updated', 'renamer'],
        [inbound, 'project:other', 'updated', 'renamer'],
        [rule, 'project:new', 'updated', 'renamer'],
      ].sort(),
    );
  });

  it('without --path keeps the paths as they were', async () => {
    const { home } = await storeWithProject();
    await lb(home, ['project', 'rename', 'old', 'new'], { env: me });
    expect((await lb(home, ['project', 'list', '--json'])).out).toContain('"name":"new","paths":["/work/old"]');
  });

  it('a later lifecycle command on a moved closed entry writes into the new project', async () => {
    const { home, rule } = await storeWithProject();
    await lb(home, ['project', 'rename', 'old', 'new'], { env: me });
    expect((await lb(home, ['revoke', rule, '--reason', 'obsolete'], { env: me })).code).toBe(0);
    expect(readFileSync(file(home, 'new', rule), 'utf8')).toContain('\nstatus: revoked\n');
    expect(existsSync(join(home, 'projects', 'old'))).toBe(false);
  });

  it('shows up in another session’s delta under the new scope', async () => {
    const home = tempDir('lb-home-');
    await lb(home, ['project', 'add', 'old', '--path', '/work/old']);
    const rule = idOf(await lb(home, ['add', 'rule', '--title', 'Keep it small', '--scope', 'project:old'], { env: me }));
    await lb(home, ['delta', '--cwd', '/work/new'], { env: other }); // sets the cursor
    await lb(home, ['project', 'rename', 'old', 'new', '--path', '/work/new'], { env: me });
    const delta = await lb(home, ['delta', '--cwd', '/work/new'], { env: other });
    expect(delta.out).toBe(`- [${rule}] rule updated: Keep it small\n`);
    expect((await lb(home, ['review', '--peek'])).code).toBe(0);
  });

  it('reverses cleanly', async () => {
    const { home } = await storeWithProject();
    const snapshot = () =>
      ['old', 'other'].flatMap((p) =>
        readdirSync(join(home, 'projects', p, 'entries')).map((name) => readFileSync(join(home, 'projects', p, 'entries', name), 'utf8')),
      );
    const project = readFileSync(join(home, 'projects', 'old', 'project.md'), 'utf8');
    const before = snapshot();
    await lb(home, ['project', 'rename', 'old', 'new'], { env: me });
    await lb(home, ['project', 'rename', 'new', 'old'], { env: me });
    expect(snapshot()).toEqual(before);
    expect(readFileSync(join(home, 'projects', 'old', 'project.md'), 'utf8')).toBe(project);
  });

  it('finishes the job when run again after stopping part-way', async () => {
    const { home, rule, closed } = await storeWithProject();
    // As if interrupted after moving one entry: it already sits in projects/new/entries.
    await lb(home, ['project', 'rename', 'old', 'new'], { env: me });
    await lb(home, ['project', 'rename', 'new', 'old'], { env: me });
    const moved = readFileSync(file(home, 'old', rule), 'utf8').replace('scope: project:old', 'scope: project:new');
    const { mkdirSync, writeFileSync, rmSync } = await import('node:fs');
    mkdirSync(join(home, 'projects', 'new', 'entries'), { recursive: true });
    writeFileSync(file(home, 'new', rule), moved);
    rmSync(file(home, 'old', rule));
    expect((await lb(home, ['project', 'rename', 'old', 'new'], { env: me })).code).toBe(0);
    expect(readdirSync(join(home, 'projects', 'new', 'entries')).sort()).toEqual([`${closed}.md`, `${rule}.md`].sort());
    expect(existsSync(join(home, 'projects', 'old'))).toBe(false);
  });

  it('refuses before changing anything when an entry file in the project cannot be read', async () => {
    const { home, rule } = await storeWithProject();
    const { writeFileSync } = await import('node:fs');
    const broken = join(home, 'projects', 'old', 'entries', 'rule-broken-0000.md');
    writeFileSync(broken, 'not an entry\n');
    const before = readFileSync(file(home, 'old', rule), 'utf8');
    const result = await lb(home, ['project', 'rename', 'old', 'new'], { env: me });
    expect(result).toEqual({ code: 1, out: '', err: `lb: cannot rename project 'old': unreadable entry file ${broken}; fix or remove it first\n` });
    expect(readFileSync(file(home, 'old', rule), 'utf8')).toBe(before);
    expect(existsSync(join(home, 'projects', 'new'))).toBe(false);
  });

  it.each([
    [['project', 'rename', 'missing', 'new'], "no project named 'missing'"],
    [['project', 'rename', 'old', 'other'], "project 'other' already exists"],
    [['project', 'rename', 'old', 'bad name'], "invalid project name 'bad name'"],
    [['project', 'rename', 'old'], 'usage: lb project rename <old> <new> [--path <dir>]'],
  ])('refuses %j', async (args, message) => {
    const { home } = await storeWithProject();
    const result = await lb(home, args, { env: me });
    expect(result).toEqual({ code: 1, out: '', err: `lb: ${message}\n` });
    expect(existsSync(join(home, 'projects', 'old', 'project.md'))).toBe(true);
  });
});
