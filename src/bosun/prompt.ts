import { fileURLToPath } from 'node:url';
import type { MirrorNote } from './mirror.js';

/** `bosun/prompt.md` at the repository root, from both `src/bosun` and `dist/bosun`. */
export const PROMPT_TEMPLATE = fileURLToPath(new URL('../../bosun/prompt.md', import.meta.url));

export const NOTE_CAP_BYTES = 4096;
export const SCOPE_LINE_BUDGET = 40;

export interface RevokedEntry {
  id: string;
  scope: string;
  title: string;
  reason: string;
}

export interface PromptContext {
  runId: string;
  /** YYYY-MM-DD. */
  today: string;
  memoryRoot: string;
  /** The rendered quick-pass report. */
  quickReport: string;
  notes: MirrorNote[];
  deleted: string[];
  /** Retired on purpose; a memory note that outlived its entry must not bring it back. */
  revoked: RevokedEntry[];
}

/** At most 4 KB of the note, cut on a character boundary, with a marker when cut. */
export function capNote(content: string): string {
  const bytes = Buffer.from(content, 'utf8');
  if (bytes.length <= NOTE_CAP_BYTES) return content;
  const kept = bytes.subarray(0, NOTE_CAP_BYTES).toString('utf8').replace(/�+$/, '');
  return `${kept}\n[… truncated at 4 KB; read the file for the rest]\n`;
}

function fenced(content: string): string {
  const longest = Math.max(0, ...[...content.matchAll(/`+/g)].map((match) => match[0].length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}markdown\n${content.replace(/\n?$/, '\n')}${fence}\n`;
}

/** The template followed by this run's context block. */
export function renderPrompt(template: string, context: PromptContext): string {
  const counts = (status: MirrorNote['status']) => context.notes.filter((note) => note.status === status).length;
  const parts = [
    template.trimEnd(),
    '',
    '# Context for this run',
    '',
    `- Run id: ${context.runId}`,
    `- Today: ${context.today}`,
    `- Line budget: ${SCOPE_LINE_BUDGET} index lines per scope`,
    `- Memory root: ${context.memoryRoot}`,
    '',
    '## Quick-pass report (already applied)',
    '',
    context.quickReport.trimEnd(),
    '',
    '## Revoked entries',
    '',
    ...(context.revoked.length === 0
      ? ['none']
      : context.revoked.map((entry) => `- [${entry.id}] ${entry.scope}: ${entry.title} — revoked: ${entry.reason.trim().replace(/\s*\n\s*/g, ' ')}`)),
    '',
    '## Mirror input',
    '',
    `${counts('new')} new, ${counts('changed')} changed, ${context.deleted.length} deleted.`,
  ];
  for (const note of context.notes) {
    parts.push(
      '',
      `### ${note.status}: ${note.path}`,
      '',
      `- Project dir: ${note.dir}`,
      `- File: ${note.absolute}`,
      `- Source line: \`Source: claude-memory ${note.dir}/${note.file}\``,
      '',
      fenced(capNote(note.content)).trimEnd(),
    );
  }
  if (context.deleted.length > 0) {
    parts.push('', '### Deleted notes', '', ...context.deleted.map((path) => `- ${path}`));
  }
  return parts.join('\n') + '\n';
}
