# Leeboard — Tasks

Only current, evidence-backed work belongs here. Remove completed tasks rather than
keeping a history; `CURRENT_STATE.md` and git record what landed.

## Next

- Upload `docs/brand/leeboard-social.png` as the repository's social preview
  (Settings → General; the API cannot set it).

## Later

From the 25 Nov architecture review; explore before committing to them.

- Command modules: the `check` pilot landed; `checkCommand` owns its exit code,
  JSON shape and rendered output. `run.ts` still owns option parsing, usage text
  and routing. Whether to convert the remaining commands is still to decide.
- Project registry: one module owns the `projects/<name>/` layout and the
  `project:<name>` scope string; rename and remove become its operations.
