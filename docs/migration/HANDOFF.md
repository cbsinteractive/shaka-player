# Migration Machinery Handoff

- **Date:** 2026-07-15
- **State:** Machinery complete, rails-tested end to end, final-reviewed (verdict: ready).
  `migration/main` tip `a74788252`, tag `migration-bootstrap`, both pushed to origin
  (cbsinteractive fork). Batch branches 000-002 are local-only and merged. Fork `main`
  untouched, per design. 27/27 machinery tests passing.
- **Canonical documents:** design spec
  `docs/superpowers/specs/2026-07-14-agentic-migration-loop-design.md` (the strategy),
  implementation plan `docs/superpowers/plans/2026-07-14-agentic-migration-loop.md`
  (historical; several reference-code defects were fixed post-review in commits, and
  the plan text was deliberately not back-patched).

## Resume protocol (fresh session)

1. Check out `migration/main` (fetch origin if the local worktree is gone).
2. Read this file, then the design spec sections 5-10 if unfamiliar.
3. Sanity: `node --test scripts/migration/test/*.test.mjs` (27 passing),
   `node scripts/migration/ledger.mjs check` (OK),
   `node scripts/migration/land.mjs --compare` (RATCHETS OK vs baseline).
4. Pick a workstream below. Workstream 1 is the milestone; workstream 2 items are
   gated by the milestones named next to them.

## Workstream 1: write docs/migration/PLAN.md for phase A

The user explicitly requested this next: a brainstorm session for PLAN.md
(superpowers:brainstorming, then spec, then superpowers:writing-plans, the same cycle
that produced the machinery).

**PLAN.md's contract with the machinery** (the strategy/plan interface):

- Define phase A unit types; each gets a PLAYBOOK.md section (rule IDs, dates,
  triggering example, why) and a `docs/migration/gates.json` entry (fast commands,
  `{paths}` substitution).
- Define real ratchets in `docs/migration/ratchets.json` (`direction` is exactly
  `up`, `down`, or `eq`; up/down values must be numeric; commands print one value).
- Define queue generation: append `pending` units to `docs/migration/LEDGER.jsonl`
  (one JSON per line, `deps` edges for ordering) via a `migrate-meta: seed` commit.
- Define upstream chunk guidance for `export.mjs` (per-module or per-phase PRs).

**Phase A scope** (decided 2026-05-05, see project memory): Vite+ plus ESM plus
Closure runtime removal; source stays JS; output is a functionally equivalent ES5 UMD
bundle; the test suite survives in some form. Scale markers as of 2026-05: 1,298
`goog.require`, 269 `goog.provide`, 68 externs files, 20+ build variants.

**Loop-zero principle:** the first units build the verifier, not conversions. There
is no oracle until the test suite runs green under the new toolchain (or a bridge
runs old and new side by side). Looping without an oracle is generating plausible
diffs quickly.

**Open questions to brainstorm (seeds, not decisions):**

- Oracle continuity: keep Karma green as baseline while Vitest comes up? Differential
  bridge period comparing both runners' results? What is the cutover criterion?
- Unit-type candidates: toolchain-bootstrap tasks (few, bespoke); per-file ESM
  conversion ordered by the goog dependency graph; per-test-file runner migration;
  `upstream-sync` (spec section 10, needs its own playbook section before the first
  sync).
- What does "functionally equivalent UMD" mean as a gate: test suite only, or also an
  API-surface golden (spec section 7 expects one eventually) and/or dist diffing?
- Queue and deps generation mechanics from the goog.provide/require graph (a script,
  run once per phase, output reviewed before seeding).
- Calibration slice: which 3-5 files run first (likely lib/util leaves), and what the
  batch size and review depth are during calibration (loop.json defaults: batchSize 4,
  fixAttempts 2, reviewer human, sampleK 3).

## Workstream 2: machinery hardening (sequenced by gate)

**Before the first real batch:**

- `ledger.mjs requeue <id>`: reset a unit to pending, attempts 0, commit/batch/note
  null. Today `update` cannot write nulls, and `backfill` only fills missing shas, so
  a redone unit would keep a stale sha.
- Revert protocol documentation (skill or playbook): reverting a unit after backfill
  ALWAYS conflicts on its LEDGER.jsonl line (single-line-per-unit rewrites overlap at
  diff context width). Resolution side determines which guardrail fires: keep-ours
  surfaces a loud ledger-check failure (done with net 0), keep-theirs falls through
  to ratchets only. Rule of thumb: resolve ledger conflicts with ours, then flip
  status explicitly via requeue. Never revert a revert; git's "Reapply" subjects do
  not match the migrate() convention and check will fail loudly.

**Before PLAN.md queue tooling ships:**

- Ledger field validation in `parseLedger`/`updateUnit`: non-empty `paths`, numeric
  `attempts` (a non-numeric --attempts currently becomes NaN and serializes to null),
  string-or-null `batch`/`commit`/`note`.

**Before promotion 1 (adversarial reviewer replaces per-unit human review):**

- Land-time path validation of spec invariants 1 and 4 over the batch range:
  `migrate()` commits may touch only the unit's declared paths plus LEDGER.jsonl;
  `migrate-meta:` commits only LEDGER.jsonl. Until this exists the invariants are
  convention, and the spec says so (section 5, amended).

**Housekeeping (any time, small):**

- `land.mjs --compare` prints only current values on success; print `base -> cur` per
  ratchet so batch reports show deltas (spec section 8 expects deltas).
- `ledger.mjs stats` omits zero-count statuses; print all five.
- Rename `.github/workflows/migration-ci.yml` to `.yaml` (repo convention) and update
  the `export.mjs` DENY entry in the SAME commit, or the workflow leaks into exports.
- Decide the PLAYBOOK rails-header section's fate (delete, or keep annotated as the
  format example; re-running rails would need gates.json re-seeded).
- `backfill` never populates the `batch` field: populate it or drop the field from
  the spec.
- `verify.mjs` config errors (unknown unit, no gates for type) exit 1 like a real
  gate failure, so migrate-next routes them to quarantine; give them a distinct exit
  code (e.g. 3) and one skill line routing them to the infra-halt path.
- `export.mjs` leaks the temp dir if `git worktree add` itself fails; add an
  existsSync/rmSync fallback in the finally.
- Quote ref/branch interpolations in git.mjs/land.mjs/export.mjs shell strings.
  Caution: the unquoted `--ref "HEAD MERGE_HEAD"` union in migrateLog is load-bearing;
  split on whitespace and quote each rev.
- `land.mjs --batch` of an already-merged branch dies with a misleading "ledger check
  failed" message; detect the no-op merge and say "nothing to land".
- Decide whether script-generated `land:` commits should carry the Co-Authored-By
  trailer (currently they do not; stated global constraint says all commits do).
- Spec wording reconciliation: section 6 says the reviewer subagent sees "only the
  diff" but the skill (better) also passes unit id and playbook sections; section 11
  overpromises stats output ("signatures ranked", "velocity").

## Operating rules recap

- Nothing lands on `migration/main` except through `land.mjs --batch`, machinery
  included: branch `migration/batch-NNN`, commit, land. (Next number: 003.)
- Fork `main` is never touched. Machinery paths never reach exports (DENY list in
  export.mjs).
- Commit subjects are parsed contracts: `migrate(<type>): <unit-id>` unit work,
  `migrate-meta:` ledger-only, `feat(migration-tooling):` machinery, `land:` merges.
  Machinery never shares a commit with unit work.
- Outer-loop discipline: anything human review catches is an instruction bug; the fix
  lands in PLAYBOOK.md or a skill first, then the unit is reverted and requeued.
- Autonomy is graduated (spec section 10): calibration reviews every diff; promotion
  after 5 clean units / 2 clean batches; any escaped regression demotes one level.
- Skills: `/migrate-next` runs one unit; `/migrate-batch` assembles, reviews, lands.
  Driver: `/loop /migrate-next` while supervised.
