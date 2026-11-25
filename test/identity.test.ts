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

  it("falls back to the harness's own session id when no harness or session is given", () => {
    expect(resolveIdentity({}, { CLAUDE_CODE_SESSION_ID: 'cc-1' })).toEqual({
      harness: 'claude-code',
      session: 'cc-1',
      origin: 'agent-inferred',
    });
    expect(resolveIdentity({}, { PI_SESSION_ID: 'pi-1' })).toEqual({
      harness: 'pi',
      session: 'pi-1',
      origin: 'agent-inferred',
    });
    expect(resolveIdentity({ harness: 'claude-code' }, { CLAUDE_CODE_SESSION_ID: 'cc-2' })).toMatchObject({
      harness: 'claude-code',
      session: 'cc-2',
    });
  });

  it('keeps an explicit identity over the harness session id, and guesses nothing when both harnesses are set', () => {
    const outer = { CLAUDE_CODE_SESSION_ID: 'outer' };
    expect(resolveIdentity({}, { ...outer, LEEBOARD_HARNESS: 'helmraiser' })).toMatchObject({ harness: 'helmraiser', session: null });
    expect(resolveIdentity({ harness: 'pi' }, outer)).toMatchObject({ harness: 'pi', session: null });
    expect(resolveIdentity({ session: 'other-tool' }, outer)).toMatchObject({ harness: null, session: 'other-tool' });
    expect(resolveIdentity({}, { ...outer, LEEBOARD_SESSION: 'run-9' })).toMatchObject({ harness: null, session: 'run-9' });
    expect(resolveIdentity({}, { CLAUDE_CODE_SESSION_ID: 'a', PI_SESSION_ID: 'b' })).toMatchObject({ harness: null, session: null });
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
