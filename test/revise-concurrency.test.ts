import { beforeAll, describe, expect, it } from 'vitest';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import type { Kind, Status } from '../src/entry.js';
import { readLogSince } from '../src/log.js';
import type { RunResult } from '../src/result.js';
import { findEntry, listEntries, readRevision, writeEntry } from '../src/store.js';
import { requireBuild, sampleEntry, tempDir } from './helpers.js';

function writer(home: string, releaseFile: string) {
  const child = fork(new URL('./fixtures/concurrent-revise.mjs', import.meta.url), [
    new URL('../dist/run.js', import.meta.url).href, releaseFile,
  ], {
    cwd: tempDir(), env: { ...process.env, LEEBOARD_HOME: home }, execArgv: [],
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let stderr = '';
  child.stderr!.on('data', (chunk) => { stderr += String(chunk); });
  const event = <T>(type: string) => new Promise<T>((resolve, reject) => {
    child.on('message', (message: any) => {
      if (message.type === type) resolve(message);
    });
    child.once('error', reject);
  });
  return {
    child, ready: event('ready'), started: event('started'), sampled: event('sampled'),
    done: event<{ result: RunResult }>('done'), stderr: () => stderr,
  };
}

async function stopWriters(releaseFile: string, writers: ReturnType<typeof writer>[]) {
  writeFileSync(releaseFile, 'go');
  await Promise.all(writers.map(async ({ child }) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit');
    child.kill();
    await exited;
  }));
}

const lifecycleCases: {
  name: string; kind: Kind; args: (id: string) => string[]; status: Status;
  section?: string; replacement?: boolean; postpone?: boolean;
}[] = [
  { name: 'release', kind: 'hold', args: (id) => ['release', id, '--note', 'Lifecycle note'], status: 'released', section: 'Released' },
  { name: 'ack', kind: 'handoff', args: (id) => ['ack', id], status: 'done' },
  { name: 'close', kind: 'request', args: (id) => ['close', id], status: 'done' },
  { name: 'reply', kind: 'request', args: (id) => ['reply', id, '--body', 'Lifecycle note'], status: 'active', section: 'Reply' },
  { name: 'revoke', kind: 'rule', args: (id) => ['revoke', id, '--reason', 'Lifecycle note'], status: 'revoked', section: 'Revoked' },
  { name: 'supersede old', kind: 'rule', args: (id) => ['supersede', id, '--by', 'rule-next-0002'], status: 'superseded', replacement: true },
  { name: 'supersede replacement', kind: 'rule', args: (id) => ['supersede', 'rule-next-0002', '--by', id], status: 'active', replacement: true },
  { name: 'expiry', kind: 'hold', args: () => ['bosun', '--quick'], status: 'expired', section: 'Expired' },
  { name: 'postponed expiry', kind: 'handoff', args: () => ['bosun', '--quick'], status: 'expired', section: 'Expired', postpone: true },
];

function setupMixed(kind: Kind, replacement?: boolean) {
  const home = tempDir();
  const original = sampleEntry({ id: `${kind}-sample-0001`, kind, body: 'Original body\n', release: 'Owner clears it', to: 'any', until: '2020-01-01' });
  writeEntry(home, original);
  if (replacement) writeEntry(home, sampleEntry({ id: 'rule-next-0002' }));
  const releaseFile = join(tempDir(), 'release-first');
  return { home, original, releaseFile, first: writer(home, releaseFile), second: writer(home, releaseFile) };
}

const actor = (session: string) => ['--harness', 'pi', '--session', session];

describe('concurrent revision writers', () => {
  beforeAll(requireBuild);

  it('serializes snapshot capture, byte offsets, scope moves and log persistence', async () => {
    const home = tempDir();
    const original = sampleEntry({ body: 'Original 船\n' });
    writeEntry(home, original);
    const releaseFile = join(tempDir(), 'release-first');
    const first = writer(home, releaseFile);
    const second = writer(home, releaseFile);
    try {
      await Promise.all([first.ready, second.ready]);
      first.child.send({ pause: true, args: ['revise', 'rule-sample', '--title', 'First title', '--scope', 'machine', '--harness', 'pi', '--session', 'first'] });
      await first.sampled; // First writer holds a snapshot and has sampled history size 0.
      second.child.send({ pause: false, args: ['revise', original.id, '--body', 'Second body', '--harness', 'pi', '--session', 'second'] });
      await second.started;
      // Without the lock the second process can complete while the first is paused,
      // using the stale snapshot and the same history offset.
      expect(await Promise.race([second.done.then(() => 'finished'), setTimeout(200, 'waiting')])).toBe('waiting');
      expect(readLogSince(home, 0).lines).toEqual([]);
      writeFileSync(releaseFile, 'go');
      const results = await Promise.all([first.done, second.done]);
      expect(results.map(({ result }) => result.code), first.stderr() + second.stderr()).toEqual([0, 0]);
      expect(results.map(({ result }) => result.stderr)).toEqual(['', '']);

      const lines = readLogSince(home, 0).lines;
      expect(lines.map((line) => [line.event, line.session, line.scope])).toEqual([
        ['revised', 'first', 'machine'], ['revised', 'second', 'machine'],
      ]);
      const records = readFileSync(join(home, 'revisions', `${original.id}.jsonl`), 'utf8').trimEnd().split('\n').map((line) => JSON.parse(line));
      expect(records).toHaveLength(2);
      expect(lines[0]!.revision!.offset).toBe(0);
      expect(lines[1]!.revision!.offset).toBe(Buffer.byteLength(JSON.stringify(records[0]) + '\n'));
      expect(readRevision(home, original.id, lines[0]!.revision!.offset)).toEqual(records[0]);
      expect(readRevision(home, original.id, lines[1]!.revision!.offset)).toEqual(records[1]);
      expect(records[0]).toMatchObject({ session: 'first', before: { title: original.title, body: original.body, scope: 'global' } });
      expect(records[1]).toMatchObject({ session: 'second', before: { title: 'First title', body: original.body, scope: 'machine' } });
      expect(findEntry(home, original.id)).toMatchObject({ title: 'First title', body: 'Second body\n', scope: 'machine' });
      expect(listEntries(home)).toHaveLength(1);
      expect(existsSync(join(home, 'state', 'revision.lock'))).toBe(false);
    } finally {
      await stopWriters(releaseFile, [first, second]);
    }
  }, 10_000);

  it.skipIf(process.env.LEEBOARD_TEST_FUTURE)('a delayed stale-lock contender cannot take over the winner fresh lock', async () => {
    const home = tempDir();
    const original = sampleEntry({ body: 'Original body\n' });
    writeEntry(home, original);
    const lock = join(home, 'state', 'revision.lock');
    mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, ts: new Date(Date.now() - 20_000).toISOString() }));
    const releaseFirst = join(tempDir(), 'release-winner');
    const releaseSecond = join(tempDir(), 'release-contender');
    const first = writer(home, releaseFirst);
    const second = writer(home, releaseSecond);
    try {
      await Promise.all([first.ready, second.ready]);
      second.child.send({ pause: 'recovery', args: ['revise', original.id, '--body', 'Second body', ...actor('second')] });
      await second.sampled; // It observed the old lock, but has not claimed recovery yet.
      first.child.send({ pause: true, args: ['revise', original.id, '--title', 'First title', '--scope', 'machine', ...actor('first')] });
      await first.sampled; // The winner recovered the stale lock and now holds a fresh one.
      writeFileSync(releaseSecond, 'go');
      expect(await Promise.race([second.done.then(() => 'finished'), setTimeout(200, 'waiting')])).toBe('waiting');
      expect(JSON.parse(readFileSync(join(lock, 'owner.json'), 'utf8')).pid).toBe(first.child.pid);
      writeFileSync(releaseFirst, 'go');
      const results = await Promise.all([first.done, second.done]);
      expect(results.map(({ result }) => result.code), first.stderr() + second.stderr()).toEqual([0, 0]);
      const lines = readLogSince(home, 0).lines;
      expect(lines.map((line) => line.session)).toEqual(['first', 'second']);
      expect(readRevision(home, original.id, lines[1]!.revision!.offset)!.before).toMatchObject({ title: 'First title', scope: 'machine', body: original.body });
      expect(findEntry(home, original.id)).toMatchObject({ title: 'First title', body: 'Second body\n', scope: 'machine' });
      expect(existsSync(lock)).toBe(false);
    } finally {
      await stopWriters(releaseFirst, [first]);
      await stopWriters(releaseSecond, [second]);
    }
  }, 10_000);

  it('allows lb add to complete while another process holds a fresh mutation lock', async () => {
    const { home, original, releaseFile, first, second } = setupMixed('rule');
    try {
      await Promise.all([first.ready, second.ready]);
      first.child.send({ pause: true, args: ['revise', original.id, '--scope', 'machine', ...actor('revision')] });
      await first.sampled;
      second.child.send({ pause: false, args: ['add', 'rule', '--title', 'Another rule', '--scope', 'global', ...actor('creation')] });
      await second.started;
      expect(await Promise.race([second.done.then(() => 'finished'), setTimeout(1000, 'waiting')])).toBe('finished');
      expect((await second.done).result.code).toBe(0);
      expect(readLogSince(home, 0).lines.map((line) => line.event)).toEqual(['created']);
      expect(JSON.parse(readFileSync(join(home, 'state', 'revision.lock', 'owner.json'), 'utf8')).pid).toBe(first.child.pid);
      writeFileSync(releaseFile, 'go');
      const results = await Promise.all([first.done, second.done]);
      expect(results.map(({ result }) => result.code), first.stderr() + second.stderr()).toEqual([0, 0]);
      expect(readLogSince(home, 0).lines.map((line) => [line.event, line.session])).toEqual([
        ['created', 'creation'], ['revised', 'revision'],
      ]);
      expect(listEntries(home)).toHaveLength(2);
      expect(findEntry(home, original.id).scope).toBe('machine');
      expect(existsSync(join(home, 'state', 'revision.lock'))).toBe(false);
    } finally {
      await stopWriters(releaseFile, [first, second]);
    }
  }, 10_000);

  it.each(lifecycleCases)('runs $name against the revised scope and latest fields', async ({ kind, args, status, section, replacement, postpone }) => {
    const { home, original, releaseFile, first, second } = setupMixed(kind, replacement);
    try {
      await Promise.all([first.ready, second.ready]);
      first.child.send({ pause: true, args: ['revise', original.id, '--title', 'Revised title', '--body', 'Revised body', '--scope', 'machine', ...(postpone ? ['--until', '9999-01-01'] : []), ...actor('revision')] });
      await first.sampled;
      second.child.send({ pause: false, args: [...args(original.id), ...actor('lifecycle')] });
      await second.started;
      expect(await Promise.race([second.done.then(() => 'finished'), setTimeout(200, 'waiting')])).toBe('waiting');
      expect(readLogSince(home, 0).lines).toEqual([]);
      writeFileSync(releaseFile, 'go');
      const results = await Promise.all([first.done, second.done]);
      expect(results.map(({ result }) => result.code), first.stderr() + second.stderr()).toEqual([0, 0]);

      const entry = findEntry(home, original.id);
      expect(entry).toMatchObject({ scope: 'machine', title: 'Revised title', status: postpone ? 'active' : status });
      let expectedBody = 'Revised body\n';
      if (section && !postpone) {
        expectedBody += `\n## ${section} (${entry.updated}, ${section === 'Expired' ? 'bosun' : 'pi/lifecycle'})\n`;
        if (section !== 'Expired') expectedBody += 'Lifecycle note\n';
      }
      expect(entry.body).toBe(expectedBody);
      if (replacement) {
        const successor = findEntry(home, status === 'active' ? original.id : 'rule-next-0002');
        expect(successor.supersedes).toEqual([status === 'active' ? 'rule-next-0002' : original.id]);
      }
      const lines = readLogSince(home, 0).lines.filter((line) => line.id === original.id);
      expect(lines.map((line) => [line.event, line.scope, line.status])).toEqual([
        ['revised', 'machine', 'active'],
        ...(postpone ? [] : [[status === 'active' ? 'updated' : 'status', 'machine', status]]),
      ]);
      expect(listEntries(home).filter((item) => item.id === original.id)).toHaveLength(1);
      expect(existsSync(join(home, 'global', 'entries', `${original.id}.md`))).toBe(false);
      expect(existsSync(join(home, 'state', 'revision.lock'))).toBe(false);
    } finally {
      await stopWriters(releaseFile, [first, second]);
    }
  }, 10_000);

  it.each(lifecycleCases.filter(({ postpone }) => !postpone))('waits for $name before reading revision eligibility and snapshot', async ({ kind, args, status, section, replacement }) => {
    const { home, original, releaseFile, first, second } = setupMixed(kind, replacement);
    try {
      await Promise.all([first.ready, second.ready]);
      first.child.send({ pause: 'write', args: [...args(original.id), ...actor('lifecycle')] });
      await first.sampled; // Lifecycle has read its entries but has not persisted them.
      second.child.send({ pause: false, args: ['revise', original.id, '--title', 'Revised title', '--scope', 'machine', ...actor('revision')] });
      await second.started;
      expect(await Promise.race([second.done.then(() => 'finished'), setTimeout(200, 'waiting')])).toBe('waiting');
      writeFileSync(releaseFile, 'go');
      const results = await Promise.all([first.done, second.done]);
      expect(results.map(({ result }) => result.code), first.stderr() + second.stderr()).toEqual([0, status === 'active' ? 0 : 5]);

      const entry = findEntry(home, original.id);
      expect(entry).toMatchObject({ status, scope: status === 'active' ? 'machine' : 'global', title: status === 'active' ? 'Revised title' : original.title });
      if (section) expect(entry.body).toContain(`## ${section} (`);
      if (replacement && status === 'active') expect(entry.supersedes).toEqual(['rule-next-0002']);
      const lines = readLogSince(home, 0).lines.filter((line) => line.id === original.id);
      expect(lines.map((line) => line.event)).toEqual(status === 'active' ? ['updated', 'revised'] : ['status']);
      if (status === 'active') {
        expect(readRevision(home, original.id, lines[1]!.revision!.offset)!.before.body).toBe(entry.body);
      } else {
        expect(existsSync(join(home, 'revisions'))).toBe(false);
      }
      expect(listEntries(home).filter((item) => item.id === original.id)).toHaveLength(1);
      expect(existsSync(join(home, 'state', 'revision.lock'))).toBe(false);
    } finally {
      await stopWriters(releaseFile, [first, second]);
    }
  }, 10_000);
});
