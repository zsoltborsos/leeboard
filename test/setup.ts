// Isolation for every test file: nothing may reach the real ~/.leeboard or the
// developer's global git configuration.
import { afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const sandbox = mkdtempSync(join(tmpdir(), 'leeboard-test-env-'));
afterAll(() => rmSync(sandbox, { recursive: true, force: true }));

process.env.HOME = sandbox;
process.env.LEEBOARD_HOME = join(sandbox, 'unused-store');
delete process.env.LEEBOARD_HARNESS;
delete process.env.LEEBOARD_SESSION;

process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.GIT_AUTHOR_NAME = 'Test Author';
process.env.GIT_AUTHOR_EMAIL = 'author@example.test';
process.env.GIT_COMMITTER_NAME = 'Test Committer';
process.env.GIT_COMMITTER_EMAIL = 'committer@example.test';

// Never let git walk above the temp area looking for a repository.
process.env.GIT_CEILING_DIRECTORIES = tmpdir();
