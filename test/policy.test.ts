import { describe, expect, it } from 'vitest';
import type { Author, Harness, Kind, Origin } from '../src/entry.js';
import { EXIT, LeeboardError } from '../src/errors.js';
import { type EntryAction, type PolicyAction, requirePermission, showsOwnerReview } from '../src/policy.js';

const harnesses = ['claude-code', 'pi', 'funkyoctopus', 'user', 'bosun', 'helmraiser', null] as const;
const ordinary = ['rule', 'reference', 'handoff', 'request'] as const;
const protectedKinds = ['hold', 'grant'] as const;
const edits = ['revoke', 'supersede', 'revise'] as const;
type Expected = Partial<Record<Harness, string>>;
const allowed: Expected = {};
const id = 'rule-policy-1234';
const workerRefusal = (action: string) =>
  `cannot ${action} ${id}: unattended runner workers (Helmraiser) are not permitted; ask the owner or use an interactive session`;
const bosunRefusal = `cannot revoke ${id}: Bosun may not revoke a user-stated entry; supersede it or flag it in the report`;

interface Row {
  name: string;
  request: PolicyAction;
  expected: Expected;
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

// Only refused harnesses are listed; all others (including no harness) are allowed.
// Expectations are data, independent of the production permission rules.
const cases: Row[] = [
  ...ordinary.map((kind) => entryRow('ordinary creation', 'create', kind, allowed)),
  ...protectedKinds.map((kind) => entryRow('protected creation', 'create', kind, {
    helmraiser: `Unattended runner workers (Helmraiser) cannot create a ${kind}; ask the owner or an interactive session (write a request instead)`,
  })),
  ...protectedKinds.flatMap((kind) => [
    entryRow('own protected release', 'release', kind, { helmraiser: workerRefusal('release') }),
    entryRow('foreign protected release', 'release', kind, { helmraiser: workerRefusal('release') },
      { authorSession: 'foreign', sameHarness: true }),
  ]),
  ...ordinary.map((kind) => entryRow('foreign nonprotected release (applicability is separate)', 'release', kind, allowed,
    { authorSession: 'foreign', sameHarness: true })),
  ...ordinary.flatMap((kind) => edits.flatMap((action) => [
    entryRow('same session, different harness', action, kind, allowed),
    entryRow('different session, same harness', action, kind, { helmraiser: workerRefusal(action) },
      { authorSession: 'foreign', sameHarness: true }),
    entryRow('null actor session', action, kind, { helmraiser: workerRefusal(action) },
      { session: null }),
    entryRow('both sessions null', action, kind, { helmraiser: workerRefusal(action) },
      { session: null, authorSession: null }),
  ])),
  ...protectedKinds.flatMap((kind) => edits.flatMap((action) => [
    entryRow('own protected edit', action, kind, { helmraiser: workerRefusal(action) }),
    entryRow('foreign protected edit', action, kind, { helmraiser: workerRefusal(action) },
      { authorSession: 'foreign', sameHarness: true }),
  ])),
  ...ordinary.flatMap((kind) => [
    entryRow('own user-stated revoke', 'revoke', kind, { bosun: bosunRefusal },
      { origin: 'user-stated' }),
    entryRow('foreign user-stated revoke', 'revoke', kind, { bosun: bosunRefusal, helmraiser: workerRefusal('revoke') },
      { origin: 'user-stated', authorSession: 'foreign', sameHarness: true }),
    entryRow('own user-stated supersede', 'supersede', kind, allowed, { origin: 'user-stated' }),
    entryRow('own user-stated revise', 'revise', kind, allowed, { origin: 'user-stated' }),
    entryRow('inferred entry, user-stated actor', 'revoke', kind, allowed, { actorOrigin: 'user-stated' }),
    entryRow('mirrored entry', 'revoke', kind, allowed, { origin: 'mirrored', actorOrigin: 'user-stated' }),
  ]),
  ...protectedKinds.flatMap((kind) => [
    entryRow('own user-stated protected revoke', 'revoke', kind, { bosun: bosunRefusal, helmraiser: workerRefusal('revoke') },
      { origin: 'user-stated' }),
    entryRow('foreign user-stated protected revoke', 'revoke', kind, { bosun: bosunRefusal, helmraiser: workerRefusal('revoke') },
      { origin: 'user-stated', authorSession: 'foreign', sameHarness: true }),
  ]),
  entryRow('foreign acknowledgement', 'ack', 'handoff', allowed, { authorSession: 'foreign' }),
  entryRow('foreign close', 'close', 'request', allowed, { authorSession: 'foreign' }),
  entryRow('foreign reply', 'reply', 'request', allowed, { authorSession: 'foreign' }),
  { name: 'purge', request: { action: 'purge' }, expected: {
    bosun: 'bosun may not purge entries; ask the owner or an interactive session',
    helmraiser: 'helmraiser may not purge entries; ask the owner or an interactive session',
  } },
  { name: 'project remove', request: { action: 'project-remove' }, expected: {
    bosun: 'bosun may not remove projects; ask the owner or an interactive session',
    helmraiser: 'helmraiser may not remove projects; ask the owner or an interactive session',
  } },
  { name: 'project rename', request: { action: 'project-rename' }, expected: {
    bosun: 'bosun may not rename projects; ask the owner or an interactive session',
    helmraiser: 'helmraiser may not rename projects; ask the owner or an interactive session',
  } },
];

describe.each(harnesses)('actor policy: harness %s', (harness) => {
  it.each(cases)('$name', ({ request, expected, session, sameHarness, actorOrigin }) => {
    const identity: Author = { harness, session: session === undefined ? 'own' : session, origin: actorOrigin ?? 'mirrored' };
    const result = harness === null ? undefined : expected[harness];
    // Ownership is deliberately tested across harnesses sharing a session.
    const otherHarness = harness === 'pi' ? 'user' : 'pi';
    const facts: PolicyAction = 'entry' in request
      ? { ...request, entry: { ...request.entry, author: {
          ...request.entry.author, harness: sameHarness ? harness : otherHarness,
        } } }
      : request;
    const check = () => requirePermission(identity, facts);
    if (result === undefined) {
      expect(check).not.toThrow();
      return;
    }
    let error: unknown;
    try {
      check();
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(LeeboardError);
    expect((error as LeeboardError).exitCode).toBe(EXIT.NOT_PERMITTED);
    expect((error as LeeboardError).exitCode).toBe(6);
    expect((error as LeeboardError).message).toBe(result);
  });
});

it.each<{ harness: Harness | null; expected: boolean }>([
  { harness: 'claude-code', expected: true },
  { harness: 'pi', expected: true },
  { harness: 'funkyoctopus', expected: true },
  { harness: 'user', expected: true },
  { harness: 'bosun', expected: false },
  { harness: 'helmraiser', expected: false },
  { harness: null, expected: false },
])('owner review visibility: harness $harness', ({ harness, expected }) => {
  const identity: Author = { harness, session: 'own', origin: 'mirrored' };
  expect(showsOwnerReview(identity)).toBe(expected);
});
