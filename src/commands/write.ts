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

function createCommand(ctx: () => Ctx, kind: string, flags: WriteFlags): RunResult {
  const context = ctx();
  const fields = entryFields(flags);
  return summaryResult(createEntry(context, { ...fields, kind, title: fields.title ?? '' }), flags);
}

export function addCommand(ctx: () => Ctx, kind: string | undefined, flags: WriteFlags): RunResult {
  if (kind === undefined) throw usageError('usage: lb add <kind>');
  return createCommand(ctx, kind, flags);
}

export function holdCommand(ctx: () => Ctx, flags: WriteFlags): RunResult {
  return createCommand(ctx, 'hold', flags);
}

export function grantCommand(ctx: () => Ctx, flags: WriteFlags): RunResult {
  return createCommand(ctx, 'grant', flags);
}

export function handoffCommand(ctx: () => Ctx, flags: WriteFlags): RunResult {
  return createCommand(ctx, 'handoff', flags);
}

export function requestCommand(ctx: () => Ctx, flags: WriteFlags): RunResult {
  return createCommand(ctx, 'request', flags);
}

export function reviseCommand(ctx: () => Ctx, id: string | undefined, flags: WriteFlags): RunResult {
  if (id === undefined) throw usageError('usage: lb revise <id>');
  for (const flag of ['kind', 'origin', 'status'] as const) {
    if (flags[flag] !== undefined) throw usageError(`--${flag} cannot be changed by revise`);
  }
  return summaryResult(reviseEntry(ctx(), id, entryFields(flags)), flags);
}

export function releaseCommand(ctx: () => Ctx, id: string | undefined, flags: WriteFlags): RunResult {
  return summaryResult(releaseHold(ctx(), id ?? fail('usage: lb release <id>'), flags.note), flags);
}

export function ackCommand(ctx: () => Ctx, id: string | undefined, flags: WriteFlags): RunResult {
  return summaryResult(ackHandoff(ctx(), id ?? fail('usage: lb ack <id>')), flags);
}

export function closeCommand(ctx: () => Ctx, id: string | undefined, flags: WriteFlags): RunResult {
  return summaryResult(closeRequest(ctx(), id ?? fail('usage: lb close <id>')), flags);
}

export function replyCommand(ctx: () => Ctx, id: string | undefined, flags: WriteFlags): RunResult {
  return summaryResult(replyToRequest(ctx(), id ?? fail('usage: lb reply <id>'), readBody(flags.body) ?? ''), flags);
}

export function revokeCommand(ctx: () => Ctx, id: string | undefined, flags: WriteFlags): RunResult {
  return summaryResult(revokeEntry(ctx(), id ?? fail('usage: lb revoke <id>'), flags.reason ?? ''), flags);
}

export function supersedeCommand(ctx: () => Ctx, id: string | undefined, flags: WriteFlags): RunResult {
  return summaryResult(supersedeEntry(ctx(), id ?? fail('usage: lb supersede <old-id>'), flags.by ?? fail('usage: lb supersede <old-id> --by <new-id>')), flags);
}

function fail(message: string): never {
  throw usageError(message);
}

export function initCommand(home: string, flags: { json?: boolean }): RunResult {
  initStore(home);
  return ok(flags.json ? jsonLine({ home }) : `initialised ${home}\n`);
}
