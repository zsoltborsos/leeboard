import { describe, expect, it } from 'vitest';
import type { Author, Harness, Kind, Origin } from '../src/entry.js';
import { EXIT, LeeboardError } from '../src/errors.js';
import { type PolicyAction, requirePermission, showsOwnerReview } from '../src/policy.js';

const harnesses = ['claude-code', 'pi', 'funkyoctopus', 'user', 'bosun', 'helmraiser', null] as const;
// Each author differs from the corresponding actor, even when they share a session.
const otherHarnesses: readonly Harness[] = ['pi', 'user', 'pi', 'pi', 'pi', 'pi', 'pi'];
const ordinary = ['rule', 'reference', 'handoff', 'request'] as const;
const protectedKinds = ['hold', 'grant'] as const;
const edits = ['revoke', 'supersede', 'revise'] as const;
type EntryAction = Extract<PolicyAction, { entry: unknown }>['action'];
type Expected = readonly [string | null, string | null, string | null, string | null, string | null, string | null, string | null];
const allowed: Expected = [null, null, null, null, null, null, null];
const id = 'rule-policy-1234';
const workerRefusal = (action: string) =>
  `cannot ${action} ${id}: unattended runner workers (Helmraiser) are not permitted; ask the owner or use an interactive session`;
const bosunRefusal = `cannot revoke ${id}: Bosun may not revoke a user-stated entry; supersede it or flag it in the report`;

interface Row {
  name: string;
  request: PolicyAction | 'owner-review';
  expected: Expected | readonly [boolean, boolean, boolean, boolean, boolean, boolean, boolean];
  session?: string | null;
  sameHarness?: boolean;
  actorOrigin?: Origin;
}

function entryRow(
  name: string, action: EntryAction, kind: Kind, expected: Expected,
  options: { session?: string | null; authorSession?: string | null; origin?: Origin; sameHarness?: boolean; actorOrigin?: Origin } = {},
): Row {
  return {
    name: `${name}: ${action} ${kind}`,
    request: { action, entry: { id, kind, author: {
      harness: 'pi', session: options.authorSession === undefined ? 'own' : options.authorSession,
      origin: options.origin ?? 'agent-inferred',
    } } },
    expected,
    session: options.session === undefined ? 'own' : options.session,
    sameHarness: options.sameHarness,
    actorOrigin: options.actorOrigin,
  };
}

// Columns: claude-code, pi, funkyoctopus, user, bosun, helmraiser, no harness.
// Expectations are data, independent of the production permission rules.
const cases: Row[] = [
  ...ordinary.map((kind) => entryRow('ordinary creation', 'create', kind, allowed)),
  ...protectedKinds.map((kind) => entryRow('protected creation', 'create', kind,
    [null, null, null, null, null,
      `Unattended runner workers (Helmraiser) cannot create a ${kind}; ask the owner or an interactive session (write a request instead)`, null])),
  ...protectedKinds.flatMap((kind) => [
    entryRow('own protected release', 'release', kind, [null, null, null, null, null, workerRefusal('release'), null]),
    entryRow('foreign protected release', 'release', kind, [null, null, null, null, null, workerRefusal('release'), null],
      { authorSession: 'foreign', sameHarness: true }),
  ]),
  ...ordinary.map((kind) => entryRow('foreign nonprotected release (applicability is separate)', 'release', kind, allowed,
    { authorSession: 'foreign', sameHarness: true })),
  ...ordinary.flatMap((kind) => edits.flatMap((action) => [
    entryRow('same session, different harness', action, kind, allowed),
    entryRow('different session, same harness', action, kind, [null, null, null, null, null, workerRefusal(action), null],
      { authorSession: 'foreign', sameHarness: true }),
    entryRow('null actor session', action, kind, [null, null, null, null, null, workerRefusal(action), null],
      { session: null }),
    entryRow('both sessions null', action, kind, [null, null, null, null, null, workerRefusal(action), null],
      { session: null, authorSession: null }),
  ])),
  ...protectedKinds.flatMap((kind) => edits.flatMap((action) => [
    entryRow('own protected edit', action, kind, [null, null, null, null, null, workerRefusal(action), null]),
    entryRow('foreign protected edit', action, kind, [null, null, null, null, null, workerRefusal(action), null],
      { authorSession: 'foreign', sameHarness: true }),
  ])),
  ...ordinary.flatMap((kind) => [
    entryRow('own user-stated revoke', 'revoke', kind, [null, null, null, null, bosunRefusal, null, null],
      { origin: 'user-stated' }),
    entryRow('foreign user-stated revoke', 'revoke', kind, [null, null, null, null, bosunRefusal, workerRefusal('revoke'), null],
      { origin: 'user-stated', authorSession: 'foreign', sameHarness: true }),
    entryRow('own user-stated supersede', 'supersede', kind, allowed, { origin: 'user-stated' }),
    entryRow('own user-stated revise', 'revise', kind, allowed, { origin: 'user-stated' }),
    entryRow('inferred entry, user-stated actor', 'revoke', kind, allowed, { actorOrigin: 'user-stated' }),
    entryRow('mirrored entry', 'revoke', kind, allowed, { origin: 'mirrored', actorOrigin: 'user-stated' }),
  ]),
  ...protectedKinds.flatMap((kind) => [
    entryRow('own user-stated protected revoke', 'revoke', kind, [null, null, null, null, bosunRefusal, workerRefusal('revoke'), null],
      { origin: 'user-stated' }),
    entryRow('foreign user-stated protected revoke', 'revoke', kind, [null, null, null, null, bosunRefusal, workerRefusal('revoke'), null],
      { origin: 'user-stated', authorSession: 'foreign', sameHarness: true }),
  ]),
  entryRow('foreign acknowledgement', 'ack', 'handoff', allowed, { authorSession: 'foreign' }),
  entryRow('foreign close', 'close', 'request', allowed, { authorSession: 'foreign' }),
  entryRow('foreign reply', 'reply', 'request', allowed, { authorSession: 'foreign' }),
  entryRow('protected expiry', 'expire', 'hold', allowed, { authorSession: 'foreign' }),
  entryRow('handoff expiry', 'expire', 'handoff', allowed, { authorSession: 'foreign' }),
  { name: 'purge', request: { action: 'purge' }, expected: [null, null, null, null,
    'bosun may not purge entries; ask the owner or an interactive session',
    'helmraiser may not purge entries; ask the owner or an interactive session', null] },
  { name: 'project remove', request: { action: 'project-remove' }, expected: [null, null, null, null,
    'bosun may not remove projects; ask the owner or an interactive session',
    'helmraiser may not remove projects; ask the owner or an interactive session', null] },
  { name: 'project rename', request: { action: 'project-rename' }, expected: [null, null, null, null,
    'bosun may not rename projects; ask the owner or an interactive session',
    'helmraiser may not rename projects; ask the owner or an interactive session', null] },
  { name: 'owner review visibility', request: 'owner-review', expected: [true, true, true, true, false, false, false] },
];

describe.each(harnesses)('actor policy: harness %s', (harness) => {
  const column = harnesses.indexOf(harness);
  it.each(cases)('$name', ({ request, expected, session, sameHarness, actorOrigin }) => {
    const identity: Author = { harness, session: session === undefined ? 'own' : session, origin: actorOrigin ?? 'mirrored' };
    const result = expected[column];
    if (request === 'owner-review') {
      expect(showsOwnerReview(identity)).toBe(result);
      return;
    }
    const facts: PolicyAction = 'entry' in request
      ? { ...request, entry: { ...request.entry, author: {
          ...request.entry.author, harness: sameHarness ? harness : otherHarnesses[column]!,
        } } }
      : request;
    const check = () => requirePermission(identity, facts);
    if (result === null) {
      expect(check).not.toThrow();
    } else {
      expect(check).toThrow(LeeboardError);
      expect(check).toThrow(result as string);
      try {
        check();
      } catch (error) {
        expect(error).toBeInstanceOf(LeeboardError);
        expect((error as LeeboardError).exitCode).toBe(EXIT.NOT_PERMITTED);
        expect((error as LeeboardError).exitCode).toBe(6);
        expect((error as LeeboardError).message).toBe(result);
      }
    }
  });
});
