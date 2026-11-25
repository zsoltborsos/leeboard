import { type Author, HARNESSES, type Harness, ORIGINS, type Origin } from './entry.js';
import { EXIT, LeeboardError } from './errors.js';

const MAX_SESSION_LENGTH = 128;

/**
 * Who is acting: flags first, then LEEBOARD_HARNESS / LEEBOARD_SESSION, then the session id
 * Claude Code or Pi sets for its agents. Unknown parts are null.
 */
export function resolveIdentity(
  flags: { harness?: string; session?: string; origin?: string },
  env: NodeJS.ProcessEnv = process.env,
): Author {
  let harness = flags.harness || env.LEEBOARD_HARNESS || null;
  let session = flags.session || env.LEEBOARD_SESSION || null;
  const detected = detectHarnessSession(env);
  if (session === null && detected && (harness === null || harness === detected.harness)) {
    ({ harness, session } = detected);
  }
  const origin = flags.origin || 'agent-inferred';

  if (harness !== null && !(HARNESSES as readonly string[]).includes(harness)) {
    throw new LeeboardError(`unknown harness '${harness}' (use ${HARNESSES.join(', ')})`, EXIT.USAGE);
  }
  if (!(ORIGINS as readonly string[]).includes(origin)) {
    throw new LeeboardError(`unknown origin '${origin}' (use ${ORIGINS.join(', ')})`, EXIT.USAGE);
  }
  if (session !== null && session.length > MAX_SESSION_LENGTH) {
    throw new LeeboardError(`session id is longer than ${MAX_SESSION_LENGTH} characters`, EXIT.USAGE);
  }
  return { harness: harness as Harness | null, session, origin: origin as Origin };
}

/** The harness's own session id, when exactly one of Claude Code and Pi has set one. */
function detectHarnessSession(env: NodeJS.ProcessEnv): { harness: Harness; session: string } | null {
  const claude = env.CLAUDE_CODE_SESSION_ID || null;
  const pi = env.PI_SESSION_ID || null;
  if (claude && !pi) return { harness: 'claude-code', session: claude };
  if (pi && !claude) return { harness: 'pi', session: pi };
  return null;
}
