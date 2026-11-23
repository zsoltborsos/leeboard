import { randomBytes } from 'node:crypto';
import YAML from 'yaml';

export const KINDS = ['rule', 'grant', 'hold', 'reference', 'handoff', 'request'] as const;
export type Kind = (typeof KINDS)[number];

/** `<kind>-<slug>-<suffix>`: the kind prefix lets a scan pick files by id alone (see `kindOfId`). */
export function makeId(kind: string, title: string, suffix = randomBytes(2).toString('hex')): string {
  return [kind, slugify(title), suffix].filter(Boolean).join('-');
}

function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
}

/** The kind an id was made for, from its prefix; null when no kind prefixes it. */
export function kindOfId(id: string): Kind | null {
  return KINDS.find((kind) => id.startsWith(`${kind}-`)) ?? null;
}

const ENTRY_ID = new RegExp(`(?<![A-Za-z0-9_-])(?:${KINDS.join('|')})-[a-z0-9]+(?:-[a-z0-9]+)*-[0-9a-f]{4}(?![A-Za-z0-9_-])`, 'g');

/** Complete, case-sensitive entry-id tokens in prose, unique and lexically sorted. */
export function entryIdsIn(text: string): string[] {
  return [...new Set([...text.matchAll(ENTRY_ID)].map((match) => match[0]))].sort();
}

export const STATUSES = ['active', 'released', 'revoked', 'superseded', 'done', 'retired', 'expired'] as const;
export type Status = (typeof STATUSES)[number];

export const HARNESSES = ['claude-code', 'pi', 'helmraiser', 'funkyoctopus', 'bosun', 'user'] as const;
export type Harness = (typeof HARNESSES)[number];

export const ORIGINS = ['user-stated', 'agent-inferred', 'mirrored'] as const;
export type Origin = (typeof ORIGINS)[number];

export interface Author {
  harness: Harness | null;
  session: string | null;
  origin: Origin;
}

/** One entry file: the frontmatter of design section 5.2 plus the markdown body. */
export interface Entry {
  id: string;
  kind: Kind;
  /** `global`, `machine` or `project:<name>`. */
  scope: string;
  status: Status;
  title: string;
  author: Author;
  /** ISO 8601 UTC, second precision. */
  created: string;
  updated: string;
  /** ISO date or date-time after which a hold/handoff stops being active. */
  until?: string;
  release?: string;
  blocks?: string[];
  holder?: string;
  to?: string;
  supersedes?: string[];
  source?: string;
  body: string;
}

/** Only mutable fields and the previous update stamp; identity stays on the entry. */
export type RevisionBefore = Pick<Entry, 'title' | 'body' | 'scope' | 'updated' | 'until' | 'release' | 'blocks' | 'holder' | 'to'>;

export interface RevisionRecord {
  ts: string;
  harness: Author['harness'];
  session: Author['session'];
  before: RevisionBefore;
}

export function serializeEntry(entry: Entry): string {
  return formatFrontmatter(
    {
      id: entry.id,
      kind: entry.kind,
      scope: entry.scope,
      status: entry.status,
      title: entry.title,
      author: {
        harness: entry.author.harness,
        session: entry.author.session,
        origin: entry.author.origin,
      },
      created: entry.created,
      updated: entry.updated,
      until: entry.until,
      release: entry.release,
      blocks: entry.blocks,
      holder: entry.holder,
      to: entry.to,
      supersedes: entry.supersedes,
      source: entry.source,
    },
    entry.body,
  );
}

/** `---`, YAML (lists inline, undefined keys omitted), `---`, then the body verbatim. */
export function formatFrontmatter(data: object, body: string): string {
  const doc = new YAML.Document(data);
  YAML.visit(doc, {
    Seq(_key, seq) {
      seq.flow = true;
    },
  });
  return `---\n${doc.toString({ lineWidth: 0, flowCollectionPadding: false })}---\n${body}`;
}

const FRONTMATTER = /^---\n([\s\S]*?)\n---(?:\n|$)([\s\S]*)$/;

export function parseFrontmatter(text: string): { data: Record<string, any>; body: string } {
  const match = FRONTMATTER.exec(text);
  if (!match) throw new Error('entry has no frontmatter');
  const data = YAML.parse(match[1]!) as Record<string, any> | null;
  if (data === null || typeof data !== 'object') throw new Error('entry frontmatter is not a mapping');
  return { data, body: match[2]! };
}

export function parseEntry(text: string): Entry {
  const { data, body } = parseFrontmatter(text);

  const entry: Entry = {
    id: required(data, 'id'),
    kind: oneOf(data, 'kind', KINDS),
    scope: required(data, 'scope'),
    status: oneOf(data, 'status', STATUSES),
    title: required(data, 'title'),
    author: {
      harness: data.author?.harness ?? null,
      session: data.author?.session === undefined || data.author.session === null ? null : String(data.author.session),
      origin: data.author?.origin ?? 'agent-inferred',
    },
    created: required(data, 'created'),
    updated: required(data, 'updated'),
    body,
  };
  for (const key of ['until', 'release', 'holder', 'to', 'source'] as const) {
    if (data[key] !== undefined) entry[key] = String(data[key]);
  }
  for (const key of ['blocks', 'supersedes'] as const) {
    if (data[key] !== undefined) entry[key] = (data[key] as unknown[]).map(String);
  }
  return entry;
}

function required(data: Record<string, any>, key: string): string {
  const value = data[key];
  if (value === undefined || value === null || value === '') throw new Error(`entry is missing ${key}`);
  return String(value);
}

function oneOf<T extends string>(data: Record<string, any>, key: string, allowed: readonly T[]): T {
  const value = required(data, key);
  if (!(allowed as readonly string[]).includes(value)) throw new Error(`entry has invalid ${key}: ${value}`);
  return value as T;
}

/**
 * Active = `status: active` and `until`, when present, has not passed. A date-only
 * `until` runs to the end of that UTC day. An unreadable `until` leaves the entry active.
 */
export function isActive(entry: Pick<Entry, 'status' | 'until'>, now: Date): boolean {
  if (entry.status !== 'active') return false;
  if (entry.until === undefined) return true;
  const end = /^\d{4}-\d{2}-\d{2}$/.test(entry.until) ? `${entry.until}T23:59:59.999Z` : entry.until;
  return !(now.getTime() > Date.parse(end));
}

/** Whole days untouched, only once the seven-day stale-hold threshold is reached. */
export function staleHoldDays(hold: Pick<Entry, 'updated'>, now: Date): number | undefined {
  const days = Math.floor((now.getTime() - Date.parse(hold.updated)) / 86_400_000);
  return days >= 7 ? days : undefined;
}

/** ISO 8601 UTC at second precision, e.g. `2026-10-17T14:02:11Z`. */
export function timestamp(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** Where a handoff or request is addressed: `project:<name>`, `session:<id>`, `harness:<name>` or `any`. */
export function isValidTarget(to: string): boolean {
  if (to === 'any') return true;
  const [type, ...rest] = to.split(':');
  const value = rest.join(':');
  if (type === 'project') return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value);
  if (type === 'session') return /^\S+$/.test(value);
  if (type === 'harness') return (HARNESSES as readonly string[]).includes(value);
  return false;
}

/** The entry without its body: what listings, the brief and JSON output carry. */
export interface Summary {
  id: string;
  kind: Kind;
  scope: string;
  status: Status;
  title: string;
  author: Author;
  created: string;
  updated: string;
  until?: string;
  release?: string;
  blocks?: string[];
  holder?: string;
  to?: string;
}

export function summarize(entry: Entry): Summary {
  const summary: Summary = {
    id: entry.id,
    kind: entry.kind,
    scope: entry.scope,
    status: entry.status,
    title: entry.title,
    author: { ...entry.author },
    created: entry.created,
    updated: entry.updated,
  };
  for (const key of ['until', 'release', 'blocks', 'holder', 'to'] as const) {
    if (entry[key] !== undefined) (summary as unknown as Record<string, unknown>)[key] = entry[key];
  }
  return summary;
}

/** Sort order for listings: most recently updated first, ties by id. */
export function newestFirst(a: Pick<Entry, 'id' | 'updated'>, b: Pick<Entry, 'id' | 'updated'>): number {
  return a.updated < b.updated ? 1 : a.updated > b.updated ? -1 : a.id < b.id ? -1 : 1;
}
