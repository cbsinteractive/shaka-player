# Agentic Migration Loop: Workflow Design

- **Date:** 2026-07-14
- **Status:** Approved pending user review
- **Scope:** The looping *strategy* for executing the shaka-player TypeScript migration
  ([shaka-project/shaka-player#8262](https://github.com/shaka-project/shaka-player/issues/8262)).
  The migration *plan* itself (phases, unit-type definitions, gate commands, queue
  generation) is a separate artifact, `docs/migration/PLAN.md`, written later. This
  document defines the machine that executes any such plan.
- **Sources:** Lessons from the Bun Zig-to-Rust migration
  (https://bun.com/blog/bun-in-rust); assumes Vite+ (https://viteplus.dev) supplies
  build, dev server, unit/browser test runner, lint, and library packaging.

## 1. Goals and priorities

The single north-star goal is **upstreamable quality**: history, diffs, and
faithfulness good enough that shaka-project maintainers could review and accept the
work. Every default below is tuned for that: mechanical translation, strict gates,
high review depth, conservative autonomy.

Decisions locked during design:

1. **Autonomy: graduated.** Start supervised and sequential; parallelism and reduced
   review are earned through measured stability, and lost again on regressions.
2. **Topology: batch PRs into an integration branch.** One commit per verified unit
   on a working branch; batches become reviewable PRs; a land script gates merges.
3. **Shape: skills + state in the fork** (not a generic plugin, not docs-only).
   Generic extraction can happen later if a second migration wants it.

## 2. Core model

**Two loops.** The *inner loop* (agents): pick next unit from the queue, do the work,
verify against machine-checkable gates, commit, update the ledger, repeat. It must be
boring; every decision mechanical. The *outer loop* (the human): watch failure
patterns and fix the *instructions*, never hand-fix the output. A hand-fix repairs
one file; an instruction fix repairs every future file.

**Stateless iterations, stateful repo.** Any iteration must be executable by a fresh
agent with zero conversation memory, using only what is committed: the protocol
(skills), the queue (ledger), and the accumulated rules (playbook). This is what
makes the driver swappable: `/loop` now, Workflow fan-outs later, both just "run the
skill against the ledger."

**The loop is only as strong as its verifier.** Agents always report success; the
question is whether "done" is checked by a script. Every unit type has a scripted
definition of done. *Ratchets* make progress monotonic: converted-file count only
rises, tsc error count only falls, test pass count never drops below baseline, API
surface never changes without an explicitly approved note.

**Git is the state machine.** One commit per verified unit gives bisectability, a
queryable progress log, and crash safety (a dead loop loses at most one unit).

## 3. Branch topology

Other people use this fork, so fork `main` is never touched and continues to track
upstream for them. All migration work lives in a dedicated namespace:

- `migration/main`: the integration branch, the "verified frontier." Always green.
  Nothing lands here except through the land script. All machinery files exist only
  here and below; fork `main` stays clean.
- `migration/batch-NNN`: working branches the inner loop commits to. One at a time in
  sequential mode; one per worker in parallel mode.
- Batch PRs are branch-to-branch within the fork (`migration/batch-NNN` into
  `migration/main`). The PR is the review surface; the land script is the merge
  mechanism.
- The upstream-sync unit type (section 10) merges `upstream/main` into
  `migration/main` on a fixed cadence.
- Upstream contributions are built by the export script (section 9) as clean branches
  off `upstream/main`; they never carry migration machinery.

## 4. Repository layout

```
.claude/skills/migrate-next/SKILL.md    # inner-loop protocol: do exactly one unit
.claude/skills/migrate-batch/SKILL.md   # assemble N done units into a reviewable PR
docs/migration/PLAYBOOK.md              # translation rules + learned constraints
docs/migration/PLAN.md                  # the battle plan (separate effort; see Scope)
docs/migration/LEDGER.jsonl             # machine state, one unit per line
docs/migration/RATCHET_BASELINE.json    # committed ratchet values on migration/main
scripts/migration/ledger.mjs            # read / pick / update / check / stats
scripts/migration/verify.mjs            # gate runner: per-unit fast tier + ratchets
scripts/migration/land.mjs              # sole sanctioned merge path into migration/main
scripts/migration/export.mjs            # build clean upstream-PR branches
.github/workflows/migration-ci.yml      # optional belt-and-suspenders (see section 7)
```

Scripts are Node (`.mjs`) or bash, never Python. The strategy/plan boundary is an
interface: `PLAN.md` defines unit types, gate commands per type, and generates queue
entries; skills, ledger, and scripts are agnostic to what a unit means.

## 5. The ledger

JSONL, one unit per line: clean one-line diffs per status change, near-zero merge
conflicts under parallelism.

```json
{"id":"ts:lib/util/functional.js","type":"ts-convert","paths":["lib/util/functional.js"],
 "deps":["ts:lib/debug/asserts.js"],"status":"pending","attempts":0,"batch":null,
 "commit":null,"note":null}
```

- `deps`: ordering edges (e.g., leaf-first import order for conversions). The picker
  only offers units whose deps are `done`. The plan generates edges (import graph).
- `status`: `pending` | `in_progress` (ephemeral, working-tree only in sequential
  mode) | `done` | `quarantined` (failed repeatedly; set aside for a human; loop
  continues) | `blocked` (dep quarantined or external blocker).
- `commit`: backfilled by the batch skill (a commit cannot contain its own sha). The
  durable unit-to-commit link is the message convention `migrate(<type>): <unit-id>`.

**Invariants** (enforced by `ledger.mjs check` and the land script):

1. A code change always carries its unit's ledger flip in the same commit.
   Ledger-only commits are permitted for exactly two cases: status-only transitions
   (quarantine, unblock) and the batch skill's metadata backfill (`commit`, `batch`
   fields).
2. Every `done` unit resolves to exactly one commit by message convention, and every
   `migrate:` commit resolves to a `done` unit (checked in both directions).
3. Only truth is committed; views are derived. No committed status dashboards.
4. Machinery changes (skills, scripts, playbook) never share a commit with unit work,
   so reverting one never reverts the other.

## 6. Inner loop protocol (`migrate-next`)

1. **Preflight.** Working tree clean; `ledger.mjs check` passes. A dirty tree means a
   prior iteration died: reset it (loses at most one unit).
2. **Pick.** `ledger.mjs pick`: next eligible unit, deterministic order from plan
   priority. No agent judgment.
3. **Convert.** Apply the playbook rules for the unit type. Faithfulness rule is
   absolute: mechanical translation only; no refactors, no improvements. "Do the
   rewrite that looks like we transpiled." If the code needs a paragraph-long comment
   to justify it, it is wrong.
4. **Verify (fast tier).** `verify.mjs --unit <id>`: targeted tests, lint,
   incremental tsc, affected-entry build. Seconds to a minute.
5. **Review.** Config toggle. Calibration: the human reviews every diff. After
   promotion 1: an adversarial subagent that sees only the diff, instructed to assume
   the code is wrong. Findings return to step 3.
6. **Commit.** One commit: code change + ledger flip to `done`. Message:
   `migrate(<type>): <unit-id>`.
7. **Repeat or stop.** Stop when batch size is reached (hand off to `migrate-batch`),
   the queue is empty, or the infrastructure itself fails (verify script erroring),
   which halts loudly instead of quarantining.

**Failure policy: quarantine, don't stall.** On gate failure the agent has a bounded
fix budget (two attempts). Still failing: revert the working tree, record the failure
signature, mark `quarantined` (ledger-only commit), continue to the next unit. Three
quarantines sharing a signature indicate a missing playbook rule, not three broken
files.

## 7. Gates and ratchets (local-first)

**Two tiers.** Fast per-unit gates run inside the loop (step 4). Full ratchets run
once per batch, at land time. This fits runtime reality: the full shaka suite is too
slow per unit and fine per 10-25 units.

**The land script is the enforcer.** Upstream's CI does not run in forks, so
enforcement is local by design. `land.mjs` is the only sanctioned path into
`migration/main`: run the full ratchet suite against the merge result, compare
against `RATCHET_BASELINE.json`, refuse any regression, merge, update the baseline in
the merge commit. Every baseline movement is auditable history; "regression" is a
comparison against a committed number, never a re-derivation.

**Ratchet manifest.** A committed list of monotonic metrics and directions. Initial
set: files-converted (up), tsc errors (down), test pass count (never below baseline),
API surface (no diff against a generated golden report unless the batch carries an
explicitly approved change note). Tests alone are not Bun's million assertions, so
the API-surface golden is the extra semantic anchor. The plan may add metrics per
phase.

**Optional CI.** A self-contained `migration-ci.yml` (no secrets: checkout, build,
headless-Chrome unit tests, `verify.mjs --ratchets`) may run on PRs targeting
`migration/main` as belt-and-suspenders. Hard rule either way: CI runs the same
scripts as the land script. No CI-only logic, so local and CI cannot drift. Nothing
downstream depends on CI existing.

## 8. Batching and review (`migrate-batch`)

Fires at batch size (3-5 units during calibration, 10-25 after promotion) or on
demand. It backfills commit shas into the ledger (one metadata commit), generates the
batch report, and opens the PR against `migration/main`.

**The report is the review surface:** units completed; ratchet deltas; all
quarantined units with failure signatures; units that needed more than one fix
attempt; diffstat.

**Review-by-pattern, graduated.** Calibration: read every diff. After promotion:
read the report fully, then risk-weighted sampling: always read units with more than
one fix attempt and all quarantine notes, plus a random k of the clean ones. The
human validates the process, not every line, once gates have earned trust.

**Review catches are instruction bugs.** Anything human review catches should have
been caught by gates or the reviewer agent. The fix lands in the playbook or skill
first; then the unit is reverted (append-only revert commit, no history rewrites) and
flipped back to `pending` to be redone under the improved rules.

## 9. Upstream export

`migration/main` history is deliberately polluted with machinery. `export.mjs` builds
upstream contributions by construction: given a chunk spec, start a clean branch from
`upstream/main`, apply the accumulated tree diff restricted to product paths (path
allowlist; machinery paths denylisted), squash into reviewable commits sized for
upstream. Per-unit granularity exists for the fork's audit trail; upstream sees
coherent module-sized changes. Chunking and timing are plan/maintainer questions;
because `migration/main` is always green, an exportable checkpoint exists at every
merge.

## 10. Outer loop

**Calibration.** Every new unit type starts here: playbook v0 written, a pilot slice
of 3-5 units runs fully supervised, human reviews every diff and acts as the
adversarial reviewer. Two tracked numbers drive promotion: instruction-edit rate (did
the unit force a playbook/skill change?) and gate-escape rate (did the human catch
what gates missed?).

**Promotion, earned; demotion, automatic.**

- Promotion 1 (default threshold: 5 consecutive units, zero playbook edits, zero
  review catches): adversarial subagent replaces per-unit human review.
- Promotion 2 (default: 2 consecutive batches landing clean under sampling): parallel
  fan-out unlocks, 2-4 workers in separate worktrees over dependency-independent
  queue partitions, same skill, different driver.
- Demotion: any regression reaching `migration/main`, or two review catches in one
  batch, drops autonomy one level and must produce the missing rule.
- Unattended runs: out of scope unless a phase proves purely mechanical; possibly
  never, given the quality goal.

**The recurring human session is a checklist:** read batch report; sample diffs per
the risk rule; triage quarantines (shared signature: write the rule,
revert-and-requeue; hard singleton: leave for a manual pairing session); check
ratchet trends; decide promotion/demotion; land.

**Playbook discipline.** Every rule carries an ID, date, triggering example, and
rationale. Organized by unit type; the skill loads only the relevant section. When a
section outgrows what an agent reliably applies, split it. A playbook nobody can hold
in context is documentation, not instructions.

**Upstream drift.** Shaka merges weekly; the fork diverges continuously, and after
conversion upstream diffs target files that no longer exist as JS. A dedicated
`upstream-sync` unit type, with its own playbook section, runs on a fixed cadence:
on a sync working branch, merge `upstream/main`, re-apply conversion rules to files
upstream touched (mechanical translation is what makes this tractable), record
affected units, then land through `land.mjs` like any batch. Sync is a first-class
unit, not an interruption, and it never bypasses the land script.

## 11. Recovery and observability

- Loop dies mid-unit: preflight resets; at most one unit lost.
- Ledger drift: `ledger.mjs check` cross-validates ledger against history both
  directions; mismatch halts loudly for human repair.
- Escaped regression on `migration/main`: land-script-mediated revert, unit to
  `pending`, demotion fires, playbook gains a rule.
- Machinery bugs: isolated by invariant 4 (never mixed with unit commits).
- `ledger.mjs stats`: counts by status/type, quarantine signatures ranked,
  units-per-day velocity.

## 12. Rails test

Before any real conversion, a deliberately trivial unit type (e.g., a header comment
across 3 files) exercises the whole machine end to end: pick, verify, commit, batch,
report, land, baseline update, export. It proves the rails, not the translation;
calibration of the first real unit type proves the semantics. Export is validated
here because discovering export bugs at upstreaming time is months too late.

## 13. Out of scope

- The conversion plan itself: phases, unit-type definitions, gate commands, queue
  generation, upstream PR chunking (all belong to `docs/migration/PLAN.md`).
- Unattended/overnight operation.
- Extracting the machinery into a reusable plugin (possible later; not now).

## 14. Defaults summary (tunable, one place)

| Knob | Calibration | Post-promotion |
| --- | --- | --- |
| Batch size | 3-5 units | 10-25 units |
| Fix attempts before quarantine | 2 | 2 |
| Human review depth | every diff | report + risk-weighted sample |
| Reviewer | human | adversarial subagent (diff-only) |
| Clean-unit sample size k | n/a (all read) | 3 per batch |
| Promotion 1 threshold | 5 consecutive clean units | n/a |
| Promotion 2 threshold | n/a | 2 consecutive clean batches |
| Parallelism | 1 | 2-4 worktrees |
| Upstream sync cadence | weekly | weekly |
