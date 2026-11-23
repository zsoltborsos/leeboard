import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readWatermark, scanMirror, writeWatermark } from '../src/bosun/mirror.js';
import { EXIT, LeeboardError } from '../src/errors.js';
import { tempDir } from './helpers.js';

const sha = (text: string) => createHash('sha256').update(text).digest('hex');

function note(root: string, dir: string, file: string, content: string): void {
  mkdirSync(join(root, dir, 'memory'), { recursive: true });
  writeFileSync(join(root, dir, 'memory', file), content);
}

describe('mirror scan', () => {
  it('reports every note as new against an empty watermark, skipping MEMORY.md and non-notes', () => {
    const root = tempDir('lb-memory-');
    note(root, '-mnt-p-a', 'one.md', 'one\n');
    note(root, '-mnt-p-a', 'MEMORY.md', '- index\n');
    note(root, '-mnt-p-b', 'two.md', 'two\n');
    note(root, '-mnt-p-b', 'notes.txt', 'not markdown\n');
    note(root, '-mnt-p-b', '.hidden.md', 'hidden\n');
    mkdirSync(join(root, '-mnt-p-c'), { recursive: true });
    writeFileSync(join(root, '-mnt-p-c', 'session.jsonl'), '{}\n');
    writeFileSync(join(root, '-mnt-p-c', 'stray.md'), 'not under memory/\n');

    const scan = scanMirror(root, {});
    expect(scan.notes).toEqual([
      { path: '-mnt-p-a/memory/one.md', dir: '-mnt-p-a', file: 'one.md', absolute: join(root, '-mnt-p-a', 'memory', 'one.md'), status: 'new', content: 'one\n', sha256: sha('one\n') },
      { path: '-mnt-p-b/memory/two.md', dir: '-mnt-p-b', file: 'two.md', absolute: join(root, '-mnt-p-b', 'memory', 'two.md'), status: 'new', content: 'two\n', sha256: sha('two\n') },
    ]);
    expect(scan.deleted).toEqual([]);
    expect(scan.next).toEqual({ '-mnt-p-a/memory/one.md': sha('one\n'), '-mnt-p-b/memory/two.md': sha('two\n') });
  });

  it('separates unchanged, changed, new and deleted notes', () => {
    const root = tempDir('lb-memory-');
    note(root, 'd', 'same.md', 'same\n');
    note(root, 'd', 'edited.md', 'after\n');
    note(root, 'd', 'fresh.md', 'fresh\n');
    const previous = { 'd/memory/same.md': sha('same\n'), 'd/memory/edited.md': sha('before\n'), 'd/memory/gone.md': sha('gone\n') };

    const scan = scanMirror(root, previous);
    expect(scan.notes.map((n) => [n.path, n.status])).toEqual([
      ['d/memory/edited.md', 'changed'],
      ['d/memory/fresh.md', 'new'],
    ]);
    expect(scan.deleted).toEqual(['d/memory/gone.md']);
    expect(scan.next).toEqual({ 'd/memory/edited.md': sha('after\n'), 'd/memory/fresh.md': sha('fresh\n'), 'd/memory/same.md': sha('same\n') });
  });

  it('refuses a memory root that does not exist rather than reporting every note deleted', () => {
    const root = join(tempDir('lb-memory-'), 'missing');
    let error: unknown;
    try {
      scanMirror(root, { 'd/memory/a.md': sha('a') });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(LeeboardError);
    expect((error as LeeboardError).exitCode).toBe(EXIT.USAGE);
    expect((error as LeeboardError).message).toContain(root);
  });

  it('reads a missing root as empty with allowMissing, but only while nothing was mirrored', () => {
    const root = join(tempDir('lb-memory-'), 'missing');
    expect(scanMirror(root, {}, { allowMissing: true })).toEqual({ notes: [], deleted: [], next: {} });
    expect(() => scanMirror(root, { 'd/memory/a.md': sha('a') }, { allowMissing: true })).toThrow(LeeboardError);
    expect(() => scanMirror(root, {})).toThrow(LeeboardError);
  });
});

describe('mirror watermark', () => {
  it('is empty when absent and round-trips through state/bosun/mirror.json', () => {
    const home = tempDir('lb-home-');
    expect(readWatermark(home)).toEqual({});
    writeWatermark(home, { 'd/memory/a.md': sha('a') });
    expect(JSON.parse(readFileSync(join(home, 'state', 'bosun', 'mirror.json'), 'utf8'))).toEqual({ 'd/memory/a.md': sha('a') });
    expect(readWatermark(home)).toEqual({ 'd/memory/a.md': sha('a') });
  });

  it('treats an unreadable watermark as empty', () => {
    const home = tempDir('lb-home-');
    mkdirSync(join(home, 'state', 'bosun'), { recursive: true });
    writeFileSync(join(home, 'state', 'bosun', 'mirror.json'), '{not json');
    expect(readWatermark(home)).toEqual({});
    rmSync(join(home, 'state', 'bosun', 'mirror.json'));
    writeFileSync(join(home, 'state', 'bosun', 'mirror.json'), '["a"]');
    expect(readWatermark(home)).toEqual({});
  });
});
