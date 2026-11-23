import { spawn } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { EXIT, LeeboardError } from '../errors.js';

export const KICKOFF = 'Run the Bosun full pass now.';

/** claude takes the prompt as one argument; Linux caps a single argument at 128 KiB. */
export const CLAUDE_PROMPT_LIMIT = 120_000;

export const NEEDS_MODEL = 'bosun --full needs --model <id>';

export interface InvocationInput {
  runner: Runner;
  model: string;
  thinking?: string;
  /** The rendered prompt, as a file (pi) and as text (claude). */
  promptFile: string;
  prompt: string;
  home: string;
  session: string;
  env: NodeJS.ProcessEnv;
}

export interface Invocation {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
}

/** Everything that differs between runners. A new runner is a new record in `SPECS`. */
interface RunnerSpec {
  /** The levels `--thinking` accepts. */
  thinking: readonly string[];
  /** The command line. `env` already carries the Leeboard identity; the runner may adjust it. */
  invoke(input: InvocationInput, env: NodeJS.ProcessEnv): Invocation;
  /** What the runner's own stream says about the run. */
  parse(events: Json[]): RunFacts;
}

const thinkingArgs = (input: InvocationInput, flag: string): string[] =>
  input.thinking === undefined ? [] : [flag, input.thinking];

const SPECS = {
  pi: {
    thinking: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
    invoke: (input, env) => ({
      command: 'pi',
      args: [
        '-p', '--mode', 'json', '--no-session', '--no-context-files', '--no-skills', '--no-extensions',
        '--model', input.model, ...thinkingArgs(input, '--thinking'), '--tools', 'bash,read',
        '--append-system-prompt', input.promptFile, KICKOFF,
      ],
      env,
      cwd: input.home,
    }),
    parse: parsePi,
  },
  claude: {
    thinking: ['low', 'medium', 'high', 'xhigh', 'max'],
    invoke: (input, env) => {
      const size = Buffer.byteLength(input.prompt, 'utf8');
      if (size > CLAUDE_PROMPT_LIMIT) {
        throw new LeeboardError(
          `the rendered prompt is ${size} bytes; claude takes it as one argument (limit ${CLAUDE_PROMPT_LIMIT})`,
          EXIT.USAGE,
        );
      }
      // The owner's subscription login, not an API key: strip the key, never pass --bare.
      delete env.ANTHROPIC_API_KEY;
      // Bosun's own runs must not write Claude auto-memory notes it would mirror back next time.
      env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '1';
      return {
        command: 'claude',
        args: [
          '-p', '--output-format', 'stream-json', '--verbose', '--model', input.model, ...thinkingArgs(input, '--effort'),
          '--permission-mode', 'bypassPermissions', '--allowedTools', 'Bash,Read', '--tools', 'Bash,Read',
          '--no-session-persistence', '--append-system-prompt', input.prompt, KICKOFF,
        ],
        env,
        cwd: input.home,
      };
    },
    parse: parseClaude,
  },
} satisfies Record<string, RunnerSpec>;

export type Runner = keyof typeof SPECS;
export const RUNNERS = Object.keys(SPECS) as readonly Runner[];

/** Every level any runner accepts. */
export const THINKING_LEVELS: readonly string[] = [...new Set(RUNNERS.flatMap((runner) => SPECS[runner].thinking))];

function checkThinking(runner: Runner, thinking: string | undefined): void {
  const levels: readonly string[] = SPECS[runner].thinking;
  if (thinking !== undefined && !levels.includes(thinking)) {
    throw new LeeboardError(`--thinking '${thinking}' is not a ${runner} level (use ${levels.join(', ')})`, EXIT.USAGE);
  }
}

/**
 * Check what `bosun --full` was given for the runner, before anything is written: the runner
 * is known, the model is not blank, the thinking level suits the runner. Returns them cleaned.
 */
export function validateRunnerOptions(runner: string, model: string, thinking?: string): { runner: Runner; model: string } {
  if (!(RUNNERS as readonly string[]).includes(runner)) {
    throw new LeeboardError(`bosun --full needs --runner ${RUNNERS.join(' or ')}`, EXIT.USAGE);
  }
  const trimmed = model.trim();
  if (trimmed === '') throw new LeeboardError(NEEDS_MODEL, EXIT.USAGE);
  checkThinking(runner as Runner, thinking);
  return { runner: runner as Runner, model: trimmed };
}

/** The agent command line. The agent acts as harness `bosun` with the run id as its session. */
export function buildInvocation(input: InvocationInput): Invocation {
  checkThinking(input.runner, input.thinking);
  const env: NodeJS.ProcessEnv = {
    ...input.env,
    LEEBOARD_HOME: input.home,
    LEEBOARD_HARNESS: 'bosun',
    LEEBOARD_SESSION: input.session,
  };
  return SPECS[input.runner].invoke(input, env);
}

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** What the runner's own stream says about the run. Null means the stream did not report it. */
export interface RunFacts {
  report: string | null;
  model: string | null;
  thinking: string | null;
  usage: Usage | null;
  costUsd: number | null;
  turns: number | null;
  error: boolean;
  extra: Record<string, unknown>;
}

type Json = Record<string, any>;

function events(text: string): Json[] {
  const parsed: Json[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const value: unknown = JSON.parse(line);
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) parsed.push(value as Json);
    } catch {
      // a partial last line (killed run) or a non-JSON line
    }
  }
  return parsed;
}

const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part): part is Json => typeof part === 'object' && part !== null && part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text as string)
    .join('');
}

/** pi `--mode json`: one `message_end` per assistant message carries provider, model, thinkingLevel and usage. */
function parsePi(all: Json[]): RunFacts {
  const facts: RunFacts = { report: null, model: null, thinking: null, usage: null, costUsd: null, turns: 0, error: false, extra: {} };
  let aborted = false;
  let lastTurnFailed = false;
  for (const event of all) {
    if (event.type === 'agent_settled' && event.aborted === true) aborted = true;
    const message = event.message;
    if (event.type !== 'message_end' || message?.role !== 'assistant') continue;
    facts.turns!++;
    if (typeof message.model === 'string') {
      facts.model = typeof message.provider === 'string' ? `${message.provider}/${message.model}` : message.model;
    }
    if (typeof message.thinkingLevel === 'string') facts.thinking = message.thinkingLevel;
    // pi retries a failed turn by itself, so only the final turn decides.
    lastTurnFailed = message.stopReason === 'error' || message.stopReason === 'aborted';
    const usage = message.usage;
    if (usage && typeof usage === 'object') {
      const total = facts.usage ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
      total.input += num(usage.input);
      total.output += num(usage.output);
      total.cacheRead += num(usage.cacheRead);
      total.cacheWrite += num(usage.cacheWrite);
      facts.usage = total;
      if (typeof usage.cost?.total === 'number') facts.costUsd = (facts.costUsd ?? 0) + usage.cost.total;
    }
    const text = textOf(message.content).trim();
    facts.report = text === '' ? null : text;
  }
  facts.error = aborted || lastTurnFailed;
  return facts;
}

/** claude `stream-json`: `system/init` carries the model; the final `result` carries text, usage and cost. */
function parseClaude(all: Json[]): RunFacts {
  const facts: RunFacts = { report: null, model: null, thinking: null, usage: null, costUsd: null, turns: null, error: false, extra: {} };
  let lastText: string | null = null;
  let result: Json | null = null;
  for (const event of all) {
    if (event.type === 'system' && event.subtype === 'init') {
      if (typeof event.model === 'string') facts.model = event.model;
      if (typeof event.apiKeySource === 'string') facts.extra.apiKeySource = event.apiKeySource;
    } else if (event.type === 'assistant') {
      const text = textOf(event.message?.content).trim();
      if (text !== '') lastText = text;
    } else if (event.type === 'result') {
      result = event;
    }
  }
  if (result === null) {
    facts.report = lastText;
    facts.error = true;
    return facts;
  }
  facts.report = typeof result.result === 'string' && result.result.trim() !== '' ? result.result.trim() : lastText;
  facts.error = result.is_error === true || result.subtype !== 'success';
  if (typeof result.num_turns === 'number') facts.turns = result.num_turns;
  if (typeof result.total_cost_usd === 'number') facts.costUsd = result.total_cost_usd;
  const usage = result.usage;
  if (usage && typeof usage === 'object') {
    facts.usage = {
      input: num(usage.input_tokens),
      output: num(usage.output_tokens),
      cacheRead: num(usage.cache_read_input_tokens),
      cacheWrite: num(usage.cache_creation_input_tokens),
    };
  }
  if (facts.model === null && result.modelUsage && typeof result.modelUsage === 'object') {
    facts.model = Object.keys(result.modelUsage)[0] ?? null;
  }
  return facts;
}

export function parseStream(runner: Runner, text: string): RunFacts {
  return SPECS[runner].parse(events(text));
}

export interface AgentExit {
  code: number | null;
  signal: string | null;
  timedOut: boolean;
  /** Set when the runner could not be started. */
  error: string | null;
  wallMs: number;
}

const KILL_GRACE_MS = 5_000;

/**
 * Run the agent in its own process group with stdout and stderr going straight to files,
 * so nothing is buffered in memory. On timeout the whole group gets SIGTERM, then SIGKILL.
 */
export function runAgent(
  invocation: Invocation,
  files: { transcript: string; stderr: string; timeoutMs: number },
): Promise<AgentExit> {
  const started = Date.now();
  const out = openSync(files.transcript, 'w');
  const err = openSync(files.stderr, 'w');
  return new Promise((resolve) => {
    let timedOut = false;
    let settled = false;
    const timers: NodeJS.Timeout[] = [];
    const finish = (exit: Omit<AgentExit, 'wallMs' | 'timedOut'>) => {
      if (settled) return;
      settled = true;
      for (const timer of timers) clearTimeout(timer);
      closeSync(out);
      closeSync(err);
      resolve({ ...exit, timedOut, wallMs: Date.now() - started });
    };
    const child = spawn(invocation.command, invocation.args, {
      cwd: invocation.cwd,
      env: invocation.env,
      stdio: ['ignore', out, err],
      detached: true,
    });
    const killGroup = (signal: NodeJS.Signals) => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, signal);
      } catch {
        // already gone
      }
    };
    timers.push(setTimeout(() => {
      timedOut = true;
      killGroup('SIGTERM');
      timers.push(setTimeout(() => killGroup('SIGKILL'), KILL_GRACE_MS));
    }, files.timeoutMs));
    child.on('error', (error) => finish({ code: null, signal: null, error: String(error) }));
    child.on('close', (code, signal) => finish({ code: timedOut ? null : code, signal, error: null }));
  });
}
