---
name: catchup
description: "Answer 'what am I doing next' for the current project from its TASKS.md and CURRENT_STATE.md, cross-checked against git history, plus Leeboard holds and inbox. Use at the start of work or when the user asks what's next, where things stand, or what was going on."
---

# Catchup: what is the next move here?

This skill answers one question: **what should happen next in this project.** Lead with
the answer. Everything else is evidence for it, not a report to recite.

## 1. Read the sources

- `lb brief` (skip if it already ran this session and nothing was cleared since): holds,
  grants and the inbox for this project, plus when `TASKS.md` / `CURRENT_STATE.md` last
  changed and how many commits came after.
- `CURRENT_STATE.md` and `TASKS.md` at the repo root, when present.
- What the repository did since the state files last changed:

  ```bash
  git log --since="<last change of CURRENT_STATE.md or TASKS.md>" --format='%h %cI %s'
  git status --short
  ```

## 2. Reconcile

The state files are written by sessions and go stale when later work skips the update.
Compare the recorded next step against the commits that followed:

- No commits since, clean tree: the recorded next step stands.
- Commits since: read their subjects against the next step. Say plainly whether they
  did it, did part of it, or refuted it, and lead with the **revised** next move.
- Uncommitted changes: in-flight work with no record. Surface it first; it usually
  outranks anything written down.
- An inbox handoff or request for this project or session usually **is** the next move.
- An active hold that blocks the next move outranks it: say so and name the release
  condition.

When the recorded state and the repository disagree, the disagreement is the most useful
thing you can report. Name it, and offer to update the state files.

## 3. Report, answer first

In this order, stopping once the user has what they need:

1. **The next move**, corrected by step 2.
2. **What is in flight**: uncommitted work, open branches, inbox items.
3. **Holds and grants that bear on the next move**, and only those.

## No state files

A repo without `TASKS.md` / `CURRENT_STATE.md` (or a directory that is not a repo):
answer from the Leeboard inbox and recent git history, say the state files are absent,
and offer to create them.
