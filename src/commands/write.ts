import { readFileSync } from 'node:fs';
import { ackHandoff, closeRequest, createEntry, releaseHold, replyToRequest, reviseEntry, revokeEntry, supersedeEntry, type RevisionInput } from '../change.js';
import type { Ctx } from '../context.js';
import { type Entry, summarize } from '../entry.js';
import { usageError } from '../errors.js';
import { jsonLine, ok, type RunResult } from '../result.js';
import { initStore } from '../store.js';
import { renderList } from './read.js';

interface WriteFlags {
  json?: boolean;
  title?: string;
  body?: string;
  scope?: string;
  until?: string;
  release?: string;
  blocks?: string;
  holder?: string;
  to?: string;
  kind?: string;
  origin?: string;
  status?: string;
  note?: string;
  reason?: string;
  by?: string;
}

function entryFields(flags: WriteFlags): RevisionInput {
  return {
    title: flags.title,
    body: readBody(flags.body),
    scope: flags.scope,
    until: flags.until,
    release: flags.release,
    blocks: flags.blocks?.split(',').map((tag) => tag.trim()).filter(Boolean),
    holder: flags.holder,
    to: flags.to,
  };
}

/** `--body -` reads the body from stdin. */
function readBody(body: string | undefined): string | undefined {
  return body === '-' ? readFileSync(0, 'utf8') : body;
}

function summaryResult(entry: Entry, flags: WriteFlags): RunResult {
  return ok(flags.json ? jsonLine(summarize(entry)) : renderList([summarize(entry)]));
}

export function createCommand(ctx: Ctx, kind: string, flags: WriteFlags): RunResult {
  const fields = entryFields(flags);
  return summaryResult(createEntry(ctx, { ...fields, kind, title: fields.title ?? '' }), flags);
}

export function addCommand(ctx: () => Ctx, kind: string | undefined, flags: WriteFlags): RunResult {
  const entryKind = requireArg('add', 'kind', kind);
  return createCommand(ctx(), entryKind, flags);
}

export function reviseCommand(ctx: () => Ctx, id: string | undefined, flags: WriteFlags): RunResult {
  const entryId = requireArg('revise', 'id', id);
  for (const flag of ['kind', 'origin', 'status'] as const) {
    if (flags[flag] !== undefined) throw usageError(`--${flag} cannot be changed by revise`);
  }
  return summaryResult(reviseEntry(ctx(), entryId, entryFields(flags)), flags);
}

export function releaseCommand(ctx: Ctx, id: string | undefined, flags: WriteFlags): RunResult {
  return summaryResult(releaseHold(ctx, requireArg('release', 'id', id), flags.note), flags);
}

export function ackCommand(ctx: Ctx, id: string | undefined, flags: WriteFlags): RunResult {
  return summaryResult(ackHandoff(ctx, requireArg('ack', 'id', id)), flags);
}

export function closeCommand(ctx: Ctx, id: string | undefined, flags: WriteFlags): RunResult {
  return summaryResult(closeRequest(ctx, requireArg('close', 'id', id)), flags);
}

export function replyCommand(ctx: Ctx, id: string | undefined, flags: WriteFlags): RunResult {
  return summaryResult(replyToRequest(ctx, requireArg('reply', 'id', id), readBody(flags.body) ?? ''), flags);
}

export function revokeCommand(ctx: Ctx, id: string | undefined, flags: WriteFlags): RunResult {
  return summaryResult(revokeEntry(ctx, requireArg('revoke', 'id', id), flags.reason ?? ''), flags);
}

export function supersedeCommand(ctx: Ctx, id: string | undefined, flags: WriteFlags): RunResult {
  const oldId = requireArg('supersede', 'old-id', id);
  if (flags.by === undefined) throw usageError('usage: lb supersede <old-id> --by <new-id>');
  return summaryResult(supersedeEntry(ctx, oldId, flags.by), flags);
}

function requireArg(command: string, name: string, value: string | undefined): string {
  if (value === undefined) throw usageError(`usage: lb ${command} <${name}>`);
  return value;
}

export function initCommand(home: string, flags: { json?: boolean }): RunResult {
  initStore(home);
  return ok(flags.json ? jsonLine({ home }) : `initialised ${home}\n`);
}
