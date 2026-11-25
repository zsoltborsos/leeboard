import type { Ctx } from './context.js';
import { assertNoCredentials } from './credentials.js';
import { type Entry, isActive, isValidTarget, KINDS, type Kind, makeId, type RevisionBefore, type Status, timestamp } from './entry.js';
import { EXIT, LeeboardError } from './errors.js';
import { type LogEvent, type LogLine, logChange } from './log.js';
import { requirePermission } from './policy.js';
import { resolveProject } from './projects.js';
import { appendRevision, createEntryFile, findEntry, scopeDir, withRevisionLock, writeEntry } from './store.js';

// Every change to an entry goes through this module: creating it, moving it between
// statuses, and appending dated sections to its body. Callers name the change; this
// module decides whether it applies, whether the caller may make it, and rejects
// credential-like text before writing atomically and logging.

type Action = 'create' | 'release' | 'ack' | 'close' | 'reply' | 'revoke' | 'supersede' | 'revise' | 'expire';
type Heading = 'Released' | 'Reply' | 'Revoked' | 'Expired';

/**
 * The transitions: the kinds each change applies to (any kind when absent), the status it
 * leads to (unchanged when absent) and the section it appends. Every change needs an
 * active entry.
 */
const CHANGES: Record<Exclude<Action, 'create'>, { verb: string; kinds?: Kind[]; to?: Status; section?: Heading }> = {
  release: { verb: 'release', kinds: ['hold'], to: 'released', section: 'Released' },
  ack: { verb: 'ack', kinds: ['handoff'], to: 'done' },
  close: { verb: 'close', kinds: ['request'], to: 'done' },
  reply: { verb: 'reply to', kinds: ['request'], section: 'Reply' },
  revoke: { verb: 'revoke', to: 'revoked', section: 'Revoked' },
  supersede: { verb: 'supersede', to: 'superseded' },
  revise: { verb: 'revise' },
  expire: { verb: 'expire', kinds: ['hold', 'handoff'], to: 'expired', section: 'Expired' },
};

export interface NewEntry {
  kind: string;
  title: string;
  body?: string;
  /** `global`, `machine` or `project:<name>`; default is the resolved project, else global. */
  scope?: string;
  until?: string;
  release?: string;
  blocks?: string[];
  holder?: string;
  to?: string;
}

export type RevisionInput = Partial<Omit<NewEntry, 'kind'>>;

/** Exit 5 unless the entry is active and one of the kinds the change applies to. */
function requireApplies(entry: Entry, action: Exclude<Action, 'create'>): void {
  const { verb, kinds } = CHANGES[action];
  if (entry.status === 'active' && (!kinds || kinds.includes(entry.kind))) return;
  const wanted = kinds ? `an active ${kinds.join(' or ')}` : 'an active entry';
  throw new LeeboardError(
    `cannot ${verb} ${entry.id}: needs ${wanted} (it is a ${entry.kind}, status ${entry.status})`,
    EXIT.BAD_TRANSITION,
  );
}

function requireText(flag: string, text: string): string {
  if (text.trim() === '') throw new LeeboardError(`${flag} is required`, EXIT.USAGE);
  return text;
}

function usage(message: string): LeeboardError {
  return new LeeboardError(message, EXIT.USAGE);
}

function checkFieldCredentials(input: RevisionInput & { kind?: string }): void {
  assertNoCredentials({
    kind: input.kind, scope: input.scope, title: input.title, body: input.body,
    release: input.release, holder: input.holder, to: input.to,
    blocks: input.blocks?.join(','), until: input.until,
  });
}

/** Normalize only supplied fields: omission must never clear a revision field. */
function normalizeFields(input: RevisionInput): RevisionInput {
  const fields: RevisionInput = {};
  if (input.title !== undefined) fields.title = input.title.replace(/\s+/g, ' ').trim();
  if (input.body !== undefined) fields.body = input.body.trim() ? input.body.trimEnd() + '\n' : '';
  if (input.release !== undefined) fields.release = input.release.replace(/\s+/g, ' ').trim();
  if (input.holder !== undefined) fields.holder = input.holder.trim();
  if (input.scope !== undefined) fields.scope = input.scope;
  if (input.until !== undefined) fields.until = input.until;
  if (input.to !== undefined) fields.to = input.to;
  if (input.blocks !== undefined) fields.blocks = [...input.blocks];
  return fields;
}

function isISODate(value: string): boolean {
  const match = /^(\d{4}-\d{2}-\d{2})(?:T([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d))?$/.exec(value);
  if (!match || !Number.isFinite(Date.parse(value))) return false;
  const date = new Date(`${match[1]}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === match[1];
}

function validateFields(home: string, fields: NewEntry & { scope: string }): void {
  if (fields.title === '') throw usage('a title is required (--title)');
  if (fields.kind === 'hold' && !fields.release?.trim()) throw usage('a hold needs --release: when it ends');
  if (fields.kind === 'grant' && !fields.holder?.trim()) throw usage('a grant needs --holder');
  if (fields.kind === 'handoff' || fields.kind === 'request') {
    if (fields.to === undefined || !isValidTarget(fields.to)) {
      throw usage(`a ${fields.kind} needs --to project:<name>, session:<id>, harness:<name> or any`);
    }
  }
  if (fields.until !== undefined && !isISODate(fields.until)) {
    throw usage(`--until '${fields.until}' is not an ISO date`);
  }
  scopeDir(home, fields.scope);
}

/** `## Heading (timestamp, who)` and the text, if any: a dated, attributed section for the end of a body. */
function section(heading: Heading, stamp: string, who: string, text: string): string {
  const trimmed = text.trim();
  return `## ${heading} (${stamp}, ${who})\n${trimmed === '' ? '' : `${trimmed}\n`}`;
}

/** The text of the first section with this heading, as `section` wrote it; null when there is none. */
export function readSection(body: string, heading: Heading): string | null {
  const match = new RegExp(`(?:^|\\n)## ${heading} \\([^\\n]*\\)\\n([\\s\\S]*?)(?=\\n## |\\s*$)`).exec(body);
  return match ? match[1]!.trim() : null;
}

function append(body: string, addition: string): string {
  return body === '' ? addition : body.replace(/\n*$/, '\n\n') + addition;
}

/**
 * Apply a change the caller has checked: the new status, the section (commands sign it
 * `harness/session`; expiry, which no session asked for, signs it with the harness only),
 * then save. A dry run stops before the write.
 */
function apply(ctx: Ctx, entry: Entry, action: Exclude<Action, 'create'>, text = '', dryRun = false): Entry {
  const { to, section: heading } = CHANGES[action];
  if (to) entry.status = to;
  const harness = ctx.identity.harness ?? 'unknown';
  const who = action === 'expire' ? harness : `${harness}/${ctx.identity.session ?? 'unknown'}`;
  if (heading && (action === 'expire' || text.trim() !== '')) {
    entry.body = append(entry.body, section(heading, timestamp(ctx.now), who, text));
  }
  entry.updated = timestamp(ctx.now);
  if (!dryRun) save(ctx, entry, to ? 'status' : 'updated');
  return entry;
}

/** Atomic write, then the log line. */
function save(ctx: Ctx, entry: Entry, event: LogEvent, previousScope?: string, revision?: LogLine['revision']): void {
  writeEntry(ctx.home, entry, previousScope);
  logChange(ctx, entry, event, revision);
}

/** Validate, reject credentials, then write the entry atomically and log it. */
export function createEntry(ctx: Ctx, input: NewEntry): Entry {
  checkFieldCredentials(input);
  if (!(KINDS as readonly string[]).includes(input.kind)) {
    throw usage(`unknown kind '${input.kind}' (use ${KINDS.join(', ')})`);
  }
  const kind = input.kind as Kind;
  requirePermission(ctx.identity, { action: 'create', entry: { id: '', kind, author: ctx.identity } });
  const normalized = normalizeFields(input);
  const title = normalized.title!;
  const body = normalized.body ?? '';
  const release = normalized.release;
  const scope = input.scope ?? defaultScope(ctx);
  validateFields(ctx.home, { ...normalized, kind, title, scope });

  const stamp = timestamp(ctx.now);
  const entry: Entry = {
    id: makeId(kind, title),
    kind,
    scope,
    status: 'active',
    title,
    author: { ...ctx.identity },
    created: stamp,
    updated: stamp,
    body,
  };
  if (input.until !== undefined) entry.until = input.until;
  if (release) entry.release = release;
  if (input.blocks?.length) entry.blocks = input.blocks;
  if (input.holder) entry.holder = input.holder.trim();
  if (input.to !== undefined) entry.to = input.to;

  // A fresh random suffix on collision; five clashes in a row means something else is wrong.
  // Creation links without overwriting, so it does not need the mutation lock.
  let written = createEntryFile(ctx.home, entry);
  for (let attempt = 1; !written && attempt < 5; attempt++) {
    entry.id = makeId(kind, title);
    written = createEntryFile(ctx.home, entry);
  }
  if (!written) throw new Error(`could not allocate a unique id for '${title}'`);
  logChange(ctx, entry, 'created');
  return entry;
}

/** Revise an active entry in place, archiving its previous mutable fields first. */
export function reviseEntry(ctx: Ctx, idPrefix: string, input: RevisionInput): Entry {
  checkFieldCredentials(input);
  if (!Object.values(input).some((value) => value !== undefined)) throw usage('revise needs at least one mutable field');
  return withRevisionLock(ctx.home, () => {
    const entry = findEntry(ctx.home, idPrefix);
    requirePermission(ctx.identity, { action: 'revise', entry });
    requireApplies(entry, 'revise');
    const candidate: Entry = { ...entry, ...normalizeFields(input) };
    validateFields(ctx.home, candidate);
    const before: RevisionBefore = {
      title: entry.title, body: entry.body, scope: entry.scope, updated: entry.updated,
    };
    for (const key of ['until', 'release', 'holder', 'to'] as const) {
      if (entry[key] !== undefined) before[key] = entry[key];
    }
    if (entry.blocks !== undefined) before.blocks = [...entry.blocks];
    checkFieldCredentials(before); // Never copy hand-edited secrets into the archive.
    assertNoCredentials({ updated: before.updated });
    const fields = (['title', 'body', 'scope'] as const).filter((key) => candidate[key] !== entry[key]);
    const stamp = timestamp(ctx.now);
    const offset = appendRevision(ctx.home, entry.id, {
      ts: stamp, harness: ctx.identity.harness, session: ctx.identity.session, before,
    });
    candidate.updated = stamp;
    save(ctx, candidate, 'revised', entry.scope, { offset, fields });
    return candidate;
  });
}

function defaultScope(ctx: Ctx): string {
  const { project } = resolveProject(ctx.home, ctx.cwd);
  return project ? `project:${project}` : 'global';
}

/** Lifecycle lookup through persistence shares the revision gate, including scope moves. */
function transition(ctx: Ctx, idPrefix: string, action: 'release' | 'ack' | 'close' | 'reply' | 'revoke', text?: string): Entry {
  return withRevisionLock(ctx.home, () => {
    const entry = findEntry(ctx.home, idPrefix);
    requirePermission(ctx.identity, { action, entry });
    requireApplies(entry, action);
    return apply(ctx, entry, action, text);
  });
}

/** hold -> released; an optional note is appended to the body. */
export function releaseHold(ctx: Ctx, idPrefix: string, note?: string): Entry {
  assertNoCredentials({ note });
  return transition(ctx, idPrefix, 'release', note);
}

/** handoff -> done. */
export function ackHandoff(ctx: Ctx, idPrefix: string): Entry {
  return transition(ctx, idPrefix, 'ack');
}

/** request -> done. */
export function closeRequest(ctx: Ctx, idPrefix: string): Entry {
  return transition(ctx, idPrefix, 'close');
}

/** Append a reply section to an active request; it stays active. */
export function replyToRequest(ctx: Ctx, idPrefix: string, text: string): Entry {
  requireText('--body', text);
  assertNoCredentials({ reply: text });
  return transition(ctx, idPrefix, 'reply', text);
}

/** Any active entry -> revoked, with the reason appended to the body. */
export function revokeEntry(ctx: Ctx, idPrefix: string, reason: string): Entry {
  requireText('--reason', reason);
  assertNoCredentials({ reason });
  return transition(ctx, idPrefix, 'revoke', reason);
}

/** Old entry -> superseded; the replacement gains `supersedes: [old]`. Returns the replacement. */
export function supersedeEntry(ctx: Ctx, oldIdPrefix: string, newIdPrefix: string): Entry {
  return withRevisionLock(ctx.home, () => {
    const old = findEntry(ctx.home, oldIdPrefix);
    requirePermission(ctx.identity, { action: 'supersede', entry: old });
    const replacement = findEntry(ctx.home, newIdPrefix);
    if (old.id === replacement.id) {
      throw new LeeboardError(`cannot supersede ${old.id} by itself`, EXIT.BAD_TRANSITION);
    }
    requireApplies(old, 'supersede');
    replacement.supersedes = [...new Set([...(replacement.supersedes ?? []), old.id])];
    replacement.updated = timestamp(ctx.now);
    save(ctx, replacement, 'updated');
    apply(ctx, old, 'supersede');
    return replacement;
  });
}

/**
 * An active hold or handoff whose `until` has passed -> expired, with a bare Expired
 * section. Returns false, changing nothing, for any other entry. A dry run changes the
 * entry in memory only.
 */
export function expireLapsed(ctx: Ctx, entry: Entry, options: { dryRun?: boolean } = {}): boolean {
  const lapsed = (candidate: Entry) => candidate.status === 'active' && CHANGES.expire.kinds!.includes(candidate.kind) && !isActive(candidate, ctx.now);
  if (!lapsed(entry)) return false;
  if (options.dryRun) {
    apply(ctx, entry, 'expire', '', true);
    return true;
  }
  return withRevisionLock(ctx.home, () => {
    // Bosun collected this snapshot before the lock: scope, status or until may differ.
    Object.assign(entry, findEntry(ctx.home, entry.id));
    if (!lapsed(entry)) return false;
    apply(ctx, entry, 'expire');
    return true;
  });
}
