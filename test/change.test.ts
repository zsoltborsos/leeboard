import { describe, expect, it } from 'vitest';
import {
  ackHandoff,
  closeRequest,
  createEntry,
  type NewEntry,
  readSection,
  releaseHold,
  replyToRequest,
  revokeEntry,
  supersedeEntry,
} from '../src/change.js';
import type { Ctx } from '../src/context.js';
import { type Harness, KINDS, type Kind, kindOfId, makeId, type Origin } from '../src/entry.js';
import { LeeboardError } from '../src/errors.js';
import { findEntry } from '../src/store.js';
import { tempDir } from './helpers.js';

const NOW = new Date('2026-10-18T09:00:00Z');

describe('makeId', () => {
  it('is <kind>-<slug>-<suffix>', () => {
    expect(makeId('hold', 'Helmraiser: no runs!', '00ab')).toBe('hold-helmraiser-no-runs-00ab');
  });

  it('slugs the title: lowercase, non-alphanumerics to dashes, trimmed', () => {
    expect(makeId('rule', '  No Helmraiser runs: Webshop prod tunnel open!  ', '00ab')).toBe(
      'rule-no-helmraiser-runs-webshop-prod-tunnel-o-00ab',
    );
  });

  it('keeps at most 40 slug characters and does not end the slug on a dash', () => {
    // The 40th character of the full slug is the dash after "into".
    expect(makeId('rule', 'Set pipefail before chaining tests into git commit', '00ab')).toBe(
      'rule-set-pipefail-before-chaining-tests-into-00ab',
    );
    expect(makeId('rule', 'x'.repeat(60), '00ab')).toBe(`rule-${'x'.repeat(40)}-00ab`);
  });

  it('defaults to a random 4 hex suffix', () => {
    expect(makeId('rule', 'Use pipefail')).toMatch(/^rule-use-pipefail-[0-9a-f]{4}$/);
  });

  it('drops an empty slug rather than leaving a double dash', () => {
    expect(makeId('rule', '日本語', '00ab')).toBe('rule-00ab');
  });
});

describe('kindOfId', () => {
  it.each(KINDS)('reads %s back from an id made for it', (kind) => {
    expect(kindOfId(makeId(kind, 'Some title'))).toBe(kind);
  });

  it.each(['note-x-0001', 'holder-x-0001', 'hold', 'Hold-x-0001', ''])('is null for %j', (id) => {
    expect(kindOfId(id)).toBeNull();
  });
});

type Action = 'create' | 'release' | 'ack' | 'close' | 'reply' | 'revoke' | 'supersede';

const fields: Record<Kind, NewEntry> = {
  rule: { kind: 'rule', title: 'A rule' },
  grant: { kind: 'grant', title: 'A grant', holder: 'x' },
  hold: { kind: 'hold', title: 'A hold', release: 'r' },
  reference: { kind: 'reference', title: 'A reference' },
  handoff: { kind: 'handoff', title: 'A handoff', to: 'any' },
  request: { kind: 'request', title: 'A request', to: 'any' },
};

/**
 * `actor` (session W) makes `action` on a fresh `kind` entry written by session `W` (own)
 * or `A` (other) with `origin`. Returns the exit code: 0 when the change was allowed.
 */
function attempt(actor: Harness | null, action: Action, kind: Kind, owner: 'own' | 'other', origin: Origin = 'agent-inferred'): number {
  const home = tempDir();
  const ctx = (harness: Harness | null, session: string, as: Origin): Ctx => ({
    home, cwd: tempDir('lb-cwd-'), now: NOW, identity: { harness, session, origin: as },
  });
  const author = ctx('claude-code', owner === 'own' ? 'W' : 'A', origin);
  const worker = ctx(actor, 'W', 'agent-inferred');
  try {
    if (action === 'create') {
      createEntry(worker, { scope: 'global', ...fields[kind] });
      return 0;
    }
    const id = createEntry(author, { scope: 'global', ...fields[kind] }).id;
    if (action === 'release') releaseHold(worker, id);
    if (action === 'ack') ackHandoff(worker, id);
    if (action === 'close') closeRequest(worker, id);
    if (action === 'reply') replyToRequest(worker, id, 'ok');
    if (action === 'revoke') revokeEntry(worker, id, 'why');
    if (action === 'supersede') supersedeEntry(worker, id, createEntry(author, { scope: 'global', ...fields.rule }).id);
    return 0;
  } catch (error) {
    if (!(error instanceof LeeboardError)) throw error;
    return error.exitCode;
  }
}

describe('permission matrix', () => {
  const ALLOWED = 0;
  const REFUSED = 6;
  it.each([
    // Unattended runners (Helmraiser): no creating or touching holds and grants;
    // only their own entries to revoke or supersede.
    ['helmraiser', 'create', 'hold', 'own', 'agent-inferred', REFUSED],
    ['helmraiser', 'create', 'grant', 'own', 'agent-inferred', REFUSED],
    ['helmraiser', 'create', 'rule', 'own', 'agent-inferred', ALLOWED],
    ['helmraiser', 'create', 'request', 'own', 'agent-inferred', ALLOWED],
    ['helmraiser', 'release', 'hold', 'own', 'agent-inferred', REFUSED],
    ['helmraiser', 'release', 'hold', 'other', 'agent-inferred', REFUSED],
    ['helmraiser', 'revoke', 'rule', 'own', 'agent-inferred', ALLOWED],
    ['helmraiser', 'revoke', 'rule', 'other', 'agent-inferred', REFUSED],
    ['helmraiser', 'revoke', 'hold', 'own', 'agent-inferred', REFUSED],
    ['helmraiser', 'revoke', 'grant', 'own', 'agent-inferred', REFUSED],
    ['helmraiser', 'supersede', 'reference', 'own', 'agent-inferred', ALLOWED],
    ['helmraiser', 'supersede', 'reference', 'other', 'agent-inferred', REFUSED],
    ['helmraiser', 'supersede', 'grant', 'own', 'agent-inferred', REFUSED],
    ['helmraiser', 'ack', 'handoff', 'other', 'agent-inferred', ALLOWED],
    ['helmraiser', 'close', 'request', 'other', 'agent-inferred', ALLOWED],
    ['helmraiser', 'reply', 'request', 'other', 'agent-inferred', ALLOWED],
    // Bosun: may not revoke the owner's words, may supersede them.
    ['bosun', 'revoke', 'rule', 'other', 'user-stated', REFUSED],
    ['bosun', 'revoke', 'rule', 'other', 'agent-inferred', ALLOWED],
    ['bosun', 'revoke', 'rule', 'other', 'mirrored', ALLOWED],
    ['bosun', 'supersede', 'rule', 'other', 'user-stated', ALLOWED],
    ['bosun', 'create', 'hold', 'own', 'agent-inferred', ALLOWED],
    ['bosun', 'release', 'hold', 'other', 'user-stated', ALLOWED],
    // Everyone else is unrestricted.
    ['pi', 'revoke', 'rule', 'other', 'user-stated', ALLOWED],
    ['pi', 'release', 'hold', 'other', 'user-stated', ALLOWED],
    ['pi', 'create', 'grant', 'own', 'agent-inferred', ALLOWED],
    ['claude-code', 'revoke', 'grant', 'other', 'user-stated', ALLOWED],
    ['user', 'supersede', 'hold', 'other', 'user-stated', ALLOWED],
    [null, 'revoke', 'hold', 'other', 'user-stated', ALLOWED],
  ] as const)('%s %s on a %s (%s, %s) exits %i', (actor, action, kind, owner, origin, expected) => {
    expect(attempt(actor, action, kind, owner, origin)).toBe(expected);
  });
});

describe('readSection', () => {
  function setup() {
    const home = tempDir();
    const ctx: Ctx = { home, cwd: tempDir('lb-cwd-'), now: NOW, identity: { harness: 'pi', session: 'B', origin: 'agent-inferred' } };
    return { home, ctx };
  }

  it('reads back a multi-line Revoked reason followed by another section', () => {
    const { home, ctx } = setup();
    const reason = 'Owner: no longer wanted.\nSee the review.\n\nThird line after a gap.';
    const revoked = revokeEntry(ctx, createEntry(ctx, { scope: 'global', kind: 'rule', title: 'Old', body: 'Why.' }).id, `  ${reason}\n`);
    expect(readSection(revoked.body, 'Revoked')).toBe(reason);

    // A second writer-made section after it: reuse that body for a request, then reply.
    const request = createEntry(ctx, { scope: 'global', kind: 'request', title: 'Q', to: 'any', body: revoked.body });
    const replied = replyToRequest(ctx, request.id, 'First.\nSecond.');
    expect(findEntry(home, request.id).body).toBe(
      `Why.\n\n## Revoked (2026-10-18T09:00:00Z, pi/B)\n${reason}\n\n## Reply (2026-10-18T09:00:00Z, pi/B)\nFirst.\nSecond.\n`,
    );
    expect(readSection(replied.body, 'Revoked')).toBe(reason);
    expect(readSection(replied.body, 'Reply')).toBe('First.\nSecond.');
  });

  it('reads an empty section as empty text and a missing one as null', () => {
    expect(readSection('## Expired (2026-10-18T09:00:00Z, bosun)\n', 'Expired')).toBe('');
    expect(readSection('Body only.\n', 'Revoked')).toBeNull();
    expect(readSection('Mentions ## Revoked (x) inline.\n', 'Revoked')).toBeNull();
  });
});
