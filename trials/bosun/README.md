# Bosun trial fixture

A made-up store and Claude memory root for comparing models on the Bosun full pass
(`docs/design.md` section 10.4). Nothing here comes from a real store: the owner, the
projects (`webshop`, `blog`) and their paths under `/home/dev/src/` are invented.

## Run

```bash
npm run build
node scripts/bosun-trial.mjs --models claude:claude-sonnet-5-5,pi:<provider>/<model>:medium --repeat 3
```

Each run gets a fresh copy of `store/` and `memory/`, so the fixture never changes.
Results go to `trials/bosun/results/<timestamp>/` (ignored by git): `results.md` with a
table per model, `results.json`, and per run the report, a diff of what Bosun changed, the
transcript and the store it left. A run takes a few minutes and spends real tokens.

## What is in it

`store/` holds 80 entries (one revoked, one superseded) and the mirror watermark of a
previous pass (`state/bosun/mirror.json`). `memory/` holds seven notes in two project
directories: against the watermark, five are new, two changed, and two watermarked notes
are gone. `expected.json` is the key `src/bosun/score.ts` scores against:

| Key | Entries or notes | The right outcome |
|---|---|---|
| `protected` | three owner rules and holds; an owner rule whose note was deleted | stay active (or move to an owner-worded replacement) |
| `duplicates` | a pnpm pair in `global`; three wordings of one webshop schema rule; two machine rules with no shared wording; a Stripe rule in `global` and its copy in `project:webshop` | one survivor per group |
| `decidable` | owner vs agent on blog commits; two dated owner rules on the changelog, the newer saying it replaces the older; a newer agent spelling rule against an older owner one | the loser superseded by the winner |
| `undecidable` | two owner test rules written in the same second; a freeze hold vs a release-session grant, with a release-branch reference as context | all left active, named under "Contradictions for the owner" |
| `rescope` | the Stripe rule in `global`; a laptop network fact in `global` | moved to `project:webshop` and `machine` |
| `retire` | a code fact, a mirrored scheduled fix, a status update | revoked |
| `flag` | the owner's December plan; the owner rule whose note was deleted | kept and named in the report |
| `tighten` | "Docker notes" | the same entry, or its replacement, under an instruction title |
| `staleRefs` | a backup rule citing the superseded NAS reference | cites the replacement instead |
| `expendable` | two clusters of agent-written rules in `global` (commit message format, shell scripts) and a weak `rg` preference | not scored: these may be folded or retired for the budget without penalty |
| `mirror.new` | `codegen-after-schema.md`; `small-prs.md`, written in blog but true everywhere | a new entry citing it, in `project:webshop` and `global` |
| `mirror.changed` | `staging-url.md`, whose host moved | the old reference superseded by one citing the note |
| `mirror.skip` | a roadmap, a code fact, and a note restating the revoked Node 20 reference | no entry cites them |
| `mirror.represented` | `pipefail-before-commit.md`, changed but only reworded | the existing entry stays, nothing new cites the note |
| `mirror.deleted` | `review-apps.md`, gone, with a mirrored entry written from it | that entry revoked |

**Budget.** `global` starts at 47 index lines. The fixes above bring it to 45, so a run
must fold at least five more: both expendable clusters (four into one, three into one)
do it. Every other `global` entry is distinct and correct, and folding or retiring one
counts as churn.

**Churn.** Entries `expected.json` never names are bystanders: correct, in scope, and
not to be touched. Superseding one costs 2 points and revoking one 10. One of them
(`reference-webshop-credentials-live-in-secrets-1c02`) names `~/.secrets/webshop/`, which the quick
pass reports as a dead reference. The prompt says a path Bosun cannot see is no reason to
retire, so retiring it is churn.

`test/bosun-trial.test.ts` runs the script on this fixture with a fake runner: the ideal
changes must score 100 with nothing missed, and doing nothing must score low with no
false retirements. Change the store or the key together, and keep that test passing.

## Changing the store

The entry files are ordinary Leeboard entries; edit them by hand or with
`LEEBOARD_HOME=$PWD/trials/bosun/store lb …`. Keep ids ending in four hex digits, keep
`log.jsonl` in step with the entries you add, and update `expected.json`, this table and
the ideal run in the test. The store's own `.gitignore` ignores `state/`, so
`state/bosun/mirror.json` is tracked with `git add -f`; to change the watermark, edit that
file (paths map to the SHA-256 of a note's content).
