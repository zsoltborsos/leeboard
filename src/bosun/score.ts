import { type Entry, entryIdsIn } from '../entry.js';
import { readLogSince } from '../log.js';
import { createSuccessorResolver, listEntries, readEntry } from '../store.js';

/** Scoring key for a trial fixture (`trials/bosun/expected.json`). Ids are fixture entry ids. */
export interface Expected {
  /** Index lines per scope; default 40. */
  budget?: number;
  /** User-stated, correct, important: must stay active or be superseded by a user-stated entry. */
  protected: string[];
  /** Each group must end with exactly one surviving entry. */
  duplicates: { ids: string[]; note?: string }[];
  /** The loser must be superseded (or revoked) and the winner must survive. */
  decidable: { winner: string; loser: string; note?: string }[];
  /**
   * Every side stays active; the `core` ids (default: all of `ids`) are named in the report's
   * Contradictions section. A core that is a subset of `ids` lets a model that flags only the
   * directly contradicting pair of a larger cluster be right.
   */
  undecidable: { ids: string[]; core?: string[]; note?: string }[];
  /** Must end active in `scope`, either under its original id or through supersede. */
  rescope: { id: string; scope: string; note?: string }[];
  /** Agent-inferred entries failing the admission test: must be revoked. */
  retire: { id: string; note?: string }[];
  /** User-stated entries failing the admission test: must survive and be named in the report. */
  flag: { id: string; note?: string }[];
  /** Topic-style titles: the entry (or its replacement) must survive under a different title. */
  tighten?: { id: string; title: string; note?: string }[];
  /** The entry cites superseded `old`: it (or its replacement) must survive citing `current` and not `old`. */
  staleRefs?: { id: string; old: string; current: string; note?: string }[];
  /** Agent-written entries the run may fold or retire to meet the line budget; not scored, never churn. */
  expendable?: string[];
  mirror: {
    /** Path `<encoded-dir>/memory/<file>`: an active new entry must cite it, in one of `scopes`. */
    new: { path: string; scopes: string[]; note?: string }[];
    /** `entry` must be superseded by an entry that cites the note. */
    changed: { path: string; entry: string; note?: string }[];
    /** No new active entry may cite it. */
    skip: { path: string; note?: string }[];
    /** `entry` must survive, and no other new active entry may cite it. */
    represented: { path: string; entry: string; note?: string }[];
    /** A watermarked note that is gone: `entry`, written from it by an agent or mirror, must be retired. */
    deleted?: { path: string; entry: string; note?: string }[];
  };
}

export interface Metric {
  hit: number;
  n: number;
}

export interface RunScore {
  protectedKept: Metric;
  falseRetirements: string[];
  /** Pre-existing entries expected.json never mentions that the run superseded. */
  unaskedSuperseded: string[];
  /** Pre-existing entries expected.json never mentions that the run revoked. */
  unaskedRevoked: string[];
  unaskedEdits: number;
  unaskedRetirements: number;
  duplicates: Metric;
  decidable: Metric;
  undecidable: Metric;
  rescope: Metric;
  retire: Metric;
  flag: Metric;
  tighten: Metric;
  staleRefs: Metric;
  mirror: Metric & { new: Metric; changed: Metric; skip: Metric; represented: Metric; deleted: Metric };
  budget: { ok: boolean; overBudget: { scope: string; lines: number }[] };
  report: { present: boolean; wellFormed: boolean; missingSections: string[]; uncitedLines: number };
  /** 100 × weighted mean of the rates, minus the penalties for false retirements and unasked changes. */
  score: number;
  /** One line per expectation not met. */
  misses: string[];
}

export const REPORT_SECTIONS = [
  'Mirrored', 'Merged', 'Re-scoped', 'Tightened', 'Retired', 'Contradictions for the owner', 'Left alone with doubt',
] as const;

export const FALSE_RETIREMENT_PENALTY = 20;
export const UNASKED_SUPERSEDE_PENALTY = 2;
export const UNASKED_REVOKE_PENALTY = 10;
const INDEX_KINDS = new Set(['rule', 'grant', 'hold', 'reference']);
const ID = /\b(?:rule|grant|hold|reference|handoff|request)-[a-z0-9-]*[0-9a-f]{4}\b/;

/** Report body by section heading; headings are `## <name>`. */
function sections(report: string): Map<string, string[]> {
  const result = new Map<string, string[]>();
  let current: string[] | null = null;
  for (const line of report.split('\n')) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) {
      current = [];
      result.set(heading[1]!, current);
    } else if (current && line.trim() !== '') {
      current.push(line.trim());
    }
  }
  return result;
}

function fileOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/** The entry cites the note when a `Source:` line names the note's file. */
function cites(entry: Entry, path: string): boolean {
  const file = fileOf(path);
  return entry.body.split('\n').some((line) => /^\s*source:/i.test(line) && line.includes(file));
}

export function scoreRun(input: {
  baselineIds: Iterable<string>;
  baselineActiveIds?: Iterable<string>;
  entries: Entry[];
  report: string | null;
  expected: Expected;
}): RunScore {
  const { entries, expected } = input;
  const baseline = new Set(input.baselineIds);
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const resolveSuccessor = createSuccessorResolver(entries);
  const misses: string[] = [];
  const statusOf = (id: string) => byId.get(id)?.status ?? 'missing';

  const terminal = (id: string): Entry | null => resolveSuccessor(id).current;
  const count = <T>(items: T[], ok: (item: T) => boolean, miss: (item: T) => string): Metric => {
    let hit = 0;
    for (const item of items) {
      if (ok(item)) hit++;
      else misses.push(miss(item));
    }
    return { hit, n: items.length };
  };

  const parsed = input.report === null ? null : sections(input.report);
  const reportText = input.report ?? '';
  const contradictions = (parsed?.get('Contradictions for the owner') ?? []).join('\n');
  const newEntries = entries.filter((entry) => !baseline.has(entry.id) && entry.status === 'active');
  const citingNew = (path: string) => newEntries.filter((entry) => cites(entry, path));

  const falseRetirements: string[] = [];
  const protectedKept = count(
    expected.protected,
    (id) => terminal(id)?.author.origin === 'user-stated',
    (id) => {
      falseRetirements.push(id);
      const now = terminal(id);
      return now ? `protected ${id} was superseded by non-owner entry ${now.id}` : `protected ${id} is ${statusOf(id)}`;
    },
  );
  const duplicates = count(
    expected.duplicates,
    ({ ids }) => {
      const survivors = new Set(ids.map((id) => terminal(id)?.id ?? null));
      return survivors.size === 1 && !survivors.has(null);
    },
    ({ ids }) => `duplicates ${ids.join(', ')} do not end in one survivor`,
  );
  const decidable = count(
    expected.decidable,
    ({ winner, loser }) => {
      const kept = terminal(winner);
      return kept !== null && statusOf(loser) !== 'active' && (terminal(loser)?.id === kept.id || statusOf(loser) === 'revoked');
    },
    ({ winner, loser }) => `contradiction ${loser} (loser) vs ${winner} (winner) not resolved for the winner`,
  );
  const undecidable = count(
    expected.undecidable,
    ({ ids, core }) => ids.every((id) => statusOf(id) === 'active') && (core ?? ids).every((id) => contradictions.includes(id)),
    ({ ids }) => `undecidable ${ids.join(' vs ')} not left active and flagged in Contradictions`,
  );
  const rescope = count(
    expected.rescope,
    ({ id, scope }) => terminal(id)?.scope === scope,
    ({ id, scope }) => `${id} not re-scoped to ${scope}`,
  );
  const retire = count(
    expected.retire,
    ({ id }) => ['revoked', 'retired'].includes(statusOf(id)),
    ({ id }) => `${id} not retired (${statusOf(id)})`,
  );
  const flag = count(
    expected.flag,
    ({ id }) => terminal(id) !== null && reportText.includes(id),
    ({ id }) => `${id} not kept and flagged in the report`,
  );
  const tighten = count(
    expected.tighten ?? [],
    ({ id, title }) => {
      const now = terminal(id);
      return now !== null && now.title !== title;
    },
    ({ id }) => `${id} not tightened (topic title kept, or entry gone)`,
  );
  const staleRefs = count(
    expected.staleRefs ?? [],
    ({ id, old, current }) => {
      const now = terminal(id);
      return now !== null && entryIdsIn(now.body).includes(current) && !entryIdsIn(now.body).includes(old);
    },
    ({ id, old, current }) => `${id} still cites ${old} instead of ${current}`,
  );
  const mirrorNew = count(
    expected.mirror.new,
    ({ path, scopes }) => newEntries.some((entry) => cites(entry, path) && scopes.includes(entry.scope)),
    ({ path, scopes }) => `mirror: no new entry in ${scopes.join('|')} cites ${path}`,
  );
  const mirrorChanged = count(
    expected.mirror.changed,
    ({ path, entry }) => {
      const now = terminal(entry);
      return statusOf(entry) === 'superseded' && now !== null && cites(now, path);
    },
    ({ path, entry }) => `mirror: ${entry} not superseded by an entry citing ${path}`,
  );
  const mirrorSkip = count(
    expected.mirror.skip,
    ({ path }) => citingNew(path).length === 0,
    ({ path }) => `mirror: ${path} should have been skipped`,
  );
  const mirrorRepresented = count(
    expected.mirror.represented,
    ({ path, entry }) => {
      // A merge that carries the entry (and its Source line) forward is still one representation.
      const now = terminal(entry);
      return now !== null && citingNew(path).every((citing) => citing.id === now.id);
    },
    ({ path, entry }) => `mirror: ${path} is already represented by ${entry}`,
  );
  const mirrorDeleted = count(
    expected.mirror.deleted ?? [],
    ({ entry }) => ['revoked', 'retired'].includes(statusOf(entry)),
    ({ path, entry }) => `mirror: ${entry} not retired after ${path} was deleted (${statusOf(entry)})`,
  );
  const parts = [mirrorNew, mirrorChanged, mirrorSkip, mirrorRepresented, mirrorDeleted];
  const mirror = {
    hit: parts.reduce((sum, part) => sum + part.hit, 0),
    n: parts.reduce((sum, part) => sum + part.n, 0),
    new: mirrorNew,
    changed: mirrorChanged,
    skip: mirrorSkip,
    represented: mirrorRepresented,
    deleted: mirrorDeleted,
  };

  // Churn: entries that were active in the fixture, that expected.json never mentions (any id in
  // its text, notes included) and that the run took out of service. Without the active set it
  // is not measured.
  const activeBefore = input.baselineActiveIds === undefined ? new Set<string>() : new Set(input.baselineActiveIds);
  const keyText = JSON.stringify(expected);
  const unasked = (status: Entry['status']) =>
    entries
      .filter((entry) => baseline.has(entry.id) && activeBefore.has(entry.id) && entry.status === status && !keyText.includes(entry.id))
      .map((entry) => entry.id)
      .sort();
  const unaskedSuperseded = unasked('superseded');
  const unaskedRevoked = unasked('revoked');

  const budgetLimit = expected.budget ?? 40;
  const lines = new Map<string, number>();
  for (const entry of entries) {
    if (entry.status === 'active' && INDEX_KINDS.has(entry.kind)) lines.set(entry.scope, (lines.get(entry.scope) ?? 0) + 1);
  }
  const overBudget = [...lines].filter(([, n]) => n > budgetLimit).map(([scope, n]) => ({ scope, lines: n })).sort((a, b) => (a.scope < b.scope ? -1 : 1));
  for (const { scope, lines: n } of overBudget) misses.push(`budget: ${scope} has ${n} index lines`);

  const missingSections = REPORT_SECTIONS.filter((name) => !parsed?.has(name));
  let uncitedLines = 0;
  for (const [name, body] of parsed ?? []) {
    for (const line of body) {
      if (!line.startsWith('-')) continue;
      if (ID.test(line) || /^-\s*none\b/i.test(line) || (name === 'Mirrored' && /\.md\b/.test(line))) continue;
      uncitedLines++;
    }
  }
  const emptySection = REPORT_SECTIONS.some((name) => parsed?.has(name) && parsed.get(name)!.length === 0);
  const report = {
    present: parsed !== null,
    wellFormed: parsed !== null && missingSections.length === 0 && uncitedLines === 0 && !emptySection,
    missingSections: [...missingSections],
    uncitedLines,
  };
  if (!report.wellFormed) misses.push(parsed === null ? 'report: missing' : 'report: not well formed');

  const rates: [Metric | number, number][] = [
    [duplicates, 1], [decidable, 1], [undecidable, 1], [rescope, 1], [retire, 1], [flag, 1], [tighten, 1], [staleRefs, 1], [mirror, 1],
    [overBudget.length === 0 ? 1 : 0, 0.5], [report.wellFormed ? 1 : 0, 0.5],
  ];
  let weighted = 0;
  let weights = 0;
  for (const [value, weight] of rates) {
    if (typeof value !== 'number' && value.n === 0) continue;
    weighted += weight * (typeof value === 'number' ? value : value.hit / value.n);
    weights += weight;
  }
  const score = (weights === 0 ? 0 : (100 * weighted) / weights)
    - FALSE_RETIREMENT_PENALTY * falseRetirements.length
    - UNASKED_SUPERSEDE_PENALTY * unaskedSuperseded.length
    - UNASKED_REVOKE_PENALTY * unaskedRevoked.length;

  return {
    protectedKept, falseRetirements, unaskedSuperseded, unaskedRevoked,
    unaskedEdits: unaskedSuperseded.length, unaskedRetirements: unaskedRevoked.length, duplicates, decidable, undecidable, rescope, retire, flag, tighten, staleRefs, mirror,
    budget: { ok: overBudget.length === 0, overBudget }, report, score, misses,
  };
}

export function loadStoreEntries(home: string): Entry[] {
  return listEntries(home);
}

export interface Summary {
  mean: number;
  /** Sample standard deviation; null for fewer than two values. */
  sd: number | null;
  n: number;
}

/** Per model, in first-seen order: mean, sample sd and n of every metric, skipping null values. */
export function aggregate(runs: { model: string; values: Record<string, number | null> }[]): {
  model: string;
  n: number;
  metrics: Record<string, Summary>;
}[] {
  const models = new Map<string, { model: string; values: Record<string, number | null> }[]>();
  for (const run of runs) models.set(run.model, [...(models.get(run.model) ?? []), run]);
  return [...models].map(([model, group]) => {
    const metrics: Record<string, Summary> = {};
    for (const key of new Set(group.flatMap((run) => Object.keys(run.values)))) {
      const values = group.map((run) => run.values[key]).filter((value): value is number => typeof value === 'number');
      if (values.length === 0) continue;
      const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
      const sd = values.length < 2 ? null : Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1));
      metrics[key] = { mean, sd, n: values.length };
    }
    return { model, n: group.length, metrics };
  });
}

/** An `lb review`-style list of what one run changed, from the log lines with its session. */
export function renderRunDiff(home: string, session: string): string {
  const out: string[] = [`# Changes by ${session}`, ''];
  const { lines } = readLogSince(home, 0);
  const latestScope = new Map(lines.map((line) => [line.id, line.scope]));
  for (const line of lines) {
    if (line.session !== session) continue;
    const entry = readEntry(home, latestScope.get(line.id)!, line.id);
    const what = line.event === 'status' ? line.status : line.event;
    const origin = entry?.author.origin ?? 'unknown';
    out.push(`- ${what} [${line.id}] ${line.kind} ${line.scope} (${origin}): ${entry?.title ?? '(entry missing)'}`);
    if (line.event === 'created' && entry) {
      if (entry.supersedes?.length) out.push(`  supersedes: ${entry.supersedes.join(', ')}`);
      for (const text of entry.body.trimEnd().split('\n')) out.push(`  > ${text}`);
    }
  }
  if (out.length === 2) out.push('none');
  return out.join('\n') + '\n';
}
