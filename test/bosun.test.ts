import { describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { bosun, renderBosun } from '../src/commands/bosun.js';
import { brief } from '../src/commands/brief.js';
import { check } from '../src/commands/check.js';
import type { Ctx } from '../src/context.js';
import { type Entry, isActive, KINDS, STATUSES } from '../src/entry.js';
import { readLogSince } from '../src/log.js';
import { addProject } from '../src/projects.js';
import { findEntry, initStore, listEntries, scopeDir, writeEntry } from '../src/store.js';
import { sampleEntry, tempDir } from './helpers.js';

const NOW = new Date('2026-10-18T09:00:00Z');
const TS = '2026-10-18T09:00:00Z';

function setup() {
  const home = tempDir('lb-bosun-home-');
  initStore(home);
  const ctx: Ctx = {
    home, cwd: tempDir('lb-cwd-'), now: NOW,
    identity: { harness: 'pi', session: 'caller', origin: 'agent-inferred' },
  };
  const put = (entry: Partial<Entry>) => {
    const value = sampleEntry(entry);
    writeEntry(home, value);
    return value;
  };
  return { home, ctx, put };
}

/** All store files and their bytes, including the append-only log. */
function snapshot(home: string): Record<string, string> {
  const result: Record<string, string> = {};
  function walk(dir: string, prefix: string) {
    for (const file of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, file.name);
      const name = prefix + file.name;
      if (file.isDirectory()) walk(path, name + '/');
      else result[name] = readFileSync(path, 'utf8');
    }
  }
  walk(home, '');
  return result;
}

const ids = (entries: { id: string }[]) => entries.map((entry) => entry.id);

describe('Bosun expiry', () => {
  it('expires active lapsed holds and handoffs in every scope, appends a section, and logs once each', () => {
    const { home, ctx, put } = setup();
    const hold = put({ id: 'hold-lapsed-0001', kind: 'hold', until: '2026-10-17', body: 'Keep this explanation.\n', blocks: ['deploy'] });
    const handoff = put({ id: 'handoff-lapsed-0002', kind: 'handoff', scope: 'project:other', until: '2026-10-18T08:59:59Z', to: 'any' });
    const report = bosun(ctx);
    expect(ids(report.expired).sort()).toEqual([handoff.id, hold.id].sort());
    expect(findEntry(home, hold.id)).toEqual({
      ...hold, status: 'expired', updated: TS,
      body: `Keep this explanation.\n\n## Expired (${TS}, bosun)\n`,
    });
    expect(findEntry(home, handoff.id)).toEqual({
      ...handoff, status: 'expired', updated: TS, body: `## Expired (${TS}, bosun)\n`,
    });
    expect(report.expired.every((entry) => entry.status === 'expired' && entry.updated === TS)).toBe(true);
    const lines = readLogSince(home, 0).lines;
    expect(lines).toHaveLength(2);
    for (const entry of [hold, handoff]) {
      expect(lines.find((line) => line.id === entry.id)).toEqual({
        ts: TS, id: entry.id, kind: entry.kind, scope: entry.scope,
        event: 'status', status: 'expired', harness: 'bosun', session: 'caller',
      });
    }
    expect(listEntries(home)).toHaveLength(2); // Never deletes.
  });

  it('does not touch missing, unreadable or future until values, other kinds, or nonactive entries', () => {
    const { home, ctx, put } = setup();
    let index = 0;
    for (const kind of ['hold', 'handoff'] as const) {
      for (const until of [undefined, 'not a date', '2026-10-18', '2026-10-18T09:00:00Z', '2026-11-01']) {
        put({ id: `${kind}-future-${index++}`, kind, until });
      }
      for (const status of STATUSES.filter((status) => status !== 'active')) {
        put({ id: `${kind}-inactive-${index++}`, kind, status, until: '2026-10-01' });
      }
    }
    for (const kind of ['rule', 'grant', 'reference', 'request'] as const) {
      put({ id: `${kind}-other-0001`, kind, until: '2026-10-01' });
    }
    const before = snapshot(home);
    expect(bosun(ctx).expired).toEqual([]);
    expect(snapshot(home)).toEqual(before);
  });

  it('honours the end of a date-only UTC day and strict timestamp boundaries', () => {
    const { home, ctx, put } = setup();
    const day = put({ id: 'hold-day-0001', kind: 'hold', until: '2026-10-18' });
    const instant = put({ id: 'handoff-instant-0001', kind: 'handoff', until: '2026-10-18T23:59:59.999Z' });
    expect(bosun({ ...ctx, now: new Date('2026-10-18T23:59:59.999Z') }).expired).toEqual([]);
    expect(ids(bosun({ ...ctx, now: new Date('2026-10-19T00:00:00Z') }).expired).sort()).toEqual([day.id, instant.id].sort());
    expect(findEntry(home, day.id).updated).toBe('2026-10-19T00:00:00Z');
  });

  it('is idempotent: a second pass has no expiry, body, file or log changes', () => {
    const { home, ctx, put } = setup();
    put({ id: 'hold-old-0001', kind: 'hold', until: '2026-10-17' });
    bosun(ctx);
    const before = snapshot(home);
    const report = bosun({ ...ctx, now: new Date('2026-10-20T09:00:00Z') });
    expect(report.expired).toEqual([]);
    expect(renderBosun(report)).toBe('Bosun: nothing to do\n');
    expect(snapshot(home)).toEqual(before);
  });

  it('dry-run proposes the same results while leaving every file and log byte unchanged', () => {
    const { home, ctx, put } = setup();
    put({ id: 'hold-old-0001', kind: 'hold', until: '2026-10-17', updated: '2026-10-01T00:00:00Z' });
    put({ id: 'handoff-old-0001', kind: 'handoff', scope: 'machine', until: '2026-10-17' });
    put({ id: 'hold-stale-0001', kind: 'hold', updated: '2026-10-01T00:00:00Z' });
    const before = snapshot(home);
    const dry = bosun(ctx, { dryRun: true });
    expect(dry.expired).toHaveLength(2);
    expect(renderBosun(dry)).toContain('## Expired (would expire)');
    expect(snapshot(home)).toEqual(before);
    expect(bosun(ctx)).toEqual({ ...dry, dryRun: false });
  });

  it('expired status excludes entries from brief, check and inbox even at a pre-until clock', () => {
    const { home, ctx, put } = setup();
    const hold = put({ id: 'hold-lapsed-0001', kind: 'hold', until: '2026-10-17', blocks: ['deploy'] });
    put({ id: 'handoff-lapsed-0001', kind: 'handoff', until: '2026-10-17', to: 'any' });
    const earlier = { ...ctx, now: new Date('2026-10-17T09:00:00Z') };
    expect(brief(earlier).holds).toHaveLength(1);
    expect(brief(earlier).inbox).toHaveLength(1);
    expect(check(earlier, 'deploy').holds).toHaveLength(1);
    expect(findEntry(home, hold.id).status).toBe('active'); // Brief does not run Bosun automatically.
    bosun(ctx);
    expect(isActive(findEntry(home, hold.id), earlier.now)).toBe(false);
    expect(brief(earlier).holds).toEqual([]);
    expect(brief(earlier).inbox).toEqual([]);
    expect(check(earlier, 'deploy').holds).toEqual([]);
  });

  it.each(['helmraiser'] as const)('uses bosun attribution even for a %s caller, preserving a null session', (harness) => {
    const { home, ctx, put } = setup();
    put({ id: 'hold-lapsed-0001', kind: 'hold', until: '2026-10-17' });
    bosun({ ...ctx, identity: { ...ctx.identity, harness, session: null } });
    expect(readLogSince(home, 0).lines[0]).toMatchObject({ harness: 'bosun', session: null });
  });
});

describe('Bosun report-only checks', () => {
  it('reports missing absolute and home paths in title and body, deduplicating paths without writes', () => {
    const { home, ctx, put } = setup();
    const existing = join(tempDir(), 'exists');
    writeFileSync(existing, 'present');
    const homeFile = 'bosun-existing-file';
    writeFileSync(join(homedir(), homeFile), 'present');
    const missing = join(home, 'not-here');
    const ref = put({
      id: 'reference-paths-0001', kind: 'reference', scope: 'machine', title: `Read ${missing}.`,
      body: `Missing \`~/bosun-missing-file\` and [file](${missing}). Exists: ${existing}, ~/${homeFile} and ${home}.`,
    });
    const before = snapshot(home);
    const report = bosun(ctx);
    expect(report.deadReferences).toEqual([{ entry: expect.objectContaining({ id: ref.id }), paths: [missing, '~/bosun-missing-file'].sort() }]);
    expect(snapshot(home)).toEqual(before);
  });

  it('checks only paths this machine owns: machine scope, the home directory, registered project paths', () => {
    const { ctx, put } = setup();
    const projectDir = tempDir('lb-project-');
    addProject(ctx.home, { name: 'remote-ish', paths: [projectDir] });
    put({
      id: 'reference-remote-0001', kind: 'reference', scope: 'project:remote-ish',
      title: 'Prod dumps: /var/backups/bosun-missing-db on the prod host',
      body: 'Secrets land in /run/bosun-missing-secrets/; reset via /api/testers/reset.',
    });
    const local = put({
      id: 'reference-local-0001', kind: 'reference', scope: 'project:remote-ish',
      title: `Read ~/bosun-missing-file and ${join(projectDir, 'missing.md')}`,
    });
    expect(bosun(ctx).deadReferences).toEqual([
      { entry: expect.objectContaining({ id: local.id }), paths: [join(projectDir, 'missing.md'), '~/bosun-missing-file'].sort() },
    ]);
  });

  it('treats a path whose top-level directory does not exist here as a route, even in machine scope', () => {
    const { ctx, put } = setup();
    put({ id: 'reference-route-0001', kind: 'reference', scope: 'machine', title: 'Check /health on 45821 and /api/testers/reset' });
    expect(bosun(ctx).deadReferences).toEqual([]);
  });

  it('ignores URLs, relative paths, and inline code with spaces or glob/template characters', () => {
    const { home, ctx, put } = setup();
    put({
      id: 'reference-ignore-0001', kind: 'reference', title: 'https://example.test/missing/path',
      body: [
        '<https://example.test/a> [site](https://example.test/b)',
        'file:///not/a/local/reference ssh://host/a/b relative/path ./relative ../relative',
        '`/missing/path with spaces` ``~/missing file``',
        '`/missing/*` `/missing/?` `/missing/<name>` `/missing/>name`',
      ].join('\n'),
    });
    const before = snapshot(home);
    expect(bosun(ctx).deadReferences).toEqual([]);
    expect(snapshot(home)).toEqual(before);
  });

  it('checks only active references, not other kinds or inactive or lapsed references', () => {
    const { ctx, put } = setup();
    for (const [index, entry] of [
      { kind: 'rule' }, { kind: 'reference', status: 'retired' },
      { kind: 'reference', until: '2026-10-01' },
    ].entries()) {
      put({ id: `reference-ignore-${index}`, title: '~/bosun-missing-file', ...entry } as Partial<Entry>);
    }
    expect(bosun(ctx).deadReferences).toEqual([]);
  });

  it('groups normalised titles only within a scope and among active entries, without changing files', () => {
    const { home, ctx, put } = setup();
    const a = put({ id: 'rule-duplicate-0001', title: '  USE   Pipefail!  ' });
    const b = put({ id: 'reference-duplicate-0001', kind: 'reference', title: 'use pipefail' });
    const c = put({ id: 'grant-duplicate-0001', kind: 'grant', title: 'Use\tpipefail.' });
    put({ id: 'rule-machine-0001', title: 'Use pipefail', scope: 'machine' });
    put({ id: 'rule-retired-0001', title: 'Use pipefail', status: 'retired' });
    put({ id: 'hold-lapsed-0001', title: 'Use pipefail', kind: 'hold', until: '2026-10-17' });
    put({ id: 'rule-lapsed-0001', title: 'Use pipefail', until: '2026-10-17' });
    const before = snapshot(home);
    const report = bosun(ctx, { dryRun: true });
    expect(report.duplicates).toHaveLength(1);
    expect(report.duplicates[0]).toMatchObject({ scope: 'global', title: 'use pipefail' });
    expect(ids(report.duplicates[0]!.entries)).toEqual([a.id, b.id, c.id].sort());
    expect(snapshot(home)).toEqual(before);
  });

  it('normalises Unicode punctuation and whitespace', () => {
    const { ctx, put } = setup();
    put({ id: 'rule-unicode-0001', title: '“Café”—résumé!' });
    put({ id: 'rule-unicode-0002', title: 'CAFÉRÉSUMÉ' });
    expect(bosun(ctx).duplicates[0]).toMatchObject({ title: 'caférésumé' });
  });

  it('reports holds untouched for at least seven full days, excluding lapsed and nonactive holds', () => {
    const { home, ctx, put } = setup();
    const stale = put({ id: 'hold-stale-0001', kind: 'hold', updated: '2026-10-11T09:00:00Z' });
    put({ id: 'hold-recent-0001', kind: 'hold', updated: '2026-10-11T09:00:01Z' });
    put({ id: 'hold-future-0001', kind: 'hold', updated: '2026-10-19T09:00:00Z' });
    put({ id: 'hold-invalid-0001', kind: 'hold', updated: 'unreadable' });
    put({ id: 'hold-released-0001', kind: 'hold', updated: '2026-10-01T09:00:00Z', status: 'released' });
    put({ id: 'hold-lapsed-0001', kind: 'hold', updated: '2026-10-01T09:00:00Z', until: '2026-10-17' });
    put({ id: 'rule-old-0001', updated: '2026-10-01T09:00:00Z' });
    const before = snapshot(home);
    expect(bosun(ctx, { dryRun: true }).staleHolds).toEqual([{ entry: expect.objectContaining({ id: stale.id }), untouchedDays: 7 }]);
    expect(snapshot(home)).toEqual(before);
  });
});

describe('Bosun unreadable files', () => {
  it('reports every failed file in path order, preserves raw errors and never mutates files or log', () => {
    const { home, ctx, put } = setup();
    put({ id: 'rule-healthy-0001', title: 'Healthy' });
    const paths = ['project:other', 'machine', 'global'].map((scope) => {
      mkdirSync(scopeDir(home, scope), { recursive: true });
      const path = join(scopeDir(home, scope), scope === 'machine' ? 'rule-broken.md' : 'hold-broken.md');
      writeFileSync(path, '---\ntitle: [\n---\n');
      return { path, scope };
    }).sort((a, b) => a.path < b.path ? -1 : 1);
    const before = snapshot(home);
    const report = bosun(ctx);
    expect(report.unreadable).toEqual(paths.map((file) => ({ ...file, error: expect.any(String) })));
    expect(report.unreadable.every((file) => file.error.includes('\n'))).toBe(true);
    const text = renderBosun(report);
    expect(text.split('\n')[0]).toBe('## Unreadable files');
    expect(text.trim().split('\n')).toHaveLength(4);
    for (const { path, scope } of paths) expect(text).toContain(`- ${path} (${scope}) — `);
    expect(bosun(ctx, { dryRun: true }).unreadable).toEqual(report.unreadable);
    expect(snapshot(home)).toEqual(before);
  });
});

describe('Bosun stale entry references', () => {
  it('resolves chains across scopes, groups and sorts unique citations, without any writes', () => {
    const { home, ctx, put } = setup();
    const old = put({ id: 'rule-old-0001', status: 'superseded' });
    const middle = put({ id: 'rule-middle-0001', scope: 'machine', status: 'superseded', supersedes: [old.id] });
    const current = put({ id: 'grant-current-0001', kind: 'grant', scope: 'project:other', supersedes: [middle.id] });
    const revoked = put({ id: 'hold-revoked-0001', kind: 'hold', status: 'revoked' });
    const missing = 'reference-missing-abcd';
    const citing = put({ id: 'rule-citing-0001', title: 'Follow these', body: `${old.id} ${missing} ${revoked.id} ${old.id}` });
    const before = snapshot(home);
    const report = bosun(ctx);
    expect(report.staleReferences).toEqual([{
      entry: expect.objectContaining({ id: citing.id }),
      citations: [
        { id: revoked.id, status: 'revoked', current: null },
        { id: missing, status: 'missing', current: null },
        { id: old.id, status: 'superseded', current: current.id },
      ],
    }]);
    expect(renderBosun(report)).toBe(`## Stale entry references\n- [${citing.id}] Follow these — cites ${revoked.id} (revoked), ${missing} (missing), ${old.id} (superseded; now ${current.id})\n`);
    expect(bosun(ctx, { dryRun: true }).staleReferences).toEqual(report.staleReferences);
    expect(snapshot(home)).toEqual(before);
  });

  it('scans active bodies of all six kinds, not inactive or time-lapsed citing entries', () => {
    const { ctx, put } = setup();
    const active = KINDS.map((kind) => put({ id: `${kind}-citing-0001`, kind, body: 'rule-missing-0001' }));
    for (const status of STATUSES.filter((status) => status !== 'active')) {
      put({ id: `rule-${status}-0001`, status, body: 'rule-missing-0001' });
    }
    for (const kind of KINDS) {
      put({ id: `${kind}-lapsed-0001`, kind, until: '2026-10-01', body: 'rule-missing-0001' });
    }
    expect(bosun(ctx).staleReferences.map(({ entry }) => entry.id)).toEqual(ids(active).sort());
  });

  it('ignores self, provenance, titles and active or naturally ended targets (including retired)', () => {
    const { ctx, put } = setup();
    const targets = (['active', 'done', 'released', 'expired', 'retired'] as const)
      .map((status) => put({ id: `rule-target-${status}-0001`, status }));
    const old = put({ id: 'rule-old-0001', status: 'superseded' });
    put({ id: 'rule-citing-0001', title: 'rule-title-only-abcd', supersedes: [old.id, 'rule-provenance-abcd'],
      body: ['rule-citing-0001', old.id, 'rule-provenance-abcd', ...ids(targets)].join(' ') });
    expect(bosun(ctx).staleReferences).toEqual([]);
  });

  it('reports no active successor for a cited chain ending at a lapsed entry at the context clock', () => {
    const { home, ctx, put } = setup();
    const old = put({ id: 'rule-old-0001', status: 'superseded' });
    const middle = put({ id: 'rule-middle-0002', status: 'superseded', supersedes: [old.id] });
    const end = put({ id: 'rule-end-0003', supersedes: [middle.id], until: '2026-10-17' });
    const citing = put({ id: 'rule-citing-0004', title: 'Follow this', body: old.id });
    const before = snapshot(home);
    const earlier = bosun({ ...ctx, now: new Date('2026-10-17T23:59:59.999Z') });
    expect(earlier.staleReferences[0]!.citations).toEqual([
      { id: old.id, status: 'superseded', current: end.id },
    ]);
    const report = bosun(ctx);
    expect(report.staleReferences).toEqual([{
      entry: expect.objectContaining({ id: citing.id }),
      citations: [{ id: old.id, status: 'superseded', current: null }],
    }]);
    expect(renderBosun(report)).toBe(`## Stale entry references\n- [${citing.id}] Follow this — cites ${old.id} (superseded; no active successor)\n`);
    expect(findEntry(home, end.id).status).toBe('active');
    expect(snapshot(home)).toEqual(before);
  });

  it('reports superseded ids without active successors, including closed endpoints and cycles', () => {
    const { ctx, put } = setup();
    const missing = put({ id: 'rule-missing-successor-0001', status: 'superseded' });
    const closed = put({ id: 'rule-closed-chain-0001', status: 'superseded' });
    put({ id: 'rule-end-0001', status: 'done', supersedes: [closed.id] });
    const a = put({ id: 'rule-cycle-a-0001', status: 'superseded', supersedes: ['rule-cycle-b-0001'] });
    put({ id: 'rule-cycle-b-0001', status: 'superseded', supersedes: [a.id] });
    put({ id: 'rule-citing-0001', body: [missing.id, closed.id, a.id].join(' ') });
    const report = bosun(ctx);
    expect(report.staleReferences[0]!.citations).toEqual([closed.id, a.id, missing.id].map((id) => ({ id, status: 'superseded', current: null })));
    expect(renderBosun(report).match(/\(superseded; no active successor\)/g)).toHaveLength(3);
  });
});

describe('Bosun reports', () => {
  it('groups all sections, and JSON serialization carries the same report', () => {
    const { home, ctx, put } = setup();
    writeFileSync(join(scopeDir(home, 'global'), 'hold-broken.md'), 'broken');
    put({ id: 'hold-lapsed-0001', kind: 'hold', until: '2026-10-17' });
    put({ id: 'reference-dead-0001', kind: 'reference', title: 'Read ~/bosun-missing-file' });
    put({ id: 'rule-dupe-0001', title: 'Same!', body: 'rule-missing-0001' });
    put({ id: 'rule-dupe-0002', title: 'same' });
    put({ id: 'hold-stale-0001', kind: 'hold', updated: '2026-10-01T09:00:00Z' });
    const report = bosun(ctx);
    const text = renderBosun(report);
    expect(text.match(/^## .+$/gm)).toEqual(['## Expired', '## Dead references', '## Stale entry references', '## Exact duplicates', '## Stale holds', '## Unreadable files']);
    expect(text).toContain('~/bosun-missing-file');
    expect(text).toContain('untouched 17 days');
    expect(text).toContain('- [rule-dupe-0001] Same! — cites rule-missing-0001 (missing)');
    expect(JSON.parse(JSON.stringify(report))).toEqual(report);
    expect(JSON.parse(JSON.stringify(report)).staleReferences[0].citations[0]).toEqual({ id: 'rule-missing-0001', status: 'missing', current: null });
  });

  it('omits empty sections and emits only a one-line nothing-to-do message for an empty store', () => {
    const { home, ctx, put } = setup();
    const before = snapshot(home);
    const report = bosun(ctx);
    expect(report.unreadable).toEqual([]);
    expect(renderBosun(report)).toBe('Bosun: nothing to do\n');
    expect(snapshot(home)).toEqual(before);
    put({ id: 'hold-stale-0001', kind: 'hold', updated: '2026-10-01T09:00:00Z' });
    const text = renderBosun(bosun(ctx));
    expect(text.match(/^## .+$/gm)).toEqual(['## Stale holds']);
    expect(text).not.toContain('nothing to do');
  });
});
