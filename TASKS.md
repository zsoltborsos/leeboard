# Leeboard — Tasks

Only current, evidence-backed work belongs here. Remove completed tasks rather than
keeping a history; `CURRENT_STATE.md` and git record what landed.

## Next

- Upload `docs/brand/leeboard-social.png` as the repository's social preview
  (Settings → General; the API cannot set it).
- Rerun the opt-in speed test on an idle machine:
  `env -u CI LEEBOARD_PERF=1 npx vitest run test/perf.test.ts`. On 25 Nov `lb brief`
  measured 372–412 ms against its 200 ms budget, on `main` and on a branch alike, with
  a load average around 10 on 8 cores (bare `node -e 0` took 70–200 ms). If it still
  fails when idle, find the commit that pushed it over.

## Later

From the 25 Nov architecture review; explore before committing to them.

- Command modules: `check`, `review`, `delta` and `purge` are converted and own their
  exit codes, JSON shapes and rendered output, using `src/result.ts`. `run.ts` retains
  option parsing, usage text, routing and thrown-error mapping for them. Their flags
  objects include `json`; usage errors share `src/errors.ts`. Purge's command lives
  beside the other command modules. The remaining commands follow this shape.
- Project registry: one module owns the `projects/<name>/` layout and the
  `project:<name>` scope string; rename and remove become its operations.
