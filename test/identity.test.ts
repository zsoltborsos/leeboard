import { describe, expect, it } from 'vitest';
import { EXIT, LeeboardError } from '../src/errors.js';
import { resolveIdentity } from '../src/identity.js';

describe('resolveIdentity', () => {
  it('takes flags first, then the environment', () => {
    expect(
      resolveIdentity(
        { harness: 'pi', session: 'from-flag', origin: 'user-stated' },
        { LEEBOARD_HARNESS: 'claude-code', LEEBOARD_SESSION: 'from-env' },
      ),
    ).toEqual({ harness: 'pi', session: 'from-flag', origin: 'user-stated' });
    expect(resolveIdentity({}, { LEEBOARD_HARNESS: 'helmraiser', LEEBOARD_SESSION: 'run-42' })).toEqual({
      harness: 'helmraiser',
      session: 'run-42',
      origin: 'agent-inferred',
    });
  });

  it('accepts helmraiser from the flag and from the environment', () => {
    expect(resolveIdentity({ harness: 'helmraiser', session: 'run-7' }, {})).toEqual({
      harness: 'helmraiser',
      session: 'run-7',
      origin: 'agent-inferred',
    });
    expect(resolveIdentity({}, { LEEBOARD_HARNESS: 'helmraiser', LEEBOARD_SESSION: 'run-8' })).toEqual({
      harness: 'helmraiser',
      session: 'run-8',
      origin: 'agent-inferred',
    });
  });

  it('records a missing harness or session as null and defaults the origin', () => {
    expect(resolveIdentity({}, {})).toEqual({ harness: null, session: null, origin: 'agent-inferred' });
    expect(resolveIdentity({ session: '' }, { LEEBOARD_SESSION: '' })).toEqual({
      harness: null,
      session: null,
      origin: 'agent-inferred',
    });
  });

  it.each([
    [{ harness: 'emacs' }],
    [{ origin: 'guessed' }],
    [{ session: 's'.repeat(129) }],
  ])('rejects %j with the usage exit code', (flags) => {
    try {
      resolveIdentity(flags, {});
      throw new Error('expected a rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(LeeboardError);
      expect((error as LeeboardError).exitCode).toBe(EXIT.USAGE);
    }
  });
});
