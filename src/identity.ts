import { type Author, HARNESSES, type Harness, ORIGINS, type Origin } from './entry.js';
import { EXIT, LeeboardError } from './errors.js';

const MAX_SESSION_LENGTH = 128;

/** Who is acting: flags first, then LEEBOARD_HARNESS / LEEBOARD_SESSION. Unknown parts are null. */
export function resolveIdentity(
  flags: { harness?: string; session?: string; origin?: string },
  env: NodeJS.ProcessEnv = process.env,
): Author {
  const harness = flags.harness || env.LEEBOARD_HARNESS || null;
  const session = flags.session || env.LEEBOARD_SESSION || null;
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
