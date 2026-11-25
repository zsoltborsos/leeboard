import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ackHandoff,
  closeRequest,
  createEntry,
  type NewEntry,
  releaseHold,
  replyToRequest,
  revokeEntry,
  supersedeEntry,
} from '../src/change.js';
import type { Ctx } from '../src/context.js';
import type { Harness } from '../src/entry.js';
import { EXIT, LeeboardError } from '../src/errors.js';
import { readLogSince } from '../src/log.js';
import { findEntry, scopeDir } from '../src/store.js';
import { lb, tempDir } from './helpers.js';

describe('lifecycle command results', () => {
  it.each([
    ['release', { kind: 'hold', release: 'r' }, ['--note', 'Done'], 'released'],
    ['ack', { kind: 'handoff', to: 'any' }, [], 'done'],
    ['close', { kind: 'request', to: 'any' }, [], 'done'],
    ['reply', { kind: 'request', to: 'any' }, ['--body', 'Answer'], 'active'],
    ['revoke', { kind: 'rule' }, ['--reason', 'Obsolete'], 'revoked'],
    ['supersede', { kind: 'rule' }, [], 'superseded'],
  ] as const)('%s owns text and summary JSON results', async (command, fields, flags, status) => {
    for (const json of [false, true]) {
      const { home, add } = setup();
      const entry = add({ title: 'Lifecycle', ...fields });
      const extra = command === 'supersede' ? ['--by', add({ kind: 'rule', title: 'Replacement' }).id] : [...flags];
      const result = await lb(home, [command, entry.id, ...extra, ...(json ? ['--json'] : [])]);
      const returned = command === 'supersede' ? findEntry(home, extra[1]!) : findEntry(home, entry.id);
      const returnedStatus = command === 'supersede' ? 'active' : status;
      const expected = {
        id: returned.id, kind: entry.kind, scope: 'global', status: returnedStatus, title: returned.title,
        author: entry.author, created: entry.created, updated: returned.updated,
        ...('release' in fields ? { release: fields.release } : {}),
        ...('to' in fields ? { to: fields.to } : {}),
      };
      expect(result).toEqual({ code: 0, out: json ? JSON.stringify(expected) + '\n' : `- [${returned.id}] ${returnedStatus} global: ${returned.title}\n`, err: '' });
    }
  });

  it.each(['release', 'ack', 'close', 'reply', 'revoke', 'supersede'])('%s resolves identity before missing id', async (command) => {
    const { home, add } = setup();
    const entry = add({ kind: 'rule', title: 'Unchanged' });
    const before = dump(home, [entry]);
    expect(await lb(home, [command])).toEqual({ code: 1, out: '', err: `lb: usage: lb ${command} <${command === 'supersede' ? 'old-id' : 'id'}>\n` });
    expect(await lb(home, [command, '--origin', 'invalid'])).toEqual({ code: 1, out: '', err: 'lb: unknown origin \'invalid\' (use user-stated, agent-inferred, mirrored)\n' });
    expect(dump(home, [entry])).toBe(before);
  });

  it('requires supersede replacement after identity and old id', async () => {
    const { home, add } = setup();
    const entry = add({ kind: 'rule', title: 'Unchanged' });
    const before = dump(home, [entry]);
    expect(await lb(home, ['supersede', entry.id])).toEqual({ code: 1, out: '', err: 'lb: usage: lb supersede <old-id> --by <new-id>\n' });
    expect(await lb(home, ['supersede', entry.id, '--origin', 'invalid'])).toEqual({ code: 1, out: '', err: 'lb: unknown origin \'invalid\' (use user-stated, agent-inferred, mirrored)\n' });
    expect(dump(home, [entry])).toBe(before);
  });
});

const CREATED = new Date('2026-10-17T14:02:11Z');
const LATER = new Date('2026-10-18T09:00:00Z');

/** One store; `author` acts at CREATED as claude-code/A, `other` acts at LATER as pi/B. */
function setup() {
  const home = tempDir();
  const cwd = tempDir('lb-cwd-');
  const author: Ctx = { home, cwd, now: CREATED, identity: { harness: 'claude-code', session: 'A', origin: 'agent-inferred' } };
  const other: Ctx = { home, cwd, now: LATER, identity: { harness: 'pi', session: 'B', origin: 'agent-inferred' } };
  const add = (input: NewEntry) => createEntry(author, { scope: 'global', ...input });
  return { home, author, other, add };
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

const logCount = (home: string) => readLogSince(home, 0).lines.length;

/** The raw bytes of the named entry files plus `log.jsonl`, for no-write assertions. */
function dump(home: string, entries: { id: string; scope: string }[]): string {
  const files = entries.map((entry) => readFileSync(join(scopeDir(home, entry.scope), `${entry.id}.md`), 'utf8'));
  return JSON.stringify([files, readFileSync(join(home, 'log.jsonl'), 'utf8')]);
}

/** The unattended task runners that share one set of restrictions. */
const RUNNERS = ['helmraiser'] as const;

function runnerCtx(harness: (typeof RUNNERS)[number], home: string, session: string | null): Ctx {
  return { home, cwd: tempDir(), now: LATER, identity: { harness, session, origin: 'agent-inferred' } };
}

describe.each(RUNNERS)('%s guard: release and revoke', (harness) => {
  const runner = (home: string, session: string | null) => runnerCtx(harness, home, session);

  it('refuses to release any hold or grant, whether or not the worker authored it', () => {
    const { home, add } = setup();
    const hold = add({ kind: 'hold', title: 'No runs', release: 'r', blocks: ['helmraiser-run'] });
    const grant = add({ kind: 'grant', title: 'A grant', holder: 'x' });
    for (const session of ['A', 'Z']) {
      for (const entry of [hold, grant]) {
        const before = dump(home, [entry]);
        const error = failure(() => releaseHold(runner(home, session), entry.id));
        expect(error.exitCode).toBe(EXIT.NOT_PERMITTED);
        expect(error.exitCode).toBe(6);
        expect(error.message).toContain(entry.id);
        expect(error.message).toMatch(/owner|interactive session/);
        expect(error.message).not.toContain('\n');
        expect(dump(home, [entry])).toBe(before);
      }
    }
  });

  it('refuses to revoke any hold or grant, whether or not the worker authored it', () => {
    const { home, add } = setup();
    const hold = add({ kind: 'hold', title: 'No runs', release: 'r' });
    const grant = add({ kind: 'grant', title: 'A grant', holder: 'x' });
    for (const session of ['A', 'Z']) {
      for (const entry of [hold, grant]) {
        const before = dump(home, [entry]);
        const error = failure(() => revokeEntry(runner(home, session), entry.id, 'why'));
        expect(error.exitCode).toBe(EXIT.NOT_PERMITTED);
        expect(error.message).toContain(entry.id);
        expect(error.message).toMatch(/owner|interactive session/);
        expect(dump(home, [entry])).toBe(before);
      }
    }
  });

  it.each([
    ['rule', { kind: 'rule', title: 'A rule' }],
    ['reference', { kind: 'reference', title: 'A reference' }],
    ['handoff', { kind: 'handoff', title: 'A handoff', to: 'any' }],
    ['request', { kind: 'request', title: 'A request', to: 'any' }],
  ])('lets a worker revoke its own %s but refuses another session\'s', (_kind, input) => {
    const { home, other, add } = setup();
    const own = add(input); // authored by claude-code/A
    const foreign = createEntry(other, { scope: 'global', ...input }); // authored by pi/B
    const worker = runner(home, 'A');

    const error = failure(() => revokeEntry(worker, foreign.id, 'why'));
    expect(error.exitCode).toBe(EXIT.NOT_PERMITTED);
    expect(error.message).toContain(foreign.id);
    expect(findEntry(home, foreign.id)).toEqual(foreign);

    expect(revokeEntry(worker, own.id, 'why').status).toBe('revoked');
  });

  it('refuses a worker with no session, even for an anonymous entry', () => {
    const { home, add } = setup();
    const rule = add({ kind: 'rule', title: 'A rule' });
    const anonymous = createEntry(
      { home, cwd: tempDir(), now: LATER, identity: { harness: null, session: null, origin: 'agent-inferred' } },
      { kind: 'rule', scope: 'global', title: 'Anon' },
    );
    for (const entry of [rule, anonymous]) {
      expect(failure(() => revokeEntry(runner(home, null), entry.id, 'why')).exitCode).toBe(EXIT.NOT_PERMITTED);
    }
  });

  it('refuses a protected hold that is already released', () => {
    const { home, other, add } = setup();
    const hold = add({ kind: 'hold', title: 'No runs', release: 'r' });
    releaseHold(other, hold.id);
    const error = failure(() => releaseHold(runner(home, 'A'), hold.id));
    expect(error.exitCode).toBe(EXIT.NOT_PERMITTED);
    expect(error.message).toContain(hold.id);
  });

  it.each(['claude-code', 'pi', 'funkyoctopus', 'bosun', 'user', null])(
    'leaves harness %s free to release a hold and revoke a grant from another session',
    (harness) => {
      const { home, add } = setup();
      const hold = add({ kind: 'hold', title: 'No runs', release: 'r' });
      const grant = add({ kind: 'grant', title: 'A grant', holder: 'x' });
      const ctx: Ctx = {
        home,
        cwd: tempDir(),
        now: LATER,
        identity: { harness: harness as Harness | null, session: 'Z', origin: 'agent-inferred' },
      };
      expect(releaseHold(ctx, hold.id).status).toBe('released');
      expect(revokeEntry(ctx, grant.id, 'no').status).toBe('revoked');
    },
  );
});

describe('release', () => {
  it('moves an active hold to released, stamps updated and logs a status event', () => {
    const { home, other, add } = setup();
    const hold = add({ kind: 'hold', title: 'No runs', release: 'tunnel closed', body: 'why\n' });

    const released = releaseHold(other, hold.id);

    expect(released.status).toBe('released');
    expect(findEntry(home, hold.id)).toEqual({ ...hold, status: 'released', updated: '2026-10-18T09:00:00Z' });
    expect(readLogSince(home, 0).lines.at(-1)).toEqual({
      ts: '2026-10-18T09:00:00Z',
      id: hold.id,
      kind: 'hold',
      scope: 'global',
      event: 'status',
      status: 'released',
      harness: 'pi',
      session: 'B',
    });
  });

  it('appends the note to the body when one is given', () => {
    const { home, other, add } = setup();
    const hold = add({ kind: 'hold', title: 'No runs', release: 'tunnel closed', body: 'why\n' });
    releaseHold(other, hold.id, 'Tunnel is closed now.');
    expect(findEntry(home, hold.id).body).toBe('why\n\n## Released (2026-10-18T09:00:00Z, pi/B)\nTunnel is closed now.\n');
  });

  it('accepts a unique id prefix', () => {
    const { home, other, add } = setup();
    const hold = add({ kind: 'hold', title: 'No runs', release: 'r' });
    releaseHold(other, hold.id.slice(0, 10));
    expect(findEntry(home, hold.id).status).toBe('released');
  });

  it.each([
    ['a rule', { kind: 'rule', title: 'A rule' }],
    ['a handoff', { kind: 'handoff', title: 'A handoff', to: 'any' }],
  ])('refuses %s with exit 5 and changes nothing', (_name, input) => {
    const { home, other, add } = setup();
    const entry = add(input);
    const error = failure(() => releaseHold(other, entry.id));
    expect(error.exitCode).toBe(EXIT.BAD_TRANSITION);
    expect(findEntry(home, entry.id)).toEqual(entry);
    expect(logCount(home)).toBe(1);
  });

  it('refuses a hold that is already released', () => {
    const { home, other, add } = setup();
    const hold = add({ kind: 'hold', title: 'No runs', release: 'r' });
    releaseHold(other, hold.id);
    expect(failure(() => releaseHold(other, hold.id)).exitCode).toBe(EXIT.BAD_TRANSITION);
    expect(logCount(home)).toBe(2);
  });

  it('exits 4 for an unknown id and for an ambiguous prefix, listing the candidates', () => {
    const { other, add } = setup();
    const a = add({ kind: 'hold', title: 'No runs', release: 'r' });
    const b = add({ kind: 'hold', title: 'No pushes', release: 'r' });
    expect(failure(() => releaseHold(other, 'hold-zzz')).exitCode).toBe(EXIT.UNKNOWN_ID);
    const ambiguous = failure(() => releaseHold(other, 'hold-no-'));
    expect(ambiguous.exitCode).toBe(EXIT.UNKNOWN_ID);
    expect(ambiguous.message).toContain(a.id);
    expect(ambiguous.message).toContain(b.id);
  });

  it('rejects a credential in the note with exit 2 and changes nothing', () => {
    const { home, other, add } = setup();
    const hold = add({ kind: 'hold', title: 'No runs', release: 'r' });
    const error = failure(() => releaseHold(other, hold.id, 'token ghp_' + 'a1b2c3d4e5'.repeat(3)));
    expect(error.exitCode).toBe(EXIT.CREDENTIAL);
    expect(error.message).toContain('note');
    expect(findEntry(home, hold.id)).toEqual(hold);
    expect(logCount(home)).toBe(1);
  });

  it('leaves every other entry untouched', () => {
    const { home, other, add } = setup();
    const hold = add({ kind: 'hold', title: 'No runs', release: 'r' });
    const rule = add({ kind: 'rule', title: 'Unrelated' });
    releaseHold(other, hold.id);
    expect(findEntry(home, rule.id)).toEqual(rule);
  });
});

describe('ack and close', () => {
  it('ack consumes a handoff', () => {
    const { home, other, add } = setup();
    const handoff = add({ kind: 'handoff', title: 'Continue X', to: 'harness:pi' });
    ackHandoff(other, handoff.id);
    expect(findEntry(home, handoff.id)).toMatchObject({ status: 'done', updated: '2026-10-18T09:00:00Z' });
    expect(readLogSince(home, 0).lines.at(-1)).toMatchObject({ event: 'status', status: 'done', session: 'B' });
  });

  it('close finishes a request', () => {
    const { home, other, add } = setup();
    const request = add({ kind: 'request', title: 'Review Y', to: 'harness:pi' });
    closeRequest(other, request.id);
    expect(findEntry(home, request.id).status).toBe('done');
  });

  it('refuse the wrong kind and an entry that is already done (exit 5)', () => {
    const { other, add } = setup();
    const handoff = add({ kind: 'handoff', title: 'Continue X', to: 'any' });
    const request = add({ kind: 'request', title: 'Review Y', to: 'any' });
    expect(failure(() => ackHandoff(other, request.id)).exitCode).toBe(EXIT.BAD_TRANSITION);
    expect(failure(() => closeRequest(other, handoff.id)).exitCode).toBe(EXIT.BAD_TRANSITION);
    ackHandoff(other, handoff.id);
    expect(failure(() => ackHandoff(other, handoff.id)).exitCode).toBe(EXIT.BAD_TRANSITION);
  });
});

describe('reply', () => {
  it('appends a reply section, keeps the request active and logs an updated event', () => {
    const { home, other, add } = setup();
    const request = add({ kind: 'request', title: 'Review Y', to: 'harness:pi', body: 'Please review.\n' });
    replyToRequest(other, request.id, 'Looks good.');
    const after = findEntry(home, request.id);
    expect(after.status).toBe('active');
    expect(after.updated).toBe('2026-10-18T09:00:00Z');
    expect(after.body).toBe('Please review.\n\n## Reply (2026-10-18T09:00:00Z, pi/B)\nLooks good.\n');
    expect(readLogSince(home, 0).lines.at(-1)).toMatchObject({ event: 'updated', status: 'active', session: 'B' });
  });

  it('stacks replies in order', () => {
    const { home, author, other, add } = setup();
    const request = add({ kind: 'request', title: 'Review Y', to: 'any' });
    replyToRequest(other, request.id, 'first');
    replyToRequest(author, request.id, 'second');
    expect(findEntry(home, request.id).body).toBe(
      '## Reply (2026-10-18T09:00:00Z, pi/B)\nfirst\n\n## Reply (2026-10-17T14:02:11Z, claude-code/A)\nsecond\n',
    );
  });

  it('writes "unknown" for an anonymous replier', () => {
    const { home, add } = setup();
    const request = add({ kind: 'request', title: 'Review Y', to: 'any' });
    const anonymous: Ctx = { home, cwd: tempDir(), now: LATER, identity: { harness: null, session: null, origin: 'agent-inferred' } };
    replyToRequest(anonymous, request.id, 'hi');
    expect(findEntry(home, request.id).body).toBe('## Reply (2026-10-18T09:00:00Z, unknown/unknown)\nhi\n');
  });

  it('refuses a non-request, a closed request (exit 5), an empty reply (exit 1) and a credential (exit 2)', () => {
    const { home, other, add } = setup();
    const handoff = add({ kind: 'handoff', title: 'Continue X', to: 'any' });
    const request = add({ kind: 'request', title: 'Review Y', to: 'any' });
    expect(failure(() => replyToRequest(other, handoff.id, 'hi')).exitCode).toBe(EXIT.BAD_TRANSITION);
    expect(failure(() => replyToRequest(other, request.id, '  ')).exitCode).toBe(EXIT.USAGE);
    expect(failure(() => replyToRequest(other, request.id, 'Bearer abcdefghijklmnop12345')).exitCode).toBe(EXIT.CREDENTIAL);
    closeRequest(other, request.id);
    expect(failure(() => replyToRequest(other, request.id, 'late')).exitCode).toBe(EXIT.BAD_TRANSITION);
    expect(findEntry(home, request.id).body).toBe('');
  });
});

describe('revoke', () => {
  it.each([
    ['rule', { kind: 'rule', title: 'A rule' }],
    ['grant', { kind: 'grant', title: 'A grant', holder: 'x' }],
    ['hold', { kind: 'hold', title: 'A hold', release: 'r' }],
    ['reference', { kind: 'reference', title: 'A reference' }],
    ['handoff', { kind: 'handoff', title: 'A handoff', to: 'any' }],
  ])('revokes an active %s and appends the reason', (_kind, input) => {
    const { home, other, add } = setup();
    const entry = add({ ...input, body: 'original\n' });
    revokeEntry(other, entry.id, 'No longer true.');
    const after = findEntry(home, entry.id);
    expect(after.status).toBe('revoked');
    expect(after.body).toBe('original\n\n## Revoked (2026-10-18T09:00:00Z, pi/B)\nNo longer true.\n');
    expect(readLogSince(home, 0).lines.at(-1)).toMatchObject({ event: 'status', status: 'revoked' });
  });

  it('refuses an entry that is not active (exit 5) and a missing reason (exit 1)', () => {
    const { home, other, add } = setup();
    const rule = add({ kind: 'rule', title: 'A rule' });
    const handoff = add({ kind: 'handoff', title: 'Done already', to: 'any' });
    ackHandoff(other, handoff.id);
    expect(failure(() => revokeEntry(other, rule.id, ' ')).exitCode).toBe(EXIT.USAGE);
    expect(failure(() => revokeEntry(other, handoff.id, 'why')).exitCode).toBe(EXIT.BAD_TRANSITION);
    revokeEntry(other, rule.id, 'why');
    expect(failure(() => revokeEntry(other, rule.id, 'again')).exitCode).toBe(EXIT.BAD_TRANSITION);
    expect(logCount(home)).toBe(4);
  });

  it('refuses a credential in the reason (exit 2)', () => {
    const { home, other, add } = setup();
    const rule = add({ kind: 'rule', title: 'A rule' });
    const error = failure(() => revokeEntry(other, rule.id, 'key sk-' + 'abcDEF0123456789'.repeat(2)));
    expect(error.exitCode).toBe(EXIT.CREDENTIAL);
    expect(error.message).toContain('reason');
    expect(findEntry(home, rule.id)).toEqual(rule);
  });
});

describe('supersede', () => {
  it('marks the old entry superseded and links the new one back to it', () => {
    const { home, other, add } = setup();
    const old = add({ kind: 'rule', title: 'Old rule', body: 'old\n' });
    const next = add({ kind: 'rule', title: 'New rule', body: 'new\n' });

    supersedeEntry(other, old.id, next.id);

    expect(findEntry(home, old.id)).toEqual({ ...old, status: 'superseded', updated: '2026-10-18T09:00:00Z' });
    expect(findEntry(home, next.id)).toEqual({ ...next, supersedes: [old.id], updated: '2026-10-18T09:00:00Z' });
    const lines = readLogSince(home, 0).lines.slice(2);
    expect(lines.map((l) => [l.id, l.event, l.status])).toEqual([
      [next.id, 'updated', 'active'],
      [old.id, 'status', 'superseded'],
    ]);
  });

  it('keeps earlier supersedes links', () => {
    const { home, other, add } = setup();
    const first = add({ kind: 'rule', title: 'First' });
    const second = add({ kind: 'rule', title: 'Second' });
    const third = add({ kind: 'rule', title: 'Third' });
    supersedeEntry(other, first.id, third.id);
    supersedeEntry(other, second.id, third.id);
    expect(findEntry(home, third.id).supersedes).toEqual([first.id, second.id]);
  });

  it('changes nothing when the replacement is unknown or the old entry is not active', () => {
    const { home, other, add } = setup();
    const old = add({ kind: 'rule', title: 'Old rule' });
    const next = add({ kind: 'rule', title: 'New rule' });
    expect(failure(() => supersedeEntry(other, old.id, 'rule-nope')).exitCode).toBe(EXIT.UNKNOWN_ID);
    expect(failure(() => supersedeEntry(other, old.id, old.id)).exitCode).toBe(EXIT.BAD_TRANSITION);
    revokeEntry(other, old.id, 'gone');
    expect(failure(() => supersedeEntry(other, old.id, next.id)).exitCode).toBe(EXIT.BAD_TRANSITION);
    expect(findEntry(home, next.id)).toEqual(next);
  });
});

describe.each(RUNNERS)('%s guard: supersede', (harness) => {
  const runner = (home: string, session: string | null) => runnerCtx(harness, home, session);

  const protectedKinds = [
    ['hold', { kind: 'hold', title: 'A hold', release: 'r' }],
    ['grant', { kind: 'grant', title: 'A grant', holder: 'x' }],
  ] as const;
  const otherKinds = [
    ['rule', { kind: 'rule', title: 'A rule' }],
    ['reference', { kind: 'reference', title: 'A reference' }],
    ['handoff', { kind: 'handoff', title: 'A handoff', to: 'any' }],
    ['request', { kind: 'request', title: 'A request', to: 'any' }],
  ] as const;

  it.each(protectedKinds)('refuses to supersede any %s, whether or not the worker authored it', (_kind, input) => {
    const { home, add } = setup();
    const old = add(input); // authored by claude-code/A
    const replacement = add({ kind: 'rule', title: 'Replacement' });
    for (const session of ['A', 'Z']) {
      const before = dump(home, [old, replacement]);
      const error = failure(() => supersedeEntry(runner(home, session), old.id, replacement.id));
      expect(error.exitCode).toBe(EXIT.NOT_PERMITTED);
      expect(error.message).toContain(old.id);
      expect(error.message).toMatch(/owner|interactive session/);
      expect(dump(home, [old, replacement])).toBe(before);
    }
  });

  it.each(otherKinds)("refuses to supersede another session's %s", (_kind, input) => {
    const { home, other, add } = setup();
    const foreign = createEntry(other, { scope: 'global', ...input }); // authored by pi/B
    const replacement = add({ kind: 'rule', title: 'Replacement' });
    const before = dump(home, [foreign, replacement]);
    const error = failure(() => supersedeEntry(runner(home, 'A'), foreign.id, replacement.id));
    expect(error.exitCode).toBe(EXIT.NOT_PERMITTED);
    expect(error.message).toContain(foreign.id);
    expect(dump(home, [foreign, replacement])).toBe(before);
  });

  it.each(otherKinds)('lets a worker supersede its own %s (session matches, harness does not)', (_kind, input) => {
    const { home, add } = setup();
    const old = add(input); // authored by claude-code/A
    const replacement = add({ kind: 'rule', title: 'Replacement' });
    const after = supersedeEntry(runner(home, 'A'), old.id, replacement.id);
    expect(findEntry(home, old.id).status).toBe('superseded');
    expect(after.supersedes).toEqual([old.id]);
    expect(readLogSince(home, 0).lines.slice(-2).map((line) => [line.id, line.event, line.status])).toEqual([
      [replacement.id, 'updated', 'active'],
      [old.id, 'status', 'superseded'],
    ]);
  });

  it('does not treat a null session as ownership', () => {
    const { home, add } = setup();
    const rule = add({ kind: 'rule', title: 'A rule' });
    const anonymous = createEntry(
      { home, cwd: tempDir(), now: LATER, identity: { harness: null, session: null, origin: 'agent-inferred' } },
      { kind: 'rule', scope: 'global', title: 'Anon' },
    );
    const replacement = add({ kind: 'rule', title: 'Replacement' });
    for (const entry of [rule, anonymous]) {
      expect(failure(() => supersedeEntry(runner(home, null), entry.id, replacement.id)).exitCode).toBe(EXIT.NOT_PERMITTED);
    }
  });

  it('does not judge the replacement by author, session or kind', () => {
    const { home, other, add } = setup();
    const old = add({ kind: 'rule', title: 'Old rule' }); // authored by claude-code/A
    const replacement = createEntry(other, { kind: 'hold', scope: 'global', title: 'Replacement hold', release: 'r' }); // pi/B
    const after = supersedeEntry(runner(home, 'A'), old.id, replacement.id);
    expect(after.id).toBe(replacement.id);
    expect(findEntry(home, old.id).status).toBe('superseded');
    expect(findEntry(home, replacement.id).supersedes).toEqual([old.id]);
  });

  it('refuses a forbidden old entry before resolving the replacement, writing nothing', () => {
    const { home, add } = setup();
    const hold = add({ kind: 'hold', title: 'A hold', release: 'r' });
    const before = dump(home, [hold]);
    const error = failure(() => supersedeEntry(runner(home, 'A'), hold.id, 'rule-nope'));
    expect(error.exitCode).toBe(EXIT.NOT_PERMITTED);
    expect(error.message).toContain(hold.id);
    expect(dump(home, [hold])).toBe(before);
  });
});

describe("bosun guard: the owner's words", () => {
  function bosunCtx(home: string): Ctx {
    return { home, cwd: tempDir(), now: LATER, identity: { harness: 'bosun', session: 'bosun-run', origin: 'agent-inferred' } };
  }
  function ownerSaid(home: string, input: NewEntry) {
    const user: Ctx = { home, cwd: tempDir(), now: CREATED, identity: { harness: 'user', session: 'U', origin: 'user-stated' } };
    return createEntry(user, { scope: 'global', ...input });
  }

  it.each([
    ['rule', { kind: 'rule', title: 'A rule' }],
    ['grant', { kind: 'grant', title: 'A grant', holder: 'x' }],
    ['hold', { kind: 'hold', title: 'A hold', release: 'r' }],
    ['reference', { kind: 'reference', title: 'A reference' }],
  ])('refuses to revoke a user-stated %s (exit 6) and writes nothing', (_kind, input) => {
    const { home } = setup();
    const entry = ownerSaid(home, input);
    const before = dump(home, [entry]);
    const error = failure(() => revokeEntry(bosunCtx(home), entry.id, 'fails the admission test'));
    expect(error.exitCode).toBe(EXIT.NOT_PERMITTED);
    expect(error.message).toContain(entry.id);
    expect(error.message).toMatch(/supersede/);
    expect(error.message).not.toContain('\n');
    expect(dump(home, [entry])).toBe(before);
  });

  it('still lets Bosun supersede a user-stated entry', () => {
    const { home } = setup();
    const old = ownerSaid(home, { kind: 'rule', title: 'Vague owner rule' });
    const replacement = createEntry(bosunCtx(home), { kind: 'rule', scope: 'global', title: 'Tightened owner rule' });
    supersedeEntry(bosunCtx(home), old.id, replacement.id);
    expect(findEntry(home, old.id).status).toBe('superseded');
  });

  it.each(['agent-inferred', 'mirrored'] as const)('lets Bosun revoke a %s entry', (origin) => {
    const { home } = setup();
    const ctx: Ctx = { home, cwd: tempDir(), now: CREATED, identity: { harness: 'claude-code', session: 'A', origin } };
    const entry = createEntry(ctx, { kind: 'rule', scope: 'global', title: 'Code fact' });
    expect(revokeEntry(bosunCtx(home), entry.id, 'derivable from the repo').status).toBe('revoked');
  });

  it.each(['claude-code', 'pi', 'funkyoctopus', 'user', null])('leaves harness %s free to revoke a user-stated entry', (harness) => {
    const { home } = setup();
    const entry = ownerSaid(home, { kind: 'rule', title: 'A rule' });
    const ctx: Ctx = { home, cwd: tempDir(), now: LATER, identity: { harness: harness as Harness | null, session: 'Z', origin: 'agent-inferred' } };
    expect(revokeEntry(ctx, entry.id, 'owner changed their mind').status).toBe('revoked');
  });
});
