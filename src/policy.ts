import type { Author, Entry, Harness } from './entry.js';
import { EXIT, LeeboardError } from './errors.js';

export type PolicyEntry = Pick<Entry, 'id' | 'kind' | 'author'>;

export type PolicyAction =
  | {
      action: 'create' | 'release' | 'ack' | 'close' | 'reply' | 'revoke' | 'supersede' | 'revise' | 'expire';
      entry: PolicyEntry;
    }
  | { action: 'purge' | 'project-remove' | 'project-rename' };

const NO_STORE_CHANGES: readonly Harness[] = ['bosun', 'helmraiser'];
const OWNER_REVIEW: readonly Harness[] = ['claude-code', 'pi', 'funkyoctopus', 'user'];

/** Decide actor permissions only; callers still validate applicability and perform changes. */
export function requirePermission(identity: Author, request: PolicyAction): void {
  const { action } = request;
  if (action === 'purge' || action === 'project-remove' || action === 'project-rename') {
    const harness = identity.harness;
    if (harness !== null && NO_STORE_CHANGES.includes(harness)) {
      const operation = { purge: 'purge entries', 'project-remove': 'remove projects', 'project-rename': 'rename projects' }[action];
      throw new LeeboardError(`${harness} may not ${operation}; ask the owner or an interactive session`, EXIT.NOT_PERMITTED);
    }
    return;
  }

  const { entry } = request;
  const protectedKind = entry.kind === 'hold' || entry.kind === 'grant';
  const unattendedRunner = identity.harness === 'helmraiser';
  if (action === 'create') {
    // Holds and grants gate and authorise work, so an unattended worker never places them.
    if (unattendedRunner && protectedKind) {
      throw new LeeboardError(
        `Unattended runner workers (Helmraiser) cannot create a ${entry.kind}; ask the owner or an interactive session (write a request instead)`,
        EXIT.NOT_PERMITTED,
      );
    }
    return;
  }
  if (identity.harness === 'bosun' && action === 'revoke' && entry.author.origin === 'user-stated') {
    throw new LeeboardError(
      `cannot revoke ${entry.id}: Bosun may not revoke a user-stated entry; supersede it or flag it in the report`,
      EXIT.NOT_PERMITTED,
    );
  }
  if (!unattendedRunner || !(action === 'release' || action === 'revoke' || action === 'supersede' || action === 'revise')) return;

  const ownsEntry = identity.session !== null && entry.author.session === identity.session;
  if (protectedKind || (action !== 'release' && !ownsEntry)) {
    throw new LeeboardError(
      `cannot ${action} ${entry.id}: unattended runner workers (Helmraiser) are not permitted; ask the owner or use an interactive session`,
      EXIT.NOT_PERMITTED,
    );
  }
}

/** Anonymous and unattended callers do not see the owner's review digest. */
export function showsOwnerReview(identity: Author): boolean {
  return identity.harness !== null && OWNER_REVIEW.includes(identity.harness);
}
