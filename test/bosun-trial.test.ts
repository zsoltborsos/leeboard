import { beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Expected } from '../src/bosun/score.js';
import { initStore, writeEntry } from '../src/store.js';
import { fakeRunnerBin, git, sampleEntry, tempDir } from './helpers.js';

const REPO = join(import.meta.dirname, '..');
const SCRIPT = join(REPO, 'scripts', 'bosun-trial.mjs');

beforeAll(() => {
  if (!existsSync(join(REPO, 'dist', 'cli.js'))) throw new Error('dist/cli.js is missing: run `npm run build` before `npm test`');
});

const REPORT = [
  '## Mirrored', '- -mnt-p-a/note.md — new (see log)', '## Merged', 'none', '## Re-scoped', 'none', '## Tightened', 'none',
  '## Retired', '- rule-code-fact-0002 — code fact', '## Contradictions for the owner', 'none', '## Left alone with doubt', 'none',
].join('\n');

/** A small fixture, a home with a real store under git, and fake runners that retire the code fact. */
function world() {
  const fixture = tempDir('lb-trial-fixture-');
  const store = join(fixture, 'store');
  initStore(store);
  writeEntry(store, sampleEntry({ id: 'rule-protected-0001', title: 'Owner rule', author: { harness: 'user', session: 'U', origin: 'user-stated' } }));
  writeEntry(store, sampleEntry({ id: 'rule-code-fact-0002', title: 'Ids are built in src/entry.ts' }));
  mkdirSync(join(fixture, 'memory', '-mnt-p-a', 'memory'), { recursive: true });
  writeFileSync(join(fixture, 'memory', '-mnt-p-a', 'memory', 'note.md'), 'Owner: always do X.\n');
  const expected: Expected = {
    protected: ['rule-protected-0001'], duplicates: [], decidable: [], undecidable: [], rescope: [],
    retire: [{ id: 'rule-code-fact-0002' }], flag: [],
    mirror: { new: [{ path: '-mnt-p-a/memory/note.md', scopes: ['global'] }], changed: [], skip: [], represented: [] },
  };
  writeFileSync(join(fixture, 'expected.json'), JSON.stringify(expected));

  const home = tempDir('lb-trial-home-');
  const real = join(home, '.leeboard');
  initStore(real);
  writeFileSync(join(real, 'log.jsonl'), '{"real":"log"}\n');
  git(real, 'init', '-q', '-b', 'main');
  git(real, 'add', '-A');
  git(real, 'commit', '-q', '-m', 'real store');

  const work = tempDir('lb-trial-work-');
  writeFileSync(join(work, 'script.json'), JSON.stringify([
    { args: ['add', 'rule', '--title', 'Always do X', '--scope', 'global', '--origin', 'user-stated', '--body', '-'], input: 'Why.\nSource: claude-memory -mnt-p-a/note.md\n' },
    { args: ['revoke', 'rule-code-fact-0002', '--reason', 'code fact'] },
  ]));
  writeFileSync(join(work, 'report.md'), REPORT);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    PATH: `${fakeRunnerBin()}:${process.env.PATH}`,
    FAKE_LB_SCRIPT: join(work, 'script.json'),
    FAKE_REPORT_FILE: join(work, 'report.md'),
  };
  delete env.LEEBOARD_HOME;
  const trial = (args: string[], extra: NodeJS.ProcessEnv = {}) =>
    spawnSync('node', [SCRIPT, '--fixture', fixture, ...args], { env: { ...env, ...extra }, encoding: 'utf8', cwd: work });
  const realSnapshot = () => [git(real, 'status', '--porcelain'), readFileSync(join(real, 'log.jsonl'), 'utf8')];
  return { fixture, real, out: join(work, 'out'), script: join(work, 'script.json'), trial, realSnapshot };
}

/** The shipped fixture (trials/bosun), run through the trial script with a scripted fake runner. */
function shippedTrial(steps: { args: string[]; input?: string }[], report: string) {
  const home = tempDir('lb-shipped-home-');
  const work = tempDir('lb-shipped-work-');
  writeFileSync(join(work, 'script.json'), JSON.stringify(steps));
  writeFileSync(join(work, 'report.md'), report);
  const env: NodeJS.ProcessEnv = {
    ...process.env, HOME: home, PATH: `${fakeRunnerBin()}:${process.env.PATH}`,
    FAKE_LB_SCRIPT: join(work, 'script.json'), FAKE_REPORT_FILE: join(work, 'report.md'),
  };
  delete env.LEEBOARD_HOME;
  const out = join(work, 'out');
  const result = spawnSync('node', [SCRIPT, '--models', 'claude:m', '--out', out], { env, encoding: 'utf8', cwd: work });
  expect(result.stderr).toBe('');
  expect(result.status).toBe(0);
  return JSON.parse(readFileSync(join(out, 'results.json'), 'utf8')).runs[0];
}

describe('shipped bosun trial fixture', () => {
  const expected = JSON.parse(readFileSync(join(REPO, 'trials', 'bosun', 'expected.json'), 'utf8')) as Expected;
  const COMMIT_RULES = Object.fromEntries((expected.expendable ?? []).map((id) => [id.slice(-4), id]));
  const source = (dir: string, file: string) => `Why.\nSource: claude-memory ${dir}/${file}\n`;
  const IDEAL = [
    { args: ['add', 'rule', '--title', 'Run pnpm codegen with every webshop GraphQL schema change', '--scope', 'project:webshop', '--origin', 'user-stated', '--body', '-'], input: source('-home-dev-src-webshop', 'codegen-after-schema.md') },
    { args: ['add', 'rule', '--title', 'Keep pull requests under about 300 changed lines', '--scope', 'global', '--origin', 'user-stated', '--body', '-'], input: source('-home-dev-src-blog', 'small-prs.md') },
    { args: ['add', 'reference', '--title', 'Webshop staging is at https://staging.webshop.example.test', '--scope', 'project:webshop', '--origin', 'mirrored', '--body', '-'], input: source('-home-dev-src-webshop', 'staging-url.md') },
    { args: ['supersede', 'reference-webshop-staging-is-at-staging-old-8c01', '--by', 'reference-webshop-staging-is-at-https'] },
    { args: ['supersede', 'rule-use-pnpm-for-installs-not-npm-2b02', '--by', 'rule-install-dependencies-with-pnpm-never-npm-2b01'] },
    { args: ['supersede', 'rule-get-the-owner-s-ok-before-any-schema-mig-2c02', '--by', 'rule-ask-before-changing-the-webshop-database-2c01'] },
    { args: ['supersede', 'rule-schema-changes-in-webshop-need-owner-app-2c03', '--by', 'rule-ask-before-changing-the-webshop-database-2c01'] },
    { args: ['supersede', 'rule-commit-straight-to-main-in-the-blog-3d01', '--by', 'rule-open-a-pull-request-for-every-blog-chang-3d02'] },
    { args: ['supersede', 'rule-add-a-changelog-md-entry-with-every-webs-3c01', '--by', 'rule-don-t-edit-changelog-md-release-notes-com-3c02'] },
    { args: ['revise', 'rule-use-stripe-test-mode-for-webshop-s-local-5e01', '--scope', 'project:webshop'] },
    { args: ['revise', 'reference-the-gpu-box-is-reachable-as-gpu-lan-5e02', '--scope', 'machine'] },
    { args: ['revoke', 'reference-webshop-prices-are-computed-in-src-6c01', '--reason', 'code fact'] },
    { args: ['revoke', 'rule-fix-the-flaky-cart-test-next-sprint-6c02', '--reason', 'scheduled fix'] },
    { args: ['revoke', 'rule-status-blog-migration-to-astro-is-60-do-6d01', '--reason', 'status update'] },
    { args: ['supersede', 'rule-don-t-expose-local-servers-on-every-net-ae01', '--by', 'rule-bind-dev-servers-to-127-0-0-1-1b02'] },
    { args: ['supersede', 'rule-never-run-webshop-checkout-locally-in-st-af01', '--by', 'rule-use-stripe-test-mode-for-webshop-s-local-5e01'] },
    { args: ['supersede', 'rule-use-american-spelling-in-webshop-ui-cop-ad02', '--by', 'rule-write-webshop-ui-copy-in-british-englis-ad01'] },
    { args: ['revise', 'rule-docker-notes-ac01', '--title', 'Ask before pruning Docker images; the GPU images take hours to rebuild'] },
    { args: ['revise', 'rule-back-up-the-projects-disk-before-any-os-ab03', '--body', '-'], input: 'Owner: an upgrade wiped a partition once. The NAS address is in reference-the-backup-nas-is-nas2-lan-ab02.\n' },
    { args: ['revoke', 'reference-webshop-review-apps-are-at-pr-numb-ba51', '--reason', 'its memory note was deleted'] },
    // Budget: global is at 45 index lines after the fixes above; fold the two agent-written clusters.
    { args: ['add', 'rule', '--title', 'Format commit messages: imperative subject under 72 characters, body wrapped at 72, issue number in the body', '--scope', 'global', '--body', 'Folded from four entries.'] },
    ...['c001', 'c002', 'c003', 'c004'].map((suffix) => ({ args: ['supersede', COMMIT_RULES[suffix]!, '--by', 'rule-format-commit-messages'] })),
    { args: ['add', 'rule', '--title', 'In shell scripts: set -euo pipefail, quote every expansion, run shellcheck before committing', '--scope', 'global', '--body', 'Folded from three entries.'] },
    ...['c005', 'c006', 'c007'].map((suffix) => ({ args: ['supersede', COMMIT_RULES[suffix]!, '--by', 'rule-in-shell-scripts'] })),
  ];
  const IDEAL_REPORT = [
    '## Mirrored',
    '- -home-dev-src-webshop/codegen-after-schema.md — new rule-run-pnpm-codegen',
    '- -home-dev-src-blog/small-prs.md — new rule-keep-pull-requests',
    '- -home-dev-src-webshop/staging-url.md — superseded reference-webshop-staging-is-at-staging-old-8c01',
    '- -home-dev-src-webshop/roadmap.md — skipped: plan',
    '- -home-dev-src-webshop/cart-module.md — skipped: code fact',
    '- -home-dev-src-blog/node-version.md — skipped as revoked reference-the-blog-builds-with-node-20-9d01',
    '- -home-dev-src-blog/pipefail-before-commit.md — represented by rule-set-pipefail-before-chaining-tests-into-g-1a04',
    '- -home-dev-src-webshop/review-apps.md — deleted: revoked reference-webshop-review-apps-are-at-pr-numb-ba51',
    '- -home-dev-src-blog/no-friday-deploys.md — deleted: rule-no-blog-deploys-on-fridays-ba52 is the owner\'s, flagged',
    '## Merged',
    '- rule-install-dependencies-with-pnpm-never-npm-2b01 ← rule-use-pnpm-for-installs-not-npm-2b02',
    '- rule-ask-before-changing-the-webshop-database-2c01 ← rule-get-the-owner-s-ok-before-any-schema-mig-2c02, rule-schema-changes-in-webshop-need-owner-app-2c03',
    '- rule-open-a-pull-request-for-every-blog-chang-3d02 ← rule-commit-straight-to-main-in-the-blog-3d01',
    '- rule-don-t-edit-changelog-md-release-notes-com-3c02 ← rule-add-a-changelog-md-entry-with-every-webs-3c01',
    '- rule-bind-dev-servers-to-127-0-0-1-1b02 ← rule-don-t-expose-local-servers-on-every-net-ae01',
    '- rule-use-stripe-test-mode-for-webshop-s-local-5e01 ← rule-never-run-webshop-checkout-locally-in-st-af01',
    '- rule-write-webshop-ui-copy-in-british-englis-ad01 ← rule-use-american-spelling-in-webshop-ui-cop-ad02',
    '- rule-format-commit-messages ← rule-write-commit-subjects-in-the-imperative-c001 and three more, for the budget',
    '## Re-scoped',
    '- rule-use-stripe-test-mode-for-webshop-s-local-5e01 — global to project:webshop',
    '- reference-the-gpu-box-is-reachable-as-gpu-lan-5e02 — global to machine',
    '## Tightened',
    '- rule-docker-notes-ac01 — topic title rewritten',
    '- rule-back-up-the-projects-disk-before-any-os-ab03 — cites reference-the-backup-nas-is-nas2-lan-ab02',
    '## Retired',
    '- reference-webshop-prices-are-computed-in-src-6c01 — code fact',
    '- rule-fix-the-flaky-cart-test-next-sprint-6c02 — scheduled fix',
    '- rule-status-blog-migration-to-astro-is-60-do-6d01 — status update',
    '## Contradictions for the owner',
    '- rule-run-the-full-test-suite-before-every-com-4d01 vs rule-don-t-run-the-full-test-suite-locally-ci-4d02 — which one?',
    '- hold-don-t-merge-to-webshop-main-during-the-r-4c01 vs grant-the-release-session-may-merge-to-webshop-4c02 — may the release session merge in a freeze?',
    '## Left alone with doubt',
    '- rule-plan-ship-the-blog-redesign-in-december-7a01 — a plan, but the owner said it',
    '- rule-no-blog-deploys-on-fridays-ba52 — its note was deleted, but the owner said it',
  ].join('\n');

  it('scores the ideal run at 100 with nothing missed', () => {
    const run = shippedTrial(IDEAL, IDEAL_REPORT);
    expect(run.score.misses).toEqual([]);
    expect(run.score).toMatchObject({ falseRetirements: [], unaskedSuperseded: [], unaskedRevoked: [] });
    expect(run.values.score).toBe(100);
  }, 60_000); // About 50 sequential lb calls; under full-suite load it has passed 20 s.

  it('scores an idle run low, with no false retirements and no churn', () => {
    const run = shippedTrial([], 'done');
    expect(run.score.falseRetirements).toEqual([]);
    expect(run.score.unaskedSuperseded).toEqual([]);
    expect(run.values.score).toBeLessThan(40);
  });
});

describe('bosun trial script', () => {
  it('runs every model × repeat on a fresh fixture copy, scores each run, and writes results.json and results.md', () => {
    const w = world();
    const before = w.realSnapshot();
    const fixtureLog = readFileSync(join(w.fixture, 'store', 'log.jsonl'), 'utf8');
    const result = w.trial(['--models', 'pi:opencode-go/fake-model:low,claude:claude-fake', '--repeat', '2', '--out', w.out, '--timeout', '1']);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);

    const results = JSON.parse(readFileSync(join(w.out, 'results.json'), 'utf8'));
    expect(results.runs.map((run: any) => [run.model, run.repeat])).toEqual([
      ['pi:opencode-go/fake-model:low', 1], ['pi:opencode-go/fake-model:low', 2], ['claude:claude-fake', 1], ['claude:claude-fake', 2],
    ]);
    for (const run of results.runs) {
      expect(run.run.clean).toBe(true);
      expect(run.score.falseRetirements).toEqual([]);
      expect(run.score.retire).toEqual({ hit: 1, n: 1 });
      expect(run.score.mirror.new).toEqual({ hit: 1, n: 1 });
      expect(run.score.report.wellFormed).toBe(true);
      expect(run.values.score).toBe(100);
      expect(readdirSync(join(w.out, run.dir))).toEqual(expect.arrayContaining(['report.md', 'diff.md', 'run.json', 'transcript.jsonl', 'store']));
      expect(readFileSync(join(w.out, run.dir, 'diff.md'), 'utf8')).toContain('revoked [rule-code-fact-0002]');
    }
    expect(results.runs[0].run.model).toEqual({ requested: 'opencode-go/fake-model', reported: 'opencode-go/deepseek-v4.1-flash' });
    expect(results.runs[0].run.thinking.requested).toBe('low');
    expect(results.summary.map((row: any) => [row.model, row.n, row.metrics.score])).toEqual([
      ['pi:opencode-go/fake-model:low', 2, { mean: 100, sd: 0, n: 2 }],
      ['claude:claude-fake', 2, { mean: 100, sd: 0, n: 2 }],
    ]);

    const markdown = readFileSync(join(w.out, 'results.md'), 'utf8');
    expect(markdown).toContain('| Model | n | Score | False retirements |');
    expect(markdown).toContain('| claude:claude-fake | 2 | 100.0 ± 0.0 | 0.0 ± 0.0 |');
    expect(markdown).toContain('[report.md](claude_claude-fake/1/report.md)');

    // The fixture itself and the real store are untouched.
    expect(readFileSync(join(w.fixture, 'store', 'log.jsonl'), 'utf8')).toBe(fixtureLog);
    expect(w.realSnapshot()).toEqual(before);
  }, 20_000); // Four sequential agent runs and their child CLIs share CPU with the full suite.

  it('scores changes nobody asked for, but not the quick pass expiring a lapsed hold', () => {
    const w = world();
    const store = join(w.fixture, 'store');
    writeEntry(store, sampleEntry({ id: 'rule-bystander-a-0003', title: 'Bystander A' }));
    writeEntry(store, sampleEntry({ id: 'rule-bystander-b-0004', title: 'Bystander B' }));
    writeEntry(store, sampleEntry({ id: 'rule-already-superseded-0006', title: 'Old news', status: 'superseded' }));
    writeEntry(store, sampleEntry({ id: 'hold-lapsed-0005', kind: 'hold', title: 'Lapsed hold', until: '2020-01-01' }));
    writeFileSync(w.script, JSON.stringify([
      { args: ['add', 'rule', '--title', 'Always do X', '--scope', 'global', '--origin', 'user-stated', '--body', '-'], input: 'Why.\nSource: claude-memory -mnt-p-a/note.md\n' },
      { args: ['revoke', 'rule-code-fact-0002', '--reason', 'code fact'] },
      { args: ['supersede', 'rule-bystander-a-0003', '--by', 'rule-always-do-x'] },
      { args: ['revoke', 'rule-bystander-b-0004', '--reason', 'tidying'] },
    ]));
    const result = w.trial(['--models', 'claude:m', '--out', w.out]);
    expect(result.status).toBe(0);

    const [run] = JSON.parse(readFileSync(join(w.out, 'results.json'), 'utf8')).runs;
    expect(readFileSync(join(w.out, run.dir, 'store', 'global', 'entries', 'hold-lapsed-0005.md'), 'utf8')).toContain('status: expired');
    expect(run.score).toMatchObject({
      unaskedSuperseded: ['rule-bystander-a-0003'], unaskedRevoked: ['rule-bystander-b-0004'], unaskedEdits: 1, unaskedRetirements: 1,
    });
    expect(run.values).toMatchObject({ unaskedEdits: 1, unaskedRetirements: 1, score: 88 });

    const markdown = readFileSync(join(w.out, 'results.md'), 'utf8');
    expect(markdown).toContain('| Model | n | Score | False retirements | Unasked edits | Unasked retirements |');
    expect(markdown).toContain('| claude:m | 1 | 88.0 | 0.0 | 1.0 | 1.0 |');
    expect(markdown).toContain('| Run | Clean | Score | False retirements | Unasked edits | Unasked retirements |');
    expect(markdown).toContain('| 1 | yes | 88.0 | 0 | 1 | 1 |');
  });

  it('aborts loudly when a run writes to the real store', () => {
    const w = world();
    const result = w.trial(['--models', 'pi:m,claude:m', '--out', w.out], { FAKE_RUNNER_WRITE_REAL: '1' });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('ABORT: the real store');
    expect(result.stderr).toContain(w.real);
    const results = JSON.parse(readFileSync(join(w.out, 'results.json'), 'utf8'));
    expect(results.aborted).toContain('changed after pi:m run 1');
    expect(results.runs).toEqual([]); // the second model never ran
    expect(readFileSync(join(w.out, 'results.md'), 'utf8')).toContain('ABORTED');
  });

  it('keeps going when another session writes to the real store during a run', () => {
    const w = world();
    const result = w.trial(['--models', 'pi:m', '--out', w.out], { FAKE_RUNNER_WRITE_REAL_OTHER: '1' });
    expect(result.status).toBe(0);
    const results = JSON.parse(readFileSync(join(w.out, 'results.json'), 'utf8'));
    expect(results.aborted).toBeUndefined();
    expect(results.runs).toHaveLength(1);
  });

  it('refuses a malformed model list', () => {
    const w = world();
    const result = w.trial(['--models', 'codex:gpt', '--out', w.out]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("bad model 'codex:gpt'");
    expect(existsSync(w.out)).toBe(false);
  });
});
