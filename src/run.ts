import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { briefCommand } from './commands/brief.js';
import { bosun, renderBosun } from './commands/bosun.js';
import { checkCommand } from './commands/check.js';
import { deltaCommand } from './commands/delta.js';
import { usage as usageReport, renderUsage } from './commands/usage.js';
import { listCommand, type ReadCtx, renderList, searchEntries, showCommand } from './commands/read.js';
import { reviewCommand } from './commands/review.js';
import { ackHandoff, closeRequest, releaseHold, replyToRequest, revokeEntry, supersedeEntry } from './change.js';
import { addCommand, grantCommand, handoffCommand, holdCommand, initCommand, requestCommand, reviseCommand } from './commands/write.js';
import type { Ctx } from './context.js';
import { type Entry, summarize } from './entry.js';
import { EXIT, LeeboardError, usageError } from './errors.js';
import { resolveIdentity } from './identity.js';
import { removeProject } from './project-remove.js';
import { renameProject } from './project-rename.js';
import { addProject, listProjects, type Project } from './projects.js';
import { purgeCommand, PURGE_CLOSED_DESCRIPTION } from './commands/purge.js';
import { resolveHome } from './store.js';
import { jsonLine, ok, type RunResult } from './result.js';

const USAGE = `Usage: lb <command> [options]

  lb --version, -v                        print the installed package version
  lb brief [--cwd <dir>]                  session-start orientation
  lb delta [--cwd <dir>]                  changes since this session last looked
  lb review [--peek] [--json]             owner digest; marks it seen unless --peek
  lb check --blocks <tag> [--cwd <dir>]   exit 3 if an active hold blocks the tag
  lb usage [--since <ISO date>] [--json]  observed brief/check usage
  lb bosun [--quick] [--dry-run] [--json]
                                          deterministic store maintenance
  lb bosun --full --runner <pi|claude> --model <id> [--thinking <level>]
           [--memory-root <dir>] [--timeout <minutes>] [--if-changed] [--json]
                                          LLM maintenance pass
  lb add <rule|reference|grant|hold|handoff|request> --title <t> [--body <text>|-] [--scope <s>]
  lb hold --title <t> --release <text> [--blocks a,b] [--until <date>]
  lb grant --title <t> --holder <who>
  lb handoff --title <t> --to <target>    also: lb request
  lb release <id> [--note <text>]
  lb ack <id>
  lb close <id>
  lb reply <id> --body <text>|-
  lb revoke <id> --reason <text>
  lb revise <id> [--title <t>] [--body <text>|-] [--scope <s>] [--until <d>]
           [--release <t>] [--blocks a,b] [--holder <h>] [--to <target>]
  lb supersede <old-id> --by <new-id>
  lb show <id>
  lb list [--kind k] [--scope s] [--status s|--all] [--session <id>] [--harness <name>]
       --status lapsed                    past its until date, not yet expired by Bosun
  lb search <text> [--all]                active entries only, unless --all
  lb purge <id>... [--dry-run]            delete entries for good (owner's word; not Bosun or Helmraiser)
  lb purge --closed [--days <n>] [--dry-run]
                                          ${PURGE_CLOSED_DESCRIPTION}
  lb init
  lb project add <name> --path <p> [--remote url]...
  lb project rename <old> <new> [--path <p>]
  lb project list
  lb project remove <name> [--path <p>]...
                                          unregister a project with no entries left, or drop paths

List filters on the entry author: --session and --harness combine with --kind, --scope and --status,
and list every status unless --status is given.
Targets (--to): project:<name>, session:<id>, harness:<name>, any.
Identity: --harness --session --origin, or LEEBOARD_HARNESS / LEEBOARD_SESSION,
or else CLAUDE_CODE_SESSION_ID (claude-code) / PI_SESSION_ID (pi).
Store: LEEBOARD_HOME (default ~/.leeboard). Every command accepts --json.
Ids may be abbreviated to a unique prefix, or to their four-character hash.
Exit codes: 0 success, 1 usage, 2 credential rejection, 3 check blocked, 4 unknown/ambiguous id, 5 disallowed transition, 6 not permitted.
`;

const OPTIONS = {
  json: { type: 'boolean' },
  peek: { type: 'boolean' },
  help: { type: 'boolean' },
  version: { type: 'boolean', short: 'v' },
  quick: { type: 'boolean' },
  full: { type: 'boolean' },
  'if-changed': { type: 'boolean' },
  'dry-run': { type: 'boolean' },
  all: { type: 'boolean' },
  closed: { type: 'boolean' },
  days: { type: 'string' },
  cwd: { type: 'string' },
  harness: { type: 'string' },
  session: { type: 'string' },
  origin: { type: 'string' },
  scope: { type: 'string' },
  title: { type: 'string' },
  body: { type: 'string' },
  release: { type: 'string' },
  blocks: { type: 'string' },
  until: { type: 'string' },
  since: { type: 'string' },
  holder: { type: 'string' },
  to: { type: 'string' },
  note: { type: 'string' },
  reason: { type: 'string' },
  by: { type: 'string' },
  kind: { type: 'string' },
  status: { type: 'string' },
  runner: { type: 'string' },
  model: { type: 'string' },
  thinking: { type: 'string' },
  'memory-root': { type: 'string' },
  timeout: { type: 'string' },
  path: { type: 'string', multiple: true },
  remote: { type: 'string', multiple: true },
} as const;

export async function run(argv: string[], env: NodeJS.ProcessEnv, cwd: string): Promise<RunResult> {
  try {
    return await dispatch(argv, env, cwd);
  } catch (error) {
    const code = error instanceof LeeboardError ? error.exitCode : EXIT.USAGE;
    return { code, stdout: '', stderr: `lb: ${error instanceof Error ? error.message : String(error)}\n` };
  }
}

async function dispatch(argv: string[], env: NodeJS.ProcessEnv, cwd: string): Promise<RunResult> {
  const { values, positionals } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });
  if (values.help) return ok(USAGE);
  if (values.version) {
    const { version } = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { version: string };
    return ok(`${version}\n`);
  }
  const [command, ...args] = positionals;
  if (!command) throw usageError('no command given (try --help)');

  const home = resolveHome(env);
  const readCtx: ReadCtx = { home, now: new Date() };
  const ctx = (): Ctx => ({
    ...readCtx,
    cwd: values.cwd ? resolve(values.cwd) : cwd,
    identity: resolveIdentity(values, env),
  });
  const arg = (index: number, name: string): string => args[index] ?? fail(`usage: lb ${command} <${name}>`);
  const showEntrySummary = (entry: Entry): RunResult => ok(values.json ? jsonLine(summarize(entry)) : renderList([summarize(entry)]));

  switch (command) {
    case 'init':
      return initCommand(home, values);
    case 'add':
      return addCommand(ctx, args[0], values);
    case 'hold':
      return holdCommand(ctx, values);
    case 'grant':
      return grantCommand(ctx, values);
    case 'handoff':
      return handoffCommand(ctx, values);
    case 'request':
      return requestCommand(ctx, values);

    case 'revise':
      return reviseCommand(ctx, args[0], values);
    case 'release':
      return showEntrySummary(releaseHold(ctx(), arg(0, 'id'), values.note));
    case 'ack':
      return showEntrySummary(ackHandoff(ctx(), arg(0, 'id')));
    case 'close':
      return showEntrySummary(closeRequest(ctx(), arg(0, 'id')));
    case 'reply':
      return showEntrySummary(replyToRequest(ctx(), arg(0, 'id'), readBody(values.body) ?? ''));
    case 'revoke':
      return showEntrySummary(revokeEntry(ctx(), arg(0, 'id'), values.reason ?? ''));
    case 'supersede':
      return showEntrySummary(supersedeEntry(ctx(), arg(0, 'old-id'), values.by ?? fail('usage: lb supersede <old-id> --by <new-id>')));

    case 'show': {
      const { data, text } = showCommand(readCtx, arg(0, 'id'));
      return ok(values.json ? jsonLine(data) : text);
    }
    case 'list': {
      const items = listCommand(readCtx, {
        kind: values.kind,
        scope: values.scope,
        status: values.status,
        session: values.session,
        harness: values.harness,
        all: values.all,
      });
      return ok(values.json ? jsonLine(items) : renderList(items));
    }
    case 'search': {
      const items = searchEntries(readCtx, args.join(' '), { all: values.all });
      return ok(values.json ? jsonLine(items) : renderList(items));
    }
    case 'purge':
      return purgeCommand(ctx, args, {
        closed: values.closed,
        days: values.days,
        dryRun: values['dry-run'],
        json: values.json,
      });

    case 'brief': {
      const { data, text } = briefCommand(ctx());
      return ok(values.json ? jsonLine(data) : text);
    }
    case 'delta':
      return deltaCommand(ctx(), { json: values.json });
    case 'review':
      return reviewCommand(ctx(), { peek: values.peek, json: values.json });
    case 'check':
      return checkCommand(ctx(), { tag: values.blocks ?? '', json: values.json });
    case 'usage': {
      const report = usageReport(home, values.since);
      return ok(values.json ? jsonLine(report) : renderUsage(report));
    }
    case 'bosun': {
      if (values.full) {
        if (values['dry-run'] || values.quick) throw usageError('bosun --full does not combine with --quick or --dry-run');
        // Loaded only here, so brief, delta and check never pay for the runner code.
        const { bosunFullCommand } = await import('./commands/bosun-full.js');
        return bosunFullCommand(
          { home, ctx, env, cwd },
          {
            runner: values.runner,
            model: values.model,
            thinking: values.thinking,
            memoryRoot: values['memory-root'],
            timeout: values.timeout,
            ifChanged: values['if-changed'],
            json: values.json,
          },
        );
      }
      const report = bosun(ctx(), { dryRun: values['dry-run'] });
      return ok(values.json ? jsonLine(report) : renderBosun(report));
    }

    case 'project':
      return project(home, args, values, ctx);
    default:
      throw usageError(`unknown command '${command}' (try --help)`);
  }
}

function project(
  home: string,
  args: string[],
  values: { json?: boolean; path?: string[]; remote?: string[] },
  ctx: () => Ctx,
): RunResult {
  const describe = (p: Project): string =>
    `- ${p.name} — paths: ${p.paths.join(', ')}` +
    (p.remotes.length ? ` — remotes: ${p.remotes.join(', ')}` : '') +
    '\n';
  switch (args[0]) {
    case 'add': {
      const added = addProject(home, {
        name: args[1] ?? fail('usage: lb project add <name> --path <path>'),
        paths: values.path ?? [],
        remotes: values.remote,
      });
      return ok(values.json ? jsonLine(added) : describe(added));
    }
    case 'rename': {
      const [from, to] = [args[1], args[2]];
      if (!from || !to || (values.path?.length ?? 0) > 1) fail('usage: lb project rename <old> <new> [--path <dir>]');
      const renamed = renameProject(ctx(), from!, to!, values.path?.[0]);
      return ok(values.json ? jsonLine(renamed) : describe(renamed));
    }
    case 'remove': {
      if (!args[1] || args.length > 2) fail('usage: lb project remove <name> [--path <dir>]...');
      const result = removeProject(ctx(), args[1]!, values.path);
      if (values.json) return ok(jsonLine(result));
      return ok('removed' in result ? `removed project ${result.removed}\n` : `dropped ${result.droppedPaths.length} path(s)\n${describe(result.project)}`);
    }
    case 'list': {
      const projects = listProjects(home);
      return ok(values.json ? jsonLine(projects) : projects.map(describe).join(''));
    }
    default:
      throw usageError('usage: lb project add|rename|remove|list');
  }
}

function fail(message: string): never {
  throw usageError(message);
}

/** `--body -` reads the body from stdin. */
function readBody(body: string | undefined): string | undefined {
  return body === '-' ? readFileSync(0, 'utf8') : body;
}
