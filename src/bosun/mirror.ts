import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { EXIT, LeeboardError } from '../errors.js';
import { writeFileAtomic } from '../store.js';

/** Note path relative to the memory root (`<encoded-dir>/memory/<file>.md`) -> sha256 of its content. */
export type Watermark = Record<string, string>;

export interface MirrorNote {
  path: string;
  /** The encoded project directory, e.g. `-home-user-src-webshop`. */
  dir: string;
  file: string;
  absolute: string;
  status: 'new' | 'changed';
  content: string;
  sha256: string;
}

export interface MirrorScan {
  /** New and changed notes, by path. */
  notes: MirrorNote[];
  /** Watermarked paths that no longer exist. */
  deleted: string[];
  /** The watermark to record once the run has handled this input. */
  next: Watermark;
}

function watermarkPath(home: string): string {
  return join(home, 'state', 'bosun', 'mirror.json');
}

/** The last recorded watermark; missing or unreadable means none. */
export function readWatermark(home: string): Watermark {
  try {
    const data: unknown = JSON.parse(readFileSync(watermarkPath(home), 'utf8'));
    if (typeof data !== 'object' || data === null || Array.isArray(data)) return {};
    return Object.fromEntries(Object.entries(data).filter((pair): pair is [string, string] => typeof pair[1] === 'string'));
  } catch {
    return {};
  }
}

export function writeWatermark(home: string, watermark: Watermark): void {
  writeFileAtomic(watermarkPath(home), JSON.stringify(watermark, null, 2) + '\n');
}

function listDir(path: string): string[] {
  try {
    return readdirSync(path).sort();
  } catch {
    return [];
  }
}

/**
 * Claude memory notes (`<root>/*\/memory/*.md`, excluding `MEMORY.md`) compared with the
 * previous watermark. A missing root is an error: treating it as empty would report every
 * mirrored note as deleted. `allowMissing` (the default root, for a store without Claude Code)
 * reads a missing root as empty, but only while nothing has been mirrored yet.
 */
export function scanMirror(root: string, previous: Watermark, options: { allowMissing?: boolean } = {}): MirrorScan {
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    if (options.allowMissing && Object.keys(previous).length === 0) return { notes: [], deleted: [], next: {} };
    throw new LeeboardError(`memory root ${root} is not a directory`, EXIT.USAGE);
  }
  const notes: MirrorNote[] = [];
  const next: Watermark = {};
  for (const dir of listDir(root)) {
    const memory = join(root, dir, 'memory');
    for (const file of listDir(memory)) {
      if (!file.endsWith('.md') || file.startsWith('.') || file === 'MEMORY.md') continue;
      const absolute = join(memory, file);
      if (!statSync(absolute).isFile()) continue;
      const content = readFileSync(absolute, 'utf8');
      const sha256 = createHash('sha256').update(content).digest('hex');
      const path = `${dir}/memory/${file}`;
      next[path] = sha256;
      if (previous[path] === sha256) continue;
      notes.push({ path, dir, file, absolute, status: previous[path] === undefined ? 'new' : 'changed', content, sha256 });
    }
  }
  const deleted = Object.keys(previous).filter((path) => next[path] === undefined).sort();
  return { notes, deleted, next };
}
