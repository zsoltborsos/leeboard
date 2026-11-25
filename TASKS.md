# Leeboard — Tasks

Only current, evidence-backed work belongs here. Remove completed tasks rather than
keeping a history; `CURRENT_STATE.md` and git record what landed.

## Next

- Upload `docs/brand/leeboard-social.png` as the repository's social preview
  (Settings → General; the API cannot set it).

## Later

From the 25 Nov architecture review; explore before committing to them.

- Command modules: each command owns its flags, validation, exit code and output;
  `run.ts` keeps parsing, routing and the text-or-JSON choice. Piloting on `check`
  first; convert the rest only if the pilot pays off.
- Project registry: one module owns the `projects/<name>/` layout and the
  `project:<name>` scope string; rename and remove become its operations.
