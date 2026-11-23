import { describe, expect, it } from 'vitest';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  buildInvocation, CLAUDE_PROMPT_LIMIT, KICKOFF, parseStream, RUNNERS, runAgent, THINKING_LEVELS, validateRunnerOptions,
} from '../src/bosun/runner.js';
import { EXIT, LeeboardError } from '../src/errors.js';
import { tempDir } from './helpers.js';

const STREAMS = join(import.meta.dirname, 'fixtures', 'streams');
const stream = (name: string) => readFileSync(join(STREAMS, name), 'utf8');

const input = {
  model: 'some/model',
  promptFile: '/store/state/bosun/run/prompt.md',
  prompt: 'PROMPT TEXT',
  home: '/store',
  session: 'bosun-20261018T090000Z',
  env: { PATH: '/bin', HOME: '/h', ANTHROPIC_API_KEY: 'not-a-real-key', LEEBOARD_HARNESS: 'claude-code', LEEBOARD_SESSION: 'outer', OTHER: 'kept' },
};

describe('runner invocation', () => {
  it('runs pi in print/json mode with no session, context files, skills or extensions, bash and read only', () => {
    const inv = buildInvocation({ ...input, runner: 'pi', thinking: 'high' });
    expect(inv.command).toBe('pi');
    expect(inv.args).toEqual([
      '-p', '--mode', 'json', '--no-session', '--no-context-files', '--no-skills', '--no-extensions',
      '--model', 'some/model', '--thinking', 'high', '--tools', 'bash,read',
      '--append-system-prompt', '/store/state/bosun/run/prompt.md', KICKOFF,
    ]);
    expect(KICKOFF).toBe('Run the Bosun full pass now.');
    expect(inv.cwd).toBe('/store');
    expect(inv.env).toEqual({
      ...input.env, LEEBOARD_HOME: '/store', LEEBOARD_HARNESS: 'bosun', LEEBOARD_SESSION: 'bosun-20261018T090000Z',
    });
    expect(buildInvocation({ ...input, runner: 'pi' }).args).not.toContain('--thinking');
  });

  it('runs claude in stream-json mode on the subscription: API key stripped, never --bare', () => {
    const inv = buildInvocation({ ...input, runner: 'claude' });
    expect(inv.command).toBe('claude');
    expect(inv.args).toEqual([
      '-p', '--output-format', 'stream-json', '--verbose', '--model', 'some/model',
      '--permission-mode', 'bypassPermissions', '--allowedTools', 'Bash,Read', '--tools', 'Bash,Read',
      '--no-session-persistence', '--append-system-prompt', 'PROMPT TEXT', KICKOFF,
    ]);
    expect(inv.args).not.toContain('--bare');
    expect(inv.cwd).toBe('/store');
    expect('ANTHROPIC_API_KEY' in inv.env).toBe(false);
    expect(inv.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe('1');
    expect(inv.env).toMatchObject({ LEEBOARD_HOME: '/store', LEEBOARD_HARNESS: 'bosun', LEEBOARD_SESSION: input.session, OTHER: 'kept' });
    expect(input.env.ANTHROPIC_API_KEY).toBe('not-a-real-key'); // the caller's env is not mutated
  });

  it('passes a thinking level to claude as --effort, and refuses levels claude does not have', () => {
    const inv = buildInvocation({ ...input, runner: 'claude', thinking: 'xhigh' });
    expect(inv.args.slice(inv.args.indexOf('--effort'), inv.args.indexOf('--effort') + 2)).toEqual(['--effort', 'xhigh']);
    expect(() => buildInvocation({ ...input, runner: 'claude', thinking: 'minimal' })).toThrow(LeeboardError);
    expect(() => buildInvocation({ ...input, runner: 'pi', thinking: 'loud' })).toThrow(LeeboardError);
  });

  it('refuses a claude prompt too long for one argument', () => {
    let error: unknown;
    try {
      buildInvocation({ ...input, runner: 'claude', prompt: 'x'.repeat(CLAUDE_PROMPT_LIMIT + 1) });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(LeeboardError);
    expect((error as LeeboardError).exitCode).toBe(EXIT.USAGE);
    expect(buildInvocation({ ...input, runner: 'pi', prompt: 'x'.repeat(CLAUDE_PROMPT_LIMIT + 1) }).command).toBe('pi');
  });
});

describe('runner options', () => {
  const usageError = (run: () => unknown): LeeboardError => {
    try {
      run();
    } catch (caught) {
      expect(caught).toBeInstanceOf(LeeboardError);
      expect((caught as LeeboardError).exitCode).toBe(EXIT.USAGE);
      return caught as LeeboardError;
    }
    throw new Error('expected a usage error');
  };

  it('accepts a known runner, a model and a level the runner has, and trims the model', () => {
    expect(validateRunnerOptions('pi', ' some/model ', 'off')).toEqual({ runner: 'pi', model: 'some/model' });
    expect(validateRunnerOptions('claude', 'some/model')).toEqual({ runner: 'claude', model: 'some/model' });
  });

  it('refuses an unknown runner, a blank model and a level the runner does not have, with the usual messages', () => {
    expect(usageError(() => validateRunnerOptions('gemini', 'm')).message).toBe('bosun --full needs --runner pi or claude');
    expect(usageError(() => validateRunnerOptions('pi', '  ')).message).toBe('bosun --full needs --model <id>');
    expect(usageError(() => validateRunnerOptions('claude', 'm', 'minimal')).message)
      .toBe("--thinking 'minimal' is not a claude level (use low, medium, high, xhigh, max)");
  });

  it('lists every level any runner accepts', () => {
    expect(RUNNERS).toEqual(['pi', 'claude']);
    expect(THINKING_LEVELS).toEqual(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
  });
});

describe('stream parsing (recorded streams)', () => {
  it('pi: final assistant text, provider/model and thinking level as reported, summed usage and cost', () => {
    const facts = parseStream('pi', stream('pi.jsonl'));
    expect(facts.report).toBe('done');
    expect(facts.model).toBe('opencode-go/deepseek-v4.1-flash');
    expect(facts.thinking).toBe('low');
    expect(facts.usage).toEqual({ input: 1186 + 103, output: 55 + 2, cacheRead: 1152, cacheWrite: 0 });
    expect(facts.costUsd).toBeCloseTo(0.0002109 + 0.000020106, 9);
    expect(facts.turns).toBe(2);
    expect(facts.error).toBe(false);
  });

  it('pi: an errored turn that pi retried is not an error; an errored final turn is', () => {
    const events = stream('pi.jsonl').trim().split('\n').map((line) => JSON.parse(line));
    const errored = (stopReason: string) => ({
      type: 'message_end',
      message: { role: 'assistant', content: [], provider: 'opencode-go', model: 'deepseek-v4.1-flash', stopReason, errorMessage: 'Stream ended without finish_reason' },
    });
    const finalEnd = events.findLastIndex((event) => event.type === 'message_end' && event.message?.role === 'assistant');
    const retried = [...events.slice(0, finalEnd), errored('error'), ...events.slice(finalEnd)];
    expect(parseStream('pi', retried.map((event) => JSON.stringify(event)).join('\n')).error).toBe(false);
    const lastFailed = [...events.slice(0, finalEnd + 1), errored('error'), ...events.slice(finalEnd + 1)];
    expect(parseStream('pi', lastFailed.map((event) => JSON.stringify(event)).join('\n')).error).toBe(true);
  });

  it('claude: result text, model from init, usage and cost from the result event, no thinking level reported', () => {
    const facts = parseStream('claude', stream('claude.jsonl'));
    expect(facts.report).toBe('done');
    expect(facts.model).toBe('claude-haiku-5-5');
    expect(facts.thinking).toBeNull();
    expect(facts.usage).toEqual({ input: 4, output: 77, cacheRead: 16774, cacheWrite: 6557 });
    expect(facts.costUsd).toBe(0.00151804);
    expect(facts.turns).toBe(2);
    expect(facts.error).toBe(false);
    expect(facts.extra).toEqual({ apiKeySource: 'none' });
  });

  it('claude: an error result is an error, and a stream cut before the result falls back to the last assistant text', () => {
    const lines = stream('claude.jsonl').trimEnd().split('\n');
    const result = JSON.parse(lines.at(-1)!);
    const failed = [...lines.slice(0, -1), JSON.stringify({ ...result, is_error: true, subtype: 'error_max_turns' })].join('\n');
    expect(parseStream('claude', failed).error).toBe(true);
    const cut = parseStream('claude', lines.slice(0, -1).join('\n') + '\n{"type":"assist');
    expect(cut.report).toBe('done');
    expect(cut.usage).toBeNull();
    expect(cut.costUsd).toBeNull();
  });

  it('pi: an empty or garbled stream yields no report and no figures', () => {
    for (const text of ['', 'not json\n{"type":']) {
      const facts = parseStream('pi', text);
      expect(facts).toMatchObject({ report: null, model: null, thinking: null, usage: null, costUsd: null, turns: 0 });
    }
  });
});

describe('runAgent', () => {
  function script(body: string): string {
    const dir = tempDir('lb-agent-');
    const path = join(dir, 'agent');
    writeFileSync(path, `#!/bin/sh\n${body}\n`);
    chmodSync(path, 0o755);
    return path;
  }

  it('writes stdout to the transcript and stderr to its own file, and reports the exit code', async () => {
    const dir = tempDir('lb-run-');
    const result = await runAgent(
      { command: script('echo "{\\"a\\":1}"; echo oops >&2; echo "$LEEBOARD_HARNESS $1"; exit 3'), args: ['arg1'], env: { ...process.env, LEEBOARD_HARNESS: 'bosun' }, cwd: dir },
      { transcript: join(dir, 'transcript.jsonl'), stderr: join(dir, 'stderr.log'), timeoutMs: 10_000 },
    );
    expect(result).toMatchObject({ code: 3, signal: null, timedOut: false, error: null });
    expect(result.wallMs).toBeGreaterThanOrEqual(0);
    expect(readFileSync(join(dir, 'transcript.jsonl'), 'utf8')).toBe('{"a":1}\nbosun arg1\n');
    expect(readFileSync(join(dir, 'stderr.log'), 'utf8')).toBe('oops\n');
  });

  it('kills the whole process group on timeout', async () => {
    const dir = tempDir('lb-run-');
    const descendantPath = join(dir, 'descendant.cjs');
    const pidPath = join(dir, 'descendant.pid');
    const readyPath = join(dir, 'ready');
    const sentinelPath = join(dir, 'sentinel');
    writeFileSync(descendantPath, `
const { writeFileSync } = require('node:fs');
setTimeout(() => process.exit(0), 8_000);
writeFileSync('ready', String(process.pid));
setTimeout(() => writeFileSync('sentinel', 'survived'), 2_000);
`);
    try {
      const result = await runAgent(
        { command: script('"$1" "$2" &\nprintf \'%s\\n\' "$!" > descendant.pid\nwait'), args: [process.execPath, descendantPath], env: process.env, cwd: dir },
        { transcript: join(dir, 't'), stderr: join(dir, 'e'), timeoutMs: 1_000 },
      );
      expect(existsSync(readyPath)).toBe(true);
      const pid = Number(readFileSync(pidPath, 'utf8').trim());
      expect(Number.isInteger(pid) && pid > 0).toBe(true);
      expect(readFileSync(readyPath, 'utf8')).toBe(String(pid));
      expect(result.timedOut).toBe(true);
      expect(result.code).toBeNull();
      expect(result.wallMs).toBeLessThan(10_000);

      // Observe long enough for a surviving descendant to write its sentinel.
      await delay(2_500);
      expect(existsSync(sentinelPath)).toBe(false);
    } finally {
      if (existsSync(pidPath)) {
        const pid = Number(readFileSync(pidPath, 'utf8').trim());
        if (Number.isInteger(pid) && pid > 0) {
          try {
            process.kill(pid, 'SIGKILL');
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
          }
        }
      }
    }
  }, 15_000);

  it('reports a runner that cannot be started', async () => {
    const dir = tempDir('lb-run-');
    const result = await runAgent(
      { command: join(dir, 'no-such-runner'), args: [], env: process.env, cwd: dir },
      { transcript: join(dir, 't'), stderr: join(dir, 'e'), timeoutMs: 1000 },
    );
    expect(result.code).toBeNull();
    expect(result.error).toMatch(/ENOENT/);
  });
});
