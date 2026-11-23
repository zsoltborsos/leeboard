import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { brief, renderBrief, renderBriefWithCount } from '../src/commands/brief.js';
import { createEntry, releaseHold, replyToRequest } from '../src/change.js';
import { review } from '../src/commands/review.js';
import type { Ctx } from '../src/context.js';
import type { Entry } from '../src/entry.js';
import { logSize, readCursor, readReviewCursor } from '../src/log.js';
import { addProject } from '../src/projects.js';
import { scopeDir, writeEntry } from '../src/store.js';
import { commitFile, makeRepo, sampleEntry, tempDir } from './helpers.js';

const NOW = new Date('2026-10-17T12:00:00Z');
const FRESH = '2026-10-17T10:00:00Z';

function ctxFor(home: string, cwd: string, session: string | null = 'B', harness: Ctx['identity']['harness'] = 'pi'): Ctx {
  return { home, cwd, now: NOW, identity: { harness, session, origin: 'agent-inferred' } };
}

function put(home: string, overrides: Partial<Entry>): Entry {
  const entry = sampleEntry({ created: FRESH, updated: FRESH, ...overrides });
  writeEntry(home, entry);
  return entry;
}

describe('brief', () => {
  it('lists holds, grants, rules, references and the inbox for the project, in that order', () => {
    const home = tempDir();
    const repo = makeRepo();
    addProject(home, { name: 'alpha', paths: [repo] });

    put(home, { id: 'hold-no-runs-0001', kind: 'hold', scope: 'project:alpha', title: 'No Helmraiser runs', release: 'tunnel closed', blocks: ['helmraiser-run'], until: '2026-11-03', updated: '2026-10-07T12:00:00Z' });
    put(home, { id: 'hold-global-0002', kind: 'hold', title: 'Freeze deploys', release: 'the owner says so' });
    put(home, { id: 'hold-old-0003', kind: 'hold', status: 'released', title: 'Released hold', release: 'r' });
    put(home, { id: 'hold-expired-0004', kind: 'hold', title: 'Expired hold', release: 'r', until: '2026-10-16' });
    put(home, { id: 'grant-api-0005', kind: 'grant', scope: 'project:alpha', title: 'Api merges', holder: 'api-93' });
    put(home, { id: 'rule-pipefail-0006', title: 'Set pipefail' });
    put(home, { id: 'rule-local-0007', scope: 'project:alpha', title: 'Run lint first' });
    put(home, { id: 'rule-laptop-0008', scope: 'machine', title: 'Android builds freeze the laptop' });
    put(home, { id: 'rule-revoked-0009', status: 'revoked', title: 'Revoked rule' });
    put(home, { id: 'rule-other-000a', scope: 'project:beta', title: 'Belongs to beta' });
    put(home, { id: 'reference-prod-date-000b', kind: 'reference', title: 'Prod date is uutils' });
    put(home, { id: 'handoff-continue-000c', kind: 'handoff', scope: 'project:alpha', to: 'harness:pi', title: 'Continue the Expo step' });
    put(home, { id: 'request-review-000d', kind: 'request', scope: 'project:beta', to: 'project:alpha', title: 'Review branch Z' });
    put(home, { id: 'handoff-claude-000e', kind: 'handoff', scope: 'project:alpha', to: 'harness:claude-code', title: 'For claude only' });
    put(home, { id: 'handoff-other-000f', kind: 'handoff', scope: 'project:alpha', to: 'project:beta', title: 'For beta' });
    put(home, { id: 'handoff-any-0010', kind: 'handoff', to: 'any', title: 'Anyone can pick up' });
    put(home, { id: 'handoff-b-0011', kind: 'handoff', scope: 'machine', to: 'session:B', title: 'Picked by session' });
    put(home, { id: 'handoff-c-0012', kind: 'handoff', scope: 'machine', to: 'session:C', title: 'Other session' });
    put(home, { id: 'handoff-done-0013', kind: 'handoff', status: 'done', to: 'harness:pi', title: 'Already acked' });

    expect(renderBrief(brief(ctxFor(home, repo)))).toBe(`# Leeboard: project alpha

## Holds
- [hold-global-0002] Freeze deploys — release: the owner says so
- [hold-no-runs-0001] No Helmraiser runs — release: tunnel closed — until: 2026-11-03 — blocks: helmraiser-run (untouched 10 days)

## Grants
- [grant-api-0005] Api merges — holder: api-93

## Rules
- [rule-laptop-0008] Android builds freeze the laptop (machine)
- [rule-local-0007] Run lint first
- [rule-pipefail-0006] Set pipefail (global)

## References
- [reference-prod-date-000b] Prod date is uutils (global)

## Inbox
- [handoff-any-0010] handoff to any: Anyone can pick up
- [handoff-b-0011] handoff to session:B: Picked by session
- [handoff-continue-000c] handoff to harness:pi: Continue the Expo step
- [request-review-000d] request to project:alpha: Review branch Z
`);
  });

  it('flags a hold untouched for 7 days or more, not 6', () => {
    const home = tempDir();
    put(home, { id: 'hold-a-0001', kind: 'hold', title: 'Seven', release: 'r', updated: '2026-10-10T12:00:00Z' });
    put(home, { id: 'hold-b-0002', kind: 'hold', title: 'Six', release: 'r', updated: '2026-10-11T12:00:00Z' });
    const text = renderBrief(brief(ctxFor(home, tempDir())));
    expect(text).toContain('[hold-a-0001] Seven — release: r (untouched 7 days)');
    expect(text).toContain('[hold-b-0002] Six — release: r\n');
  });

  it('says so when the project is unregistered, with a registration hint inside a git repository', () => {
    const home = tempDir();
    const repo = makeRepo();
    put(home, { id: 'rule-pipefail-0006', title: 'Set pipefail' });
    put(home, { id: 'rule-local-0007', scope: 'project:alpha', title: 'Belongs to alpha' });

    expect(renderBrief(brief(ctxFor(home, repo)))).toBe(`# Leeboard: no registered project
This git repository is unregistered. Register it: lb project add <name> --path ${repo}

## Rules
- [rule-pipefail-0006] Set pipefail (global)
`);
  });

  it('has no registration hint outside git', () => {
    const home = tempDir();
    put(home, { id: 'rule-pipefail-0006', title: 'Set pipefail' });
    expect(renderBrief(brief(ctxFor(home, tempDir())))).toBe(`# Leeboard: no registered project

## Rules
- [rule-pipefail-0006] Set pipefail (global)
`);
  });

  it('counts unreadable files in its scopes once, not again from the whole-store inbox scan', () => {
    const home = tempDir();
    const repo = makeRepo();
    addProject(home, { name: 'alpha', paths: [repo] });
    for (const scope of ['global', 'machine', 'project:alpha', 'project:beta']) {
      mkdirSync(scopeDir(home, scope), { recursive: true });
      writeFileSync(join(scopeDir(home, scope), 'request-broken.md'), 'broken');
    }
    const data = brief(ctxFor(home, repo));
    expect(data.unreadableCount).toBe(3);
    expect(renderBrief(data)).toMatch(/Unreadable entry files: 3 — run `lb bosun --quick` for details\n$/);
    expect(brief(ctxFor(home, tempDir())).unreadableCount).toBe(2);
  });

  it('is just the header for an empty store', () => {
    const data = brief(ctxFor(tempDir(), tempDir()));
    expect(data.unreadableCount).toBe(0);
    expect(renderBrief(data)).toBe('# Leeboard: no registered project\n');
  });

  it('points at TASKS.md and CURRENT_STATE.md with their age and the commits since', () => {
    const home = tempDir();
    const repo = makeRepo();
    commitFile(repo, 'TASKS.md', '# tasks\n', 'tasks', '2026-09-24T10:00:00Z');
    commitFile(repo, 'a.txt', 'a', 'a', '2026-10-01T10:00:00Z');
    commitFile(repo, 'b.txt', 'b', 'b', '2026-10-02T10:00:00Z');
    commitFile(repo, 'CURRENT_STATE.md', '# state\n', 'state', '2026-10-15T10:00:00Z');

    const text = renderBrief(brief(ctxFor(home, repo)));
    expect(text).toContain(`## Repo state
- TASKS.md: last committed 2026-09-24 (23 days ago), 3 commits since
- CURRENT_STATE.md: last committed 2026-10-15 (2 days ago), 0 commits since
`);
  });

  it('reports a TASKS.md that was never committed, and omits files that do not exist', () => {
    const repo = makeRepo();
    writeFileSync(join(repo, 'TASKS.md'), '# tasks, never committed\n');
    const text = renderBrief(brief(ctxFor(tempDir(), repo)));
    expect(text).toContain('- TASKS.md: not committed yet\n');
    expect(text).not.toContain('CURRENT_STATE.md');
  });

  it('sets this session cursor to the end of the log, and keeps none without a session', () => {
    const home = tempDir();
    const cwd = tempDir();
    createEntry(ctxFor(home, cwd, 'A', 'claude-code'), { kind: 'rule', title: 'First' });
    createEntry(ctxFor(home, cwd, 'A', 'claude-code'), { kind: 'rule', title: 'Second' });

    brief(ctxFor(home, cwd, 'B'));
    expect(readCursor(home, 'B')).toBe(logSize(home));
    expect(logSize(home)).toBeGreaterThan(0);

    const anonymousHome = tempDir();
    brief(ctxFor(anonymousHome, cwd, null));
    expect(existsSync(join(anonymousHome, 'state'))).toBe(false);
  });

  it('structured output carries summaries without bodies', () => {
    const home = tempDir();
    put(home, { id: 'hold-a-0001', kind: 'hold', title: 'Freeze', release: 'when told', updated: '2026-10-07T12:00:00Z', body: 'long secret-free body\n' });
    const data = brief(ctxFor(home, tempDir()));
    expect(data.project).toBeNull();
    expect(data.holds).toHaveLength(1);
    expect(data.holds[0]).toMatchObject({ id: 'hold-a-0001', kind: 'hold', title: 'Freeze', release: 'when told', untouchedDays: 10 });
    expect(data.holds[0]).not.toHaveProperty('body');
  });
});

describe('owner review digest in brief', () => {
  it.each(['claude-code', 'pi', 'funkyoctopus', 'user'] as const)(
    'ends %s briefs with whole-store counts, without acknowledging the review', (harness) => {
      const home = tempDir();
      const cwd = tempDir();
      const ctx = ctxFor(home, cwd, 'author-session', 'claude-code');
      const request = createEntry(ctx, { kind: 'request', title: 'Old request', to: 'any', scope: 'project:elsewhere' });
      const hold = createEntry(ctx, { kind: 'hold', title: 'Old hold', release: 'told', scope: 'machine' });
      review(ctx);
      const cursor = readReviewCursor(home);
      replyToRequest(ctx, request.id, 'updated');
      releaseHold(ctx, hold.id);
      createEntry(ctx, { kind: 'rule', title: 'New elsewhere', scope: 'project:elsewhere' });
      const caller = ctxFor(home, cwd, 'reader-session', harness);
      const data = brief(caller);
      expect(data.ownerReview).toEqual({ new: 1, changed: 1, closed: 1 });
      expect(renderBrief(data)).toMatch(/Owner review: 1 new, 1 changed, 1 closed since the last review — run `lb review`\n$/);
      expect(readReviewCursor(home)).toBe(cursor);
      expect(renderBrief(brief(caller))).toBe(renderBrief(data));
      review(ctx);
      expect(renderBrief(brief(caller))).not.toContain('Owner review:');
    },
  );

  it.each(['helmraiser', 'bosun', null] as const)('never shows a digest for harness %s', (harness) => {
    const home = tempDir();
    const cwd = tempDir();
    createEntry(ctxFor(home, cwd), { kind: 'rule', title: 'Unseen' });
    const data = brief(ctxFor(home, cwd, 'reader', harness));
    expect(data).not.toHaveProperty('ownerReview');
    expect(renderBrief(data)).not.toContain('Owner review:');
    expect(existsSync(join(home, 'state', 'review.json'))).toBe(false);
  });

  it.each(['claude-code', 'pi', 'funkyoctopus', 'user'] as const)('omits the digest for %s when no changes are unseen', (harness) => {
    const home = tempDir();
    const caller = ctxFor(home, tempDir(), null, harness);
    expect(renderBrief(brief(caller))).not.toContain('Owner review:');
    createEntry(caller, { kind: 'rule', title: 'Seen' });
    review(caller);
    expect(brief(caller)).not.toHaveProperty('ownerReview');
    expect(renderBrief(brief(caller))).not.toContain('Owner review:');
  });

  it('omits zero count parts, leaves the review cursor absent, and needs no session', () => {
    const home = tempDir();
    const caller = ctxFor(home, tempDir(), null, 'user');
    createEntry(caller, { kind: 'rule', title: 'Unseen' });
    expect(renderBrief(brief(caller))).toMatch(/Owner review: 1 new since the last review — run `lb review`\n$/);
    expect(existsSync(join(home, 'state', 'review.json'))).toBe(false);
  });
});

describe('brief size', () => {
  function bulkStore(rules: number, references: number) {
    const home = tempDir();
    put(home, { id: 'hold-must-see-0001', kind: 'hold', title: 'The hold that must survive', release: 'told' });
    for (let i = 0; i < rules; i++) {
      put(home, { id: `rule-number-${String(i).padStart(4, '0')}`, title: `Rule number ${i} with a reasonably descriptive title` });
    }
    for (let i = 0; i < references; i++) {
      put(home, { id: `reference-number-${String(i).padStart(4, '0')}`, kind: 'reference', title: `Reference number ${i} with a reasonably descriptive title` });
    }
    return home;
  }

  it('stays at or under 8,000 characters, trimming the longest section with a count of what is left out', () => {
    const text = renderBrief(brief(ctxFor(bulkStore(300, 0), tempDir())));
    expect(text.length).toBeLessThanOrEqual(8000);
    expect(text).toContain('The hold that must survive');

    const listed = (text.match(/^- \[rule-number-/gm) ?? []).length;
    const more = Number(/… (\d+) more — lb list/.exec(text)?.[1]);
    expect(listed).toBeGreaterThan(50);
    expect(listed + more).toBe(300);
  });

  it('trims several large sections evenly rather than emptying one', () => {
    const text = renderBrief(brief(ctxFor(bulkStore(200, 200), tempDir())));
    expect(text.length).toBeLessThanOrEqual(8000);
    const rules = (text.match(/^- \[rule-number-/gm) ?? []).length;
    const references = (text.match(/^- \[reference-number-/gm) ?? []).length;
    expect(rules).toBeGreaterThan(30);
    expect(references).toBeGreaterThan(30);
    expect(Math.abs(rules - references)).toBeLessThanOrEqual(10);
    expect(text.match(/… \d+ more — lb list/g)).toHaveLength(2);
  });

  it('keeps the complete digest at the end inside the 8,000-character cap', () => {
    const home = bulkStore(200, 200);
    const caller = ctxFor(home, tempDir());
    createEntry(caller, { kind: 'rule', title: 'Unseen' });
    const text = renderBrief(brief(caller));
    expect(text.length).toBeLessThanOrEqual(8000);
    expect(text).toContain('…');
    expect(text).toContain('The hold that must survive');
    expect(text).toMatch(/\nOwner review: 1 new since the last review — run `lb review`\n$/);
    expect(existsSync(join(home, 'state', 'review.json'))).toBe(false);
  });

  it('protects both footers under the cap, with unreadable warning last and excluded from entry count', () => {
    const home = bulkStore(200, 200);
    const caller = ctxFor(home, tempDir());
    createEntry(caller, { kind: 'rule', title: 'Unseen' });
    writeFileSync(join(scopeDir(home, 'global'), 'rule-broken.md'), 'broken');
    const { text, entries } = renderBriefWithCount(brief(caller));
    expect(text.length).toBeLessThanOrEqual(8000);
    expect(text).toContain('…');
    expect(text).toContain('Owner review: 1 new since the last review — run `lb review`');
    expect(text).toMatch(/Unreadable entry files: 1 — run `lb bosun --quick` for details\n$/);
    expect(entries).toBe((text.match(/^- \[/gm) ?? []).length);
  });

  it('counts the entries the trimmed text shows, not the entries it was given', () => {
    const data = brief(ctxFor(bulkStore(300, 0), tempDir()));
    const { text, entries } = renderBriefWithCount(data);
    expect(text).toBe(renderBrief(data));
    expect(data.holds.length + data.rules.length).toBe(301);
    expect(entries).toBeGreaterThan(0);
    expect(entries).toBeLessThan(301);
    expect(entries).toBe((text.match(/^- \[/gm) ?? []).length);
  });

  it('counts every entry line and no repo-state or omission lines when nothing is trimmed', () => {
    const home = tempDir();
    const repo = makeRepo();
    addProject(home, { name: 'alpha', paths: [repo] });
    commitFile(repo, 'TASKS.md', '# tasks\n', 'tasks', '2026-09-24T10:00:00Z');
    put(home, { id: 'hold-one-0001', kind: 'hold', title: 'A hold', release: 'told' });
    put(home, { id: 'rule-one-0001', title: 'A rule' });
    put(home, { id: 'reference-one-0001', kind: 'reference', title: 'A reference' });
    put(home, { id: 'handoff-one-0001', kind: 'handoff', title: 'A handoff', to: 'any' });

    const { text, entries } = renderBriefWithCount(brief(ctxFor(home, repo)));
    expect(text).toContain('- TASKS.md:');
    expect(entries).toBe(4);
    expect(entries).toBe((text.match(/^- \[/gm) ?? []).length);
  });

  it('clips a single enormous title', () => {
    const home = tempDir();
    put(home, { id: 'rule-long-0001', title: 'x'.repeat(5000) });
    const text = renderBrief(brief(ctxFor(home, tempDir())));
    expect(text.length).toBeLessThan(500);
    expect(text).toContain('…');
  });
});
