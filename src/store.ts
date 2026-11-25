import { randomBytes } from 'node:crypto';
import { appendFileSync, closeSync, existsSync, fstatSync, linkSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { type Entry, HARNESSES, parseEntry, type RevisionRecord, serializeEntry } from './entry.js';
import { EXIT, LeeboardError } from './errors.js';

export const PROJECT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const LOCK_STALE_MS = 10_000;
const LOCK_WAIT_MS = 15_000;
const LOCK_POLL_MS = 10;

/** `LEEBOARD_HOME`, else `~/.leeboard`. */
export function resolveHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.LEEBOARD_HOME || join(homedir(), '.leeboard');
}

/** Create the store layout. Safe to repeat; never overwrites an existing log or .gitignore. */
export function initStore(home: string): void {
  for (const dir of ['global/entries', 'machine/entries', 'projects', 'state']) {
    mkdirSync(join(home, dir), { recursive: true });
  }
  writeFileSync(join(home, 'log.jsonl'), '', { flag: 'a' });
  if (!existsSync(join(home, '.gitignore'))) writeFileSync(join(home, '.gitignore'), 'state/\n');
}

/** Write via a temp file in the same directory, then rename, so readers never see a partial file. */
export function writeFileAtomic(path: string, content: string): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.${basename(path)}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`);
  try {
    writeFileSync(tmp, content, { flag: 'wx' });
    renameSync(tmp, path);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
}

/** `global`, `machine` or `project:<name>` -> the directory holding that scope's entry files. */
export function scopeDir(home: string, scope: string): string {
  if (scope === 'global' || scope === 'machine') return join(home, scope, 'entries');
  const name = scope.startsWith('project:') ? scope.slice('project:'.length) : '';
  if (PROJECT_NAME.test(name)) return join(home, 'projects', name, 'entries');
  throw new LeeboardError(`invalid scope '${scope}' (use global, machine or project:<name>)`, EXIT.USAGE);
}

export function allScopes(home: string): string[] {
  let projects: string[] = [];
  try {
    projects = readdirSync(join(home, 'projects')).filter((name) => PROJECT_NAME.test(name));
  } catch {
    // no projects yet
  }
  return ['global', 'machine', ...projects.sort().map((name) => `project:${name}`)];
}

function entryFiles(home: string, scope: string): string[] {
  try {
    return readdirSync(scopeDir(home, scope)).filter((name) => name.endsWith('.md') && !name.startsWith('.'));
  } catch {
    return [];
  }
}

export function writeEntry(home: string, entry: Entry, previousScope?: string): void {
  writeFileAtomic(join(scopeDir(home, entry.scope), `${entry.id}.md`), serializeEntry(entry));
  if (previousScope !== undefined && previousScope !== entry.scope) {
    rmSync(join(scopeDir(home, previousScope), `${entry.id}.md`));
  }
}

/** Acquisition time, falling back to directory mtime for missing or damaged ownership data. */
function lockTime(lock: string, mtime: number): number {
  try {
    const { ts } = JSON.parse(readFileSync(join(lock, 'owner.json'), 'utf8'));
    const time = typeof ts === 'number' ? ts : typeof ts === 'string' ? Date.parse(ts) : NaN;
    return Number.isFinite(time) ? time : mtime;
  } catch {
    return mtime;
  }
}

/**
 * Claim recovery inside this directory before renaming it. A losing waiter cannot
 * rename a newly acquired lock after the winner removes the old one. If a reaper
 * itself dies, a later reaper can claim inside its aged marker instead.
 */
function claimRecovery(lock: string, now: number): boolean {
  let claim = join(lock, '.recovering');
  while (true) {
    try {
      mkdirSync(claim);
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return false;
      if (code !== 'EEXIST') throw error;
      try {
        if (now - statSync(claim).mtimeMs <= LOCK_STALE_MS) return false;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw error;
      }
      claim = join(claim, '.recovering');
    }
  }
}

function recoverStaleLock(lock: string): boolean {
  try {
    const before = statSync(lock);
    const now = Date.now();
    if (now - lockTime(lock, before.mtimeMs) <= LOCK_STALE_MS || !claimRecovery(lock, now)) return false;
    const current = statSync(lock);
    // Recheck identity after claiming: the old directory may already have been replaced.
    if (current.dev !== before.dev || current.ino !== before.ino || current.birthtimeMs !== before.birthtimeMs) return false;
    const retired = `${lock}.stale-${randomBytes(8).toString('hex')}`;
    renameSync(lock, retired);
    rmSync(retired, { recursive: true });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true; // Another writer/reaper won; retry mkdir.
    throw error;
  }
}

/**
 * Serialize revisions and lifecycle mutations from lookup through persistence,
 * including scope moves and both entries in a supersede. Creation stays lock-free.
 * Recover locks older than ten seconds using owner.json's acquisition ts (or directory
 * mtime for unreadable/missing ownership data), never PID liveness across namespaces.
 * One reaper claims and renames the stale directory before removing it; losers retry.
 * Fresh locks are waited on, with a bounded wait long enough to recover an abandoned one.
 */
export function withRevisionLock<T>(home: string, change: () => T): T {
  const dir = join(home, 'state');
  mkdirSync(dir, { recursive: true });
  const lock = join(dir, 'revision.lock');
  const deadline = performance.now() + LOCK_WAIT_MS;
  const wait = new Int32Array(new SharedArrayBuffer(4));
  while (true) {
    try {
      mkdirSync(lock);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (recoverStaleLock(lock)) continue;
      if (performance.now() >= deadline) throw new Error(`timed out waiting for ${lock}`);
      Atomics.wait(wait, 0, 0, LOCK_POLL_MS);
    }
  }
  try {
    writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, ts: new Date().toISOString() }) + '\n');
    return change();
  } finally {
    rmSync(lock, { recursive: true });
  }
}

/**
 * History is lazy, git-tracked, append-only, and not subject to the change log's size
 * limit. Call under withRevisionLock, including the snapshot read, to keep offsets exact.
 */
export function appendRevision(home: string, id: string, record: RevisionRecord): number {
  const dir = join(home, 'revisions');
  mkdirSync(dir, { recursive: true });
  const fd = openSync(join(dir, `${id}.jsonl`), 'a');
  try {
    const offset = fstatSync(fd).size;
    appendFileSync(fd, JSON.stringify(record) + '\n', 'utf8');
    return offset;
  } finally {
    closeSync(fd);
  }
}

/** Read exactly one complete record at a byte boundary; damaged history is non-fatal. */
export function readRevision(home: string, id: string, offset: number): RevisionRecord | null {
  if (!Number.isSafeInteger(offset) || offset < 0) return null;
  let fd: number | undefined;
  try {
    fd = openSync(join(home, 'revisions', `${id}.jsonl`), 'r');
    const chunk = Buffer.alloc(4096);
    if (offset > 0 && (readSync(fd, chunk, 0, 1, offset - 1) !== 1 || chunk[0] !== 10)) return null;
    const parts: Buffer[] = [];
    let position = offset;
    while (true) {
      const count = readSync(fd, chunk, 0, chunk.length, position);
      if (count === 0) return null;
      const end = chunk.subarray(0, count).indexOf(10);
      parts.push(Buffer.from(chunk.subarray(0, end < 0 ? count : end)));
      if (end >= 0) break;
      position += count;
    }
    const record = JSON.parse(Buffer.concat(parts).toString('utf8')) as RevisionRecord;
    if (!record || typeof record.ts !== 'string' ||
      !(record.harness === null || HARNESSES.includes(record.harness)) ||
      !(record.session === null || typeof record.session === 'string')) return null;
    const before = record.before;
    if (!before || !['title', 'body', 'scope', 'updated'].every((key) => typeof before[key as keyof typeof before] === 'string')) return null;
    if (!['until', 'release', 'holder', 'to'].every((key) => {
      const value = before[key as keyof typeof before];
      return value === undefined || typeof value === 'string';
    })) return null;
    if (before.blocks !== undefined && (!Array.isArray(before.blocks) || !before.blocks.every((item) => typeof item === 'string'))) return null;
    return record;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * Write a new entry only if no file with its id exists yet. Linking the complete temp file
 * into place is atomic and fails on an existing name, so a colliding id never overwrites.
 * Returns false on a collision.
 */
export function createEntryFile(home: string, entry: Entry): boolean {
  const path = join(scopeDir(home, entry.scope), `${entry.id}.md`);
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.${basename(path)}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`);
  try {
    writeFileSync(tmp, serializeEntry(entry), { flag: 'wx' });
    linkSync(tmp, path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  } finally {
    rmSync(tmp, { force: true });
  }
}

/**
 * Every readable entry in the given scopes (default: all) whose id passes `idFilter`
 * (checked on the file name, before parsing). Unreadable files are skipped.
 */
export function listEntries(
  home: string,
  scopes: string[] = allScopes(home),
  idFilter: (id: string) => boolean = () => true,
): Entry[] {
  return listEntriesWithDiagnostics(home, scopes, idFilter).entries;
}

export interface UnreadableEntryFile {
  path: string;
  scope: string;
  error: string;
}

/** The same tolerant scan as `listEntries`, including individual read/parse failures. */
export function listEntriesWithDiagnostics(
  home: string,
  scopes: string[] = allScopes(home),
  idFilter: (id: string) => boolean = () => true,
): { entries: Entry[]; unreadable: UnreadableEntryFile[] } {
  const entries: Entry[] = [];
  const unreadable: UnreadableEntryFile[] = [];
  for (const scope of scopes) {
    for (const file of entryFiles(home, scope)) {
      if (!idFilter(file.slice(0, -'.md'.length))) continue;
      const path = join(scopeDir(home, scope), file);
      try {
        entries.push(parseEntry(readFileSync(path, 'utf8')));
      } catch (error) {
        unreadable.push({ path, scope, error: error instanceof Error ? error.message : String(error) });
      }
    }
  }
  return { entries, unreadable };
}

export interface SuccessorResolution {
  successors: Entry[];
  /** No reachable active entry: missing, closed or cyclic chains resolve to null. */
  current: Entry | null;
  /** Selected active/closed endpoint or first failed branch's end; null if no entry or successor was found. */
  chainEnd: Pick<Entry, 'id' | 'status'> | null;
}

/** Index reverse supersedes links once, in input order, without reading or changing the store. */
export function createSuccessorResolver(entries: readonly Entry[]): (id: string) => SuccessorResolution {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const successors = new Map<string, Entry[]>();
  for (const entry of entries) {
    for (const old of new Set(entry.supersedes ?? [])) {
      const direct = successors.get(old) ?? [];
      if (!direct.some((next) => next.id === entry.id)) direct.push(entry);
      successors.set(old, direct);
    }
  }

  const terminal = (id: string, seen: Set<string>): Entry | null => {
    const entry = byId.get(id);
    if (!entry) return null;
    // A repeated entry names the cycle; a superseded leaf names the missing successor.
    if (entry.status !== 'superseded' || seen.has(id)) return entry;
    seen.add(id);
    let firstEnd: Entry | null = null;
    for (const next of successors.get(id) ?? []) {
      const found = terminal(next.id, seen);
      if (found?.status === 'active') return found;
      firstEnd ??= found;
    }
    return firstEnd ?? entry;
  };
  return (id) => {
    const end = terminal(id, new Set());
    const direct = successors.get(id) ?? [];
    return {
      successors: direct,
      current: end?.status === 'active' ? end : null,
      chainEnd: end && (end.status !== 'superseded' || direct.length > 0) ? { id: end.id, status: end.status } : null,
    };
  };
}

/** The entry `id` in `scope`, or null if it is missing or unreadable. */
export function readEntry(home: string, scope: string, id: string): Entry | null {
  try {
    return parseEntry(readFileSync(join(scopeDir(home, scope), `${id}.md`), 'utf8'));
  } catch {
    return null;
  }
}

/** The entry whose id equals `idPrefix`, or that it is the unique prefix of. Exit 4 otherwise. */
export function findEntry(home: string, idPrefix: string): Entry {
  const candidates = allScopes(home).flatMap((scope) =>
    entryFiles(home, scope).map((file) => ({ scope, id: file.slice(0, -'.md'.length) })),
  );
  const exact = candidates.filter((candidate) => candidate.id === idPrefix);
  let matches = exact.length > 0 ? exact : candidates.filter((candidate) => candidate.id.startsWith(idPrefix));
  // Sessions quote an entry by its four-character hash, the id's last segment.
  if (matches.length === 0 && /^[0-9a-f]{4}$/.test(idPrefix)) {
    matches = candidates.filter((candidate) => candidate.id.endsWith(`-${idPrefix}`));
  }
  if (matches.length === 0) throw new LeeboardError(`no entry matches '${idPrefix}'`, EXIT.UNKNOWN_ID);
  if (matches.length > 1) {
    const ids = matches.map((match) => match.id).sort();
    throw new LeeboardError(`'${idPrefix}' is ambiguous: ${ids.join(', ')}`, EXIT.UNKNOWN_ID);
  }
  const { scope, id } = matches[0]!;
  return parseEntry(readFileSync(join(scopeDir(home, scope), `${id}.md`), 'utf8'));
}
