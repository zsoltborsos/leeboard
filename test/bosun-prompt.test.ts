import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MirrorNote } from '../src/bosun/mirror.js';
import { capNote, NOTE_CAP_BYTES, PROMPT_TEMPLATE, renderPrompt, type RevokedEntry, SCOPE_LINE_BUDGET } from '../src/bosun/prompt.js';

function note(overrides: Partial<MirrorNote>): MirrorNote {
  return {
    path: '-mnt-p-webshop/memory/a.md', dir: '-mnt-p-webshop', file: 'a.md', absolute: '/m/-mnt-p-webshop/memory/a.md',
    status: 'new', content: 'Owner: do the thing.\n', sha256: 'x', ...overrides,
  };
}

const base = {
  runId: 'bosun-20261018T090000Z',
  today: '2026-10-18',
  memoryRoot: '/m',
  quickReport: '## Exact duplicates\n- global: a — [rule-a-0001], [rule-a-0002]\n',
  notes: [] as MirrorNote[],
  deleted: [] as string[],
  revoked: [] as RevokedEntry[],
};

describe('Bosun prompt', () => {
  it('ships the checked-in template, which inlines the admission test and the report sections', () => {
    const template = readFileSync(PROMPT_TEMPLATE, 'utf8');
    expect(PROMPT_TEMPLATE).toBe(join(import.meta.dirname, '..', 'bosun', 'prompt.md'));
    for (const text of [
      'It changes what an agent does', 'It cannot be read from the repo', 'It has an author and an end condition',
      '## Mirrored', '## Merged', '## Re-scoped', '## Tightened', '## Retired', '## Contradictions for the owner', '## Left alone with doubt',
      'Source: claude-memory', 'lb revise', 'lb supersede', 'lb revoke', 'Never run git', 'lb review', 'Revoked entries',
    ]) expect(template).toContain(text);
  });

  it('tightens and re-scopes in place, reserving supersede for replacements and merges', () => {
    const template = readFileSync(PROMPT_TEMPLATE, 'utf8');
    expect(template).toContain('`lb revise <id> --title "…"`');
    expect(template).toContain('`lb revise <id> --scope <s>`');
    expect(template).toContain('omitted fields stay\nunchanged');
    expect(template).toContain('Kind and origin cannot change');
    expect(template).toContain('preserves\nthe owner\'s meaning');
    expect(template).toContain('For a genuinely different replacement or merged content');
    expect(template).toContain('## Re-scoped\n- <id> — moved from <old scope> to <new scope>');
    expect(template).toContain('## Tightened\n- <id> — <what changed>');
    expect(template).not.toContain('There is no edit command');
    expect(template).not.toContain('- <old-id> → <new-id>');
    expect(template).toContain('write one merged entry\n  and supersede all of them by it');
    expect(template).toContain('Write the replacement\n  and supersede the old entry');
  });

  it('appends a context block with run id, date, budget, memory root and the quick-pass report', () => {
    const text = renderPrompt('TEMPLATE\n', base);
    expect(text.startsWith('TEMPLATE\n\n# Context for this run\n')).toBe(true);
    expect(text).toContain('- Run id: bosun-20261018T090000Z\n');
    expect(text).toContain('- Today: 2026-10-18\n');
    expect(text).toContain(`- Line budget: ${SCOPE_LINE_BUDGET} index lines per scope\n`);
    expect(SCOPE_LINE_BUDGET).toBe(40);
    expect(text).toContain('- Memory root: /m\n');
    expect(text).toContain('## Quick-pass report (already applied)\n\n## Exact duplicates\n- global: a — [rule-a-0001], [rule-a-0002]\n');
    expect(text).toContain('## Mirror input\n\n0 new, 0 changed, 0 deleted.\n');
  });

  it('lists each note with its path, project dir, file, source line and inline content', () => {
    const text = renderPrompt('T', {
      ...base,
      notes: [note({}), note({ path: '-mnt-p-x/memory/b.md', dir: '-mnt-p-x', file: 'b.md', absolute: '/m/-mnt-p-x/memory/b.md', status: 'changed', content: 'B\n' })],
      deleted: ['-mnt-p-y/memory/gone.md'],
    });
    expect(text).toContain('1 new, 1 changed, 1 deleted.');
    expect(text).toContain(
      '### new: -mnt-p-webshop/memory/a.md\n\n- Project dir: -mnt-p-webshop\n- File: /m/-mnt-p-webshop/memory/a.md\n' +
      '- Source line: `Source: claude-memory -mnt-p-webshop/a.md`\n\n```markdown\nOwner: do the thing.\n```\n',
    );
    expect(text).toContain('### changed: -mnt-p-x/memory/b.md\n');
    expect(text).toContain('### Deleted notes\n\n- -mnt-p-y/memory/gone.md\n');
  });

  it('lists revoked entries with scope, title and the revocation reason, so notes cannot bring them back', () => {
    expect(renderPrompt('T', base)).toContain('## Revoked entries\n\nnone\n');
    const text = renderPrompt('T', {
      ...base,
      revoked: [{ id: 'rule-old-0001', scope: 'global', title: 'Tell the owner at once', reason: 'Owner: redundant.\nSecond line.' }],
    });
    expect(text).toContain('## Revoked entries\n\n- [rule-old-0001] global: Tell the owner at once — revoked: Owner: redundant. Second line.\n');
  });

  it('fences note content with more backticks than it contains', () => {
    const text = renderPrompt('T', { ...base, notes: [note({ content: 'run:\n```bash\nls\n```\n' })] });
    expect(text).toContain('````markdown\nrun:\n```bash\nls\n```\n````\n');
  });

  it('caps each note at 4 KB on a character boundary and says so', () => {
    expect(NOTE_CAP_BYTES).toBe(4096);
    expect(capNote('short\n')).toBe('short\n');
    const long = 'é'.repeat(3000); // 6000 bytes
    const capped = capNote(long);
    const [kept, marker] = capped.split('\n[');
    expect(Buffer.byteLength(kept!)).toBeLessThanOrEqual(NOTE_CAP_BYTES);
    expect(kept).toBe('é'.repeat(2048));
    expect(marker).toContain('truncated at 4 KB');
    const text = renderPrompt('T', { ...base, notes: [note({ content: long })] });
    expect(text).toContain('é'.repeat(2048) + '\n[');
    expect(text).not.toContain('é'.repeat(2049));
  });
});
