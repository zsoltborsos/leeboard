// Isolation for every test file: nothing may reach the real ~/.leeboard or the
// developer's global git configuration.
import { afterAll, beforeEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const sandbox = mkdtempSync(join(tmpdir(), 'leeboard-test-env-'));
afterAll(() => rmSync(sandbox, { recursive: true, force: true }));

process.env.HOME = sandbox;
process.env.LEEBOARD_HOME = join(sandbox, 'unused-store');
delete process.env.LEEBOARD_HARNESS;
delete process.env.LEEBOARD_SESSION;
delete process.env.CLAUDE_CODE_SESSION_ID;
delete process.env.PI_SESSION_ID;

process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.GIT_AUTHOR_NAME = 'Test Author';
process.env.GIT_AUTHOR_EMAIL = 'author@example.test';
process.env.GIT_COMMITTER_NAME = 'Test Committer';
process.env.GIT_COMMITTER_EMAIL = 'committer@example.test';

// Never let git walk above the temp area looking for a repository.
process.env.GIT_CEILING_DIRECTORIES = tmpdir();

// `npm run test:future` sets LEEBOARD_TEST_FUTURE: the suite runs with the clock five
// years ahead, so a fixture date that quietly depends on today's date fails now, not on
// the day it passes. Tests that compare the clock with real file times skip themselves.
// Set before each test, since a test file's own `vi.useRealTimers()` would undo it.
if (process.env.LEEBOARD_TEST_FUTURE) {
  const future = Date.now() + 5 * 365 * 86_400_000;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
    vi.setSystemTime(future);
  });
}
