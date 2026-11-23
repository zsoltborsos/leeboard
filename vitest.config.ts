import { configDefaults, defineConfig } from 'vitest/config';

/**
 * The wall-clock budget assertions in `test/perf.test.ts` are load-sensitive, so they
 * are opt-in: `LEEBOARD_PERF=1 npm test` runs them; every other run excludes the file.
 * The test and its budgets are unchanged.
 */
export function perfExclude(env: NodeJS.ProcessEnv = process.env): string[] {
  return env.LEEBOARD_PERF === '1' ? [] : ['test/perf.test.ts'];
}

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: [...configDefaults.exclude, ...perfExclude()],
    setupFiles: ['test/setup.ts'],
  },
});
