import type { Summary } from './entry.js';

/** `title — release: … — until: … — blocks: …`: the one-line form of a hold. */
export function describeHold(hold: Pick<Summary, 'title' | 'release' | 'until' | 'blocks'>): string {
  const parts = [hold.title];
  if (hold.release) parts.push(`release: ${hold.release}`);
  if (hold.until) parts.push(`until: ${hold.until}`);
  if (hold.blocks?.length) parts.push(`blocks: ${hold.blocks.join(', ')}`);
  return parts.join(' — ');
}

const MAX_LINE = 300;

export function clip(line: string): string {
  return line.length > MAX_LINE ? line.slice(0, MAX_LINE - 1) + '…' : line;
}

export const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;
