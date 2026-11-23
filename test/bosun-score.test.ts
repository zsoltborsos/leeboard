import { describe, expect, it } from 'vitest';
import { appendLog } from '../src/log.js';
import { aggregate, type Expected, REPORT_SECTIONS, renderRunDiff, scoreRun } from '../src/bosun/score.js';
import { createEntry, reviseEntry } from '../src/change.js';
import type { Ctx } from '../src/context.js';
import type { Entry } from '../src/entry.js';
import { initStore, writeEntry } from '../src/store.js';
import { sampleEntry, tempDir } from './helpers.js';

const owner = { harness: 'user' as const, session: 'U', origin: 'user-stated' as const };
const agent = { harness: 'claude-code' as const, session: 'A', origin: 'agent-inferred' as const };
const bosunAuthor = (origin: 'user-stated' | 'agent-inferred' | 'mirrored' = 'agent-inferred') => ({ harness: 'bosun' as const, session: 'bosun-run', origin });

/** The fixture before the run. Ids end in 4 hex digits, like real ids. */
function baseline(): Entry[] {
  return [
    sampleEntry({ id: 'rule-protected-a-0001', author: owner }),
    sampleEntry({ id: 'rule-protected-b-0002', author: owner }),
    sampleEntry({ id: 'rule-dup-one-0003', author: owner }),
    sampleEntry({ id: 'rule-dup-two-0004', author: agent }),
    sampleEntry({ id: 'rule-near-one-0005', author: agent }),
    sampleEntry({ id: 'rule-near-two-0006', author: agent }),
    sampleEntry({ id: 'rule-winner-0007', author: owner }),
    sampleEntry({ id: 'rule-loser-0008', author: agent }),
    sampleEntry({ id: 'rule-undecided-a-0009', author: owner }),
    sampleEntry({ id: 'rule-undecided-b-000a', author: owner }),
    sampleEntry({ id: 'rule-misplaced-000b', author: agent }),
    sampleEntry({ id: 'reference-code-fact-000c', kind: 'reference', author: agent }),
    sampleEntry({ id: 'rule-owner-plan-000d', author: owner }),
    sampleEntry({ id: 'reference-figma-budget-000e', kind: 'reference', scope: 'project:webshop', author: agent }),
    sampleEntry({ id: 'rule-pipefail-000f', author: agent }),
    // Not in expected.json: nobody asked for these to change.
    sampleEntry({ id: 'rule-bystander-a-0010', author: agent }),
    sampleEntry({ id: 'rule-bystander-b-0011', author: owner }),
    sampleEntry({ id: 'rule-bystander-c-0012', author: agent }),
    sampleEntry({ id: 'rule-undecided-c-0013', author: owner }), // third side of a cluster, in no base group
  ];
}

const expected: Expected = {
  budget: 40,
  protected: ['rule-protected-a-0001', 'rule-protected-b-0002'],
  duplicates: [{ ids: ['rule-dup-one-0003', 'rule-dup-two-0004'] }, { ids: ['rule-near-one-0005', 'rule-near-two-0006'] }],
  decidable: [{ winner: 'rule-winner-0007', loser: 'rule-loser-0008' }],
  undecidable: [{ ids: ['rule-undecided-a-0009', 'rule-undecided-b-000a'] }],
  rescope: [{ id: 'rule-misplaced-000b', scope: 'project:blog' }],
  retire: [{ id: 'reference-code-fact-000c' }],
  flag: [{ id: 'rule-owner-plan-000d' }],
  mirror: {
    new: [{ path: '-mnt-p-webshop/memory/release-notes.md', scopes: ['project:webshop'] }],
    changed: [{ path: '-mnt-p-webshop/memory/figma-mcp-call-budget.md', entry: 'reference-figma-budget-000e' }],
    skip: [{ path: '-mnt-p-webshop/memory/expo-plan.md' }],
    represented: [{ path: '-mnt-p-helmraiser/memory/pipefail-before-commit.md', entry: 'rule-pipefail-000f' }],
  },
};

const report = (contradictions: string, extra = '') => [
  '## Mirrored',
  '- -mnt-p-webshop/release-notes.md — new rule-release-notes-1001',
  '- -mnt-p-webshop/expo-plan.md — skipped: plan',
  '## Merged', '- rule-dup-one-0003 ← rule-dup-two-0004',
  '## Re-scoped', '- rule-misplaced-000b → rule-blog-1002',
  '## Tightened', 'none',
  '## Retired', '- reference-code-fact-000c — code fact',
  '## Contradictions for the owner', contradictions,
  '## Left alone with doubt', '- rule-owner-plan-000d — a plan, but the owner said it' + extra,
].join('\n');

/** Apply changes to a copy of the baseline: status overrides and new entries. */
function after(status: Record<string, Entry['status']>, added: Entry[], supersedes: Record<string, string[]> = {}): Entry[] {
  return [
    ...baseline().map((entry) => ({ ...entry, status: status[entry.id] ?? entry.status, supersedes: supersedes[entry.id] ?? entry.supersedes })),
    ...added,
  ];
}

const ids = baseline().map((entry) => entry.id);

describe('trial scorer', () => {
  it('scores a same-id active rescope and protects an owner-authored tightened entry', () => {
    const entries = baseline().map((entry) => entry.id === 'rule-misplaced-000b'
      ? { ...entry, scope: 'project:blog' }
      : entry.id === 'rule-protected-a-0001' ? { ...entry, title: 'Tightened owner words' } : entry);
    const text = REPORT_SECTIONS.map((section) => `## ${section}\n${section === 'Re-scoped'
      ? '- rule-misplaced-000b — moved from global to project:blog'
      : section === 'Tightened' ? '- rule-protected-a-0001 — clarified wording' : 'none'}`).join('\n');
    const score = scoreRun({ baselineIds: ids, entries, report: text, expected });
    expect(score.rescope).toEqual({ hit: 1, n: 1 });
    expect(score.protectedKept).toEqual({ hit: 2, n: 2 });
    expect(score.falseRetirements).toEqual([]);
    expect(score.report).toEqual({ present: true, wellFormed: true, missingSections: [], uncitedLines: 0 });
  });

  it.each([
    ['active', 'global'], ['revoked', 'project:blog'],
  ] as const)('rejects rescope with status %s in %s', (status, scope) => {
    const entries = baseline().map((entry) => entry.id === 'rule-misplaced-000b' ? { ...entry, status, scope } : entry);
    expect(scoreRun({ baselineIds: ids, entries, report: null, expected }).rescope).toEqual({ hit: 0, n: 1 });
  });
  it('scores a perfect run at 100', () => {
    const entries = after(
      {
        'rule-dup-two-0004': 'superseded', 'rule-near-one-0005': 'superseded', 'rule-near-two-0006': 'superseded',
        'rule-loser-0008': 'superseded', 'rule-misplaced-000b': 'superseded', 'reference-code-fact-000c': 'revoked',
        'reference-figma-budget-000e': 'superseded',
      },
      [
        sampleEntry({ id: 'rule-near-merged-1000', author: bosunAuthor(), supersedes: ['rule-near-one-0005', 'rule-near-two-0006'] }),
        sampleEntry({ id: 'rule-release-notes-1001', scope: 'project:webshop', author: bosunAuthor('user-stated'), body: 'Why.\nSource: claude-memory -mnt-p-webshop/release-notes.md\n' }),
        sampleEntry({ id: 'rule-blog-1002', scope: 'project:blog', author: bosunAuthor(), supersedes: ['rule-misplaced-000b'] }),
        sampleEntry({ id: 'reference-figma-40-1003', kind: 'reference', scope: 'project:webshop', author: bosunAuthor('mirrored'), supersedes: ['reference-figma-budget-000e'], body: 'Source: claude-memory -mnt-p-webshop/figma-mcp-call-budget.md\n' }),
      ],
      { 'rule-dup-one-0003': ['rule-dup-two-0004'], 'rule-winner-0007': ['rule-loser-0008'] },
    );
    const score = scoreRun({ baselineIds: ids, entries, report: report('- rule-undecided-a-0009 vs rule-undecided-b-000a — which one?'), expected });
    expect(score.falseRetirements).toEqual([]);
    for (const key of ['protectedKept', 'duplicates', 'decidable', 'undecidable', 'rescope', 'retire', 'flag'] as const) {
      expect(score[key].hit, key).toBe(score[key].n);
    }
    expect(score.mirror).toMatchObject({ hit: 4, n: 4, new: { hit: 1, n: 1 }, changed: { hit: 1, n: 1 }, skip: { hit: 1, n: 1 }, represented: { hit: 1, n: 1 } });
    expect(score.budget).toEqual({ ok: true, overBudget: [] });
    expect(score.report).toEqual({ present: true, wellFormed: true, missingSections: [], uncitedLines: 0 });
    expect(score.score).toBe(100);
    expect(score.misses).toEqual([]);
  });

  it('scores an idle run (nothing changed, no report) low, with no false retirements', () => {
    const score = scoreRun({ baselineIds: ids, entries: baseline(), report: null, expected });
    expect(score.falseRetirements).toEqual([]);
    expect(score.duplicates).toEqual({ hit: 0, n: 2 });
    expect(score.decidable).toEqual({ hit: 0, n: 1 });
    expect(score.undecidable).toEqual({ hit: 0, n: 1 }); // active but not flagged
    expect(score.flag).toEqual({ hit: 0, n: 1 });
    expect(score.mirror).toMatchObject({ new: { hit: 0, n: 1 }, changed: { hit: 0, n: 1 }, skip: { hit: 1, n: 1 }, represented: { hit: 1, n: 1 } });
    expect(score.report).toEqual({ present: false, wellFormed: false, missingSections: [...REPORT_SECTIONS], uncitedLines: 0 });
    expect(score.score).toBeGreaterThan(0);
    expect(score.score).toBeLessThan(30);
  });

  it('counts a revoked or wrongly superseded protected entry as a false retirement, at 20 points each', () => {
    const entries = after(
      { 'rule-protected-a-0001': 'revoked', 'rule-protected-b-0002': 'superseded' },
      [sampleEntry({ id: 'rule-reworded-1004', author: bosunAuthor('agent-inferred'), supersedes: ['rule-protected-b-0002'] })],
    );
    const base = scoreRun({ baselineIds: ids, entries: baseline(), report: null, expected });
    const score = scoreRun({ baselineIds: ids, entries, report: null, expected });
    expect(score.falseRetirements).toEqual(['rule-protected-a-0001', 'rule-protected-b-0002']);
    expect(score.protectedKept).toEqual({ hit: 0, n: 2 });
    expect(score.score).toBeCloseTo(base.score - 40, 6);
    expect(score.misses).toContain('protected rule-protected-a-0001 is revoked');
  });

  it('accepts a protected entry superseded by a user-stated replacement', () => {
    const entries = after(
      { 'rule-protected-a-0001': 'superseded' },
      [sampleEntry({ id: 'rule-tightened-1005', author: bosunAuthor('user-stated'), supersedes: ['rule-protected-a-0001'] })],
    );
    expect(scoreRun({ baselineIds: ids, entries, report: null, expected }).falseRetirements).toEqual([]);
  });

  it('protects an owner-authored replacement through two hops', () => {
    const old = 'rule-protected-a-0001';
    const middle = sampleEntry({ id: 'rule-middle-1000', status: 'superseded', supersedes: [old] });
    const current = sampleEntry({ id: 'rule-current-1001', author: owner, supersedes: [middle.id] });
    const entries = after({ [old]: 'superseded' }, [middle, current]);
    expect(scoreRun({ baselineIds: ids, entries, report: null, expected }).protectedKept).toEqual({ hit: 2, n: 2 });
  });

  it.each(['revoked', 'cycle'] as const)('rejects a protected chain ending in %s but tries a later valid branch', (end) => {
    const old = 'rule-protected-a-0001';
    const broken = sampleEntry({ id: 'rule-broken-1000', status: end === 'revoked' ? 'revoked' : 'superseded', supersedes: [old] });
    const entries = after({ [old]: 'superseded' }, [broken], end === 'cycle' ? { [old]: [broken.id] } : {});
    expect(scoreRun({ baselineIds: ids, entries, report: null, expected }).falseRetirements).toEqual([old]);
    entries.push(sampleEntry({ id: 'rule-valid-1001', author: owner, supersedes: [old] }));
    expect(scoreRun({ baselineIds: ids, entries, report: null, expected }).falseRetirements).toEqual([]);
  });

  it.each([true, false])('selects the first active branch, owner-first: %s', (ownerFirst) => {
    const old = 'rule-protected-a-0001';
    const ownerEntry = sampleEntry({ id: 'rule-owner-1000', author: owner, supersedes: [old] });
    const agentEntry = sampleEntry({ id: 'rule-agent-1001', author: agent, supersedes: [old] });
    const entries = after({ [old]: 'superseded' }, ownerFirst ? [ownerEntry, agentEntry] : [agentEntry, ownerEntry]);
    expect(scoreRun({ baselineIds: ids, entries, report: null, expected }).falseRetirements).toEqual(ownerFirst ? [] : [old]);
  });

  it('does not count a decidable contradiction resolved the wrong way, or a duplicate pair with two survivors', () => {
    const entries = after(
      { 'rule-winner-0007': 'superseded' },
      [sampleEntry({ id: 'rule-dup-three-1006', author: bosunAuthor(), supersedes: ['rule-dup-one-0003'] })],
      { 'rule-loser-0008': ['rule-winner-0007'] },
    );
    const score = scoreRun({ baselineIds: ids, entries, report: null, expected });
    expect(score.decidable.hit).toBe(0);
    expect(score.duplicates.hit).toBe(0); // dup-one -> dup-three, dup-two still active on its own
  });

  it('needs every side of an undecidable contradiction active and named in the Contradictions section', () => {
    const named = report('- rule-undecided-a-0009 vs rule-undecided-b-000a — which?');
    const elsewhere = report('none', ' (also rule-undecided-a-0009 vs rule-undecided-b-000a)');
    expect(scoreRun({ baselineIds: ids, entries: baseline(), report: named, expected }).undecidable.hit).toBe(1);
    expect(scoreRun({ baselineIds: ids, entries: baseline(), report: elsewhere, expected }).undecidable.hit).toBe(0);
    const resolved = after({ 'rule-undecided-b-000a': 'superseded' }, [], { 'rule-undecided-a-0009': ['rule-undecided-b-000a'] });
    expect(scoreRun({ baselineIds: ids, entries: resolved, report: named, expected }).undecidable.hit).toBe(0);
  });

  it('accepts a core pair of a larger undecidable cluster when every side is still active', () => {
    const cluster: Expected = {
      ...expected,
      undecidable: [{ ids: ['rule-undecided-a-0009', 'rule-undecided-b-000a', 'rule-undecided-c-0013'], core: ['rule-undecided-a-0009', 'rule-undecided-b-000a'] }],
    };
    const pair = report('- rule-undecided-a-0009 vs rule-undecided-b-000a — which one?');
    const run = (entries: Entry[], text: string | null) => scoreRun({ baselineIds: ids, entries, report: text, expected: cluster }).undecidable;
    expect(run(baseline(), pair)).toEqual({ hit: 1, n: 1 });
    // The third side is not required in the report ...
    expect(run(baseline(), report('- rule-undecided-a-0009 vs rule-undecided-b-000a vs rule-undecided-c-0013 — which one?'))).toEqual({ hit: 1, n: 1 });
    // ... but every core id is, and a core id named outside the section does not count.
    expect(run(baseline(), report('- rule-undecided-a-0009 vs rule-undecided-c-0013 — which one?'))).toEqual({ hit: 0, n: 1 });
    expect(run(baseline(), report('none', ' (rule-undecided-a-0009 vs rule-undecided-b-000a)'))).toEqual({ hit: 0, n: 1 });
    // Every id of the cluster must still be active, core or not.
    const resolved = after({ 'rule-undecided-c-0013': 'superseded' }, [], { 'rule-undecided-a-0009': ['rule-undecided-c-0013'] });
    expect(run(resolved, pair)).toEqual({ hit: 0, n: 1 });
  });

  it('scores mirror decisions: a skipped plan that became an entry, a represented note duplicated, a new note in the wrong scope', () => {
    const entries = after({}, [
      sampleEntry({ id: 'rule-expo-1007', scope: 'project:webshop', author: bosunAuthor('mirrored'), body: 'Source: claude-memory -mnt-p-webshop/expo-plan.md\n' }),
      sampleEntry({ id: 'rule-pipefail-again-1008', author: bosunAuthor('mirrored'), body: 'Source: claude-memory -mnt-p-helmraiser/pipefail-before-commit.md\n' }),
      sampleEntry({ id: 'rule-release-notes-1009', scope: 'global', author: bosunAuthor('user-stated'), body: 'Source: claude-memory -mnt-p-webshop/release-notes.md\n' }),
    ]);
    const score = scoreRun({ baselineIds: ids, entries, report: null, expected });
    expect(score.mirror).toMatchObject({ hit: 0, n: 4, new: { hit: 0 }, changed: { hit: 0 }, skip: { hit: 0 }, represented: { hit: 0 } });
  });

  it('accepts a represented note carried forward by a merge that keeps its Source line', () => {
    const entries = after({ 'rule-pipefail-000f': 'superseded' }, [
      sampleEntry({ id: 'rule-pipefail-merged-100a', author: bosunAuthor(), supersedes: ['rule-pipefail-000f'], body: 'Source: claude-memory helmraiser/pipefail-before-commit.md\n' }),
    ]);
    expect(scoreRun({ baselineIds: ids, entries, report: null, expected }).mirror.represented).toEqual({ hit: 1, n: 1 });
  });

  it('reports scopes over the line budget, counting only active index kinds', () => {
    const crowd = Array.from({ length: 41 }, (_, i) => sampleEntry({ id: `rule-crowd-${i}-2000`, scope: 'project:p', author: agent }));
    const inbox = Array.from({ length: 5 }, (_, i) => sampleEntry({ id: `handoff-h-${i}-3000`, kind: 'handoff', to: 'any', scope: 'project:q', author: agent }));
    const score = scoreRun({ baselineIds: ids, entries: [...baseline(), ...crowd, ...inbox], report: null, expected: { ...expected, budget: 40 } });
    expect(score.budget).toEqual({ ok: false, overBudget: [{ scope: 'project:p', lines: 41 }] });
  });

  it('flags a report with missing sections or bullet lines that cite no id', () => {
    const bad = report('- the two undecided rules disagree').replace('## Tightened\nnone\n', '');
    const score = scoreRun({ baselineIds: ids, entries: baseline(), report: bad, expected });
    expect(score.report).toEqual({ present: true, wellFormed: false, missingSections: ['Tightened'], uncitedLines: 1 });
  });
  describe('optional keys: tighten, staleRefs, mirror.deleted, expendable', () => {
    const topic = 'rule-bystander-a-0010';
    const citing = 'rule-bystander-c-0012';
    const keyed: Expected = {
      ...expected,
      tighten: [{ id: topic, title: 'Docker notes' }],
      staleRefs: [{ id: citing, old: 'reference-old-nas-0f01', current: 'reference-new-nas-0f02' }],
      expendable: ['rule-bystander-b-0011'],
      mirror: { ...expected.mirror, deleted: [{ path: '-mnt-p-webshop/memory/review-apps.md', entry: 'rule-protected-b-0002' }] },
    };
    const start = () => baseline().map((entry) =>
      entry.id === topic ? { ...entry, title: 'Docker notes' }
        : entry.id === citing ? { ...entry, body: 'Address in reference-old-nas-0f01.\n' } : entry);
    const run = (entries: Entry[]) => scoreRun({ baselineIds: ids, baselineActiveIds: ids, entries, report: null, expected: keyed });

    it('counts a kept topic title, a stale citation and a surviving deleted-note entry as misses', () => {
      const score = run(start());
      expect(score.tighten).toEqual({ hit: 0, n: 1 });
      expect(score.staleRefs).toEqual({ hit: 0, n: 1 });
      expect(score.mirror.deleted).toEqual({ hit: 0, n: 1 });
      expect(score.misses).toEqual(expect.arrayContaining([
        `${topic} not tightened (topic title kept, or entry gone)`,
        `${citing} still cites reference-old-nas-0f01 instead of reference-new-nas-0f02`,
        'mirror: rule-protected-b-0002 not retired after -mnt-p-webshop/memory/review-apps.md was deleted (active)',
      ]));
    });

    it('accepts a revised title, a revised citation, and the deleted-note entry revoked', () => {
      const entries = start().map((entry) =>
        entry.id === topic ? { ...entry, title: 'Ask before pruning Docker images' }
          : entry.id === citing ? { ...entry, body: 'Address in reference-new-nas-0f02.\n' }
            : entry.id === 'rule-protected-b-0002' ? { ...entry, status: 'revoked' as const } : entry);
      const score = run(entries);
      expect(score.tighten).toEqual({ hit: 1, n: 1 });
      expect(score.staleRefs).toEqual({ hit: 1, n: 1 });
      expect(score.mirror.deleted).toEqual({ hit: 1, n: 1 });
    });

    it('follows supersede for tighten and staleRefs, and rejects a replacement that keeps the old citation', () => {
      const entries = after({ [topic]: 'superseded', [citing]: 'superseded' }, [
        sampleEntry({ id: 'rule-prune-1100', title: 'Ask before pruning Docker images', author: bosunAuthor(), supersedes: [topic] }),
        sampleEntry({ id: 'rule-nas-1101', author: bosunAuthor(), body: 'Was reference-old-nas-0f01, now reference-new-nas-0f02.\n', supersedes: [citing] }),
      ]);
      const score = run(entries);
      expect(score.tighten).toEqual({ hit: 1, n: 1 });
      expect(score.staleRefs).toEqual({ hit: 0, n: 1 });
    });

    it('never counts an expendable entry as churn', () => {
      const score = run(after({ 'rule-bystander-b-0011': 'superseded', 'rule-bystander-a-0010': 'superseded' }, []));
      expect(score.unaskedSuperseded).toEqual([]); // bystander-a is named by tighten, bystander-b is expendable
    });

    it('leaves the score unchanged when the keys are absent', () => {
      const without = scoreRun({ baselineIds: ids, entries: baseline(), report: null, expected });
      expect(without.tighten).toEqual({ hit: 0, n: 0 });
      expect(without.staleRefs).toEqual({ hit: 0, n: 0 });
      expect(without.mirror.deleted).toEqual({ hit: 0, n: 0 });
    });
  });

  it('accepts a "none" bullet with an explanation as a well-formed empty section', () => {
    const fine = report('- rule-undecided-a-0009 vs rule-undecided-b-000a — which one?').replace('## Tightened\nnone\n', '## Tightened\n- none (the rewrites are listed under Mirrored)\n');
    const score = scoreRun({ baselineIds: ids, entries: baseline(), report: fine, expected });
    expect(score.report.uncitedLines).toBe(0);
    expect(score.report.wellFormed).toBe(true);
  });
});

describe('trial scorer churn', () => {
  it('counts unmentioned pre-existing entries the run superseded or revoked, split by kind of change', () => {
    const entries = after(
      { 'rule-bystander-a-0010': 'superseded', 'rule-bystander-b-0011': 'revoked' },
      [sampleEntry({ id: 'rule-bystander-new-1020', author: bosunAuthor(), supersedes: ['rule-bystander-a-0010'] })],
    );
    const score = scoreRun({ baselineIds: ids, baselineActiveIds: ids, entries, report: null, expected });
    expect(score.unaskedSuperseded).toEqual(['rule-bystander-a-0010']);
    expect(score.unaskedRevoked).toEqual(['rule-bystander-b-0011']);
    expect(score.unaskedEdits).toBe(1);
    expect(score.unaskedRetirements).toBe(1);
  });

  it('takes 2 points per unasked supersede and 10 per unasked revoke off the score', () => {
    const idle = scoreRun({ baselineIds: ids, baselineActiveIds: ids, entries: baseline(), report: null, expected });
    const entries = after({ 'rule-bystander-a-0010': 'superseded', 'rule-bystander-b-0011': 'revoked', 'rule-bystander-c-0012': 'superseded' }, []);
    const score = scoreRun({ baselineIds: ids, baselineActiveIds: ids, entries, report: null, expected });
    expect(score.unaskedEdits).toBe(2);
    expect(score.unaskedRetirements).toBe(1);
    expect(score.score).toBeCloseTo(idle.score - 14, 6);
    expect(score.falseRetirements).toEqual([]);
  });

  it('ignores every entry expected.json mentions anywhere, notes included', () => {
    const entries = after({
      'rule-dup-two-0004': 'superseded', 'rule-loser-0008': 'superseded', 'reference-code-fact-000c': 'revoked',
      'rule-protected-a-0001': 'revoked', 'rule-bystander-c-0012': 'superseded',
    }, []);
    const noted: Expected = { ...expected, flag: [{ id: 'rule-owner-plan-000d', note: 'unlike rule-bystander-c-0012, which stays' }] };
    const score = scoreRun({ baselineIds: ids, baselineActiveIds: ids, entries, report: null, expected: noted });
    expect(score.unaskedSuperseded).toEqual([]);
    expect(score.unaskedRevoked).toEqual([]);
  });

  it('counts only entries that were active in the fixture and existed before the run', () => {
    const history = [
      sampleEntry({ id: 'rule-history-a-0020', status: 'superseded' }),
      sampleEntry({ id: 'rule-history-b-0021', status: 'revoked' }),
    ];
    const entries = [
      ...after({ 'rule-bystander-a-0010': 'superseded' }, [
        sampleEntry({ id: 'rule-drafted-1021', author: bosunAuthor(), status: 'superseded' }),
        sampleEntry({ id: 'rule-drafted-1022', author: bosunAuthor(), status: 'revoked' }),
      ]),
      ...history,
    ];
    const baselineIds = [...ids, ...history.map((entry) => entry.id)];
    const score = scoreRun({ baselineIds, baselineActiveIds: ids, entries, report: null, expected });
    expect(score.unaskedSuperseded).toEqual(['rule-bystander-a-0010']);
    expect(score.unaskedRevoked).toEqual([]);
  });

  it("does not blame the model for the quick pass's expiry of lapsed holds and handoffs", () => {
    const lapsed = [
      sampleEntry({ id: 'hold-lapsed-0030', kind: 'hold', until: '2026-10-01', author: agent }),
      sampleEntry({ id: 'handoff-lapsed-0031', kind: 'handoff', to: 'any', until: '2026-10-01', author: agent }),
    ];
    const entries = [...after({}, []), ...lapsed.map((entry) => ({ ...entry, status: 'expired' as const }))];
    const baselineIds = [...ids, ...lapsed.map((entry) => entry.id)];
    const score = scoreRun({ baselineIds, baselineActiveIds: baselineIds, entries, report: null, expected });
    expect(score).toMatchObject({ unaskedSuperseded: [], unaskedRevoked: [], unaskedEdits: 0, unaskedRetirements: 0 });
  });

  it('leaves churn unmeasured when the caller does not say which baseline entries were active', () => {
    const entries = after({ 'rule-bystander-a-0010': 'superseded', 'rule-bystander-b-0011': 'revoked' }, []);
    const score = scoreRun({ baselineIds: ids, entries, report: null, expected });
    expect(score).toMatchObject({ unaskedSuperseded: [], unaskedRevoked: [], unaskedEdits: 0, unaskedRetirements: 0 });
  });
});

describe('trial aggregation', () => {
  it('gives mean, sample standard deviation and n per model', () => {
    const rows = aggregate([
      { model: 'pi:a', values: { score: 70, wallMs: 1000 } },
      { model: 'pi:a', values: { score: 80, wallMs: 3000 } },
      { model: 'claude:b', values: { score: 50, wallMs: 2000 } },
    ]);
    expect(rows).toEqual([
      { model: 'pi:a', n: 2, metrics: { score: { mean: 75, sd: Math.sqrt(50), n: 2 }, wallMs: { mean: 2000, sd: Math.sqrt(2_000_000), n: 2 } } },
      { model: 'claude:b', n: 1, metrics: { score: { mean: 50, sd: null, n: 1 }, wallMs: { mean: 2000, sd: null, n: 1 } } },
    ]);
  });

  it('skips missing values rather than counting them as zero', () => {
    const [row] = aggregate([{ model: 'm', values: { costUsd: null } }, { model: 'm', values: { costUsd: 0.5 } }]);
    expect(row!.metrics.costUsd).toEqual({ mean: 0.5, sd: null, n: 1 });
  });
});

describe('run diff', () => {
  it('resolves historical run events after a later move by another session without changing labels or ordering', () => {
    const home = tempDir();
    const ctx: Ctx = { home, cwd: tempDir(), now: new Date('2026-10-22T12:00:00Z'), identity: bosunAuthor() };
    const entry = createEntry(ctx, { kind: 'rule', title: 'Initial', body: 'Created body', scope: 'global' });
    reviseEntry(ctx, entry.id, { title: 'Tightened', scope: 'machine' });
    const other = { ...ctx, identity: { ...owner, session: 'later-owner' } };
    reviseEntry(other, entry.id, { title: 'Current title', scope: 'project:alpha' });
    const text = renderRunDiff(home, 'bosun-run');
    expect(text).toBe(`# Changes by bosun-run\n\n- created [${entry.id}] rule global (agent-inferred): Current title\n  > Created body\n- revised [${entry.id}] rule machine (agent-inferred): Current title\n`);
    expect(text).not.toContain('entry missing');
    expect(text).not.toContain('project:alpha');
  });
  it("lists the run's changes from the log with titles, and created entries with their bodies", () => {
    const home = tempDir('lb-diff-');
    initStore(home);
    const created = sampleEntry({ id: 'rule-new-1010', title: 'New rule', author: bosunAuthor('mirrored'), body: 'Body text.\n' });
    const revoked = sampleEntry({ id: 'rule-old-1011', title: 'Old rule', status: 'revoked' });
    writeEntry(home, created);
    writeEntry(home, revoked);
    const line = { ts: '2026-10-18T09:00:00Z', kind: 'rule' as const, scope: 'global', harness: 'bosun', session: 'bosun-run' };
    appendLog(home, { ...line, id: 'rule-other-1012', event: 'created', status: 'active', session: 'someone-else' });
    appendLog(home, { ...line, id: created.id, event: 'created', status: 'active' });
    appendLog(home, { ...line, id: revoked.id, event: 'status', status: 'revoked' });
    const text = renderRunDiff(home, 'bosun-run');
    expect(text).toContain('- created [rule-new-1010] rule global (mirrored): New rule');
    expect(text).toContain('  > Body text.');
    expect(text).toContain('- revoked [rule-old-1011] rule global (agent-inferred): Old rule');
    expect(text).not.toContain('rule-other-1012');
  });
});
