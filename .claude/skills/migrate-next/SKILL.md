---
name: migrate-next
description: Run exactly one unit of the shaka migration loop, verified and committed. Use for each iteration when driving the migration (for example /loop /migrate-next). Requires a migration/batch-* branch.
---

# migrate-next: one unit, verified, committed

You execute ONE unit of migration work, then stop. Never more than one.

## Rules that override everything
- Mechanical translation only. No refactors, no improvements, no drive-by fixes.
  If a change needs a paragraph-long comment to justify it, it is wrong.
- Never modify `scripts/migration/`, `.claude/skills/`, or `docs/migration/PLAYBOOK.md`.
  If any of them is wrong, STOP and report; that is outer-loop work.
- Never run: `git reset`, `git rebase`, `git stash`, `git push`, `git merge`. Commits only.
- Read `docs/migration/loop.json` once at start for `fixAttempts`, `reviewer`, `batchSize`.

## Protocol
1. **Preflight.**
   - `git rev-parse --abbrev-ref HEAD` must print a `migration/batch-` branch. Otherwise stop and report.
   - `git status --porcelain` must be empty. If dirty, a prior iteration died mid-unit:
     run `git checkout -- . && git clean -fd` and continue.
   - `node scripts/migration/ledger.mjs check` must print `OK`. If not, STOP loudly. Do not repair.
2. **Pick.** `node scripts/migration/ledger.mjs pick`
   - Prints `EMPTY`: report the queue is empty and stop.
   - Otherwise the printed unit JSON is your entire scope. Touch only its `paths` plus the ledger.
3. **Convert.** Read `docs/migration/PLAYBOOK.md`: the Global section plus the section for
   the unit's `type`. Apply those rules to the unit's paths. Nothing else.
4. **Verify.** `node scripts/migration/verify.mjs --unit <id>`
   - Pass: continue to Review.
   - Fail: fix and retry, at most `fixAttempts` total attempts, then go to Quarantine.
5. **Review.**
   - `reviewer` is `human`: print the full `git diff` plus a one-line summary and STOP. The human
     resumes you with approval or findings. Findings return you to step 3 (same fix budget).
   - `reviewer` is `subagent`: dispatch a fresh subagent whose entire prompt is: the unit id, the
     playbook sections you used, the full diff, and the instruction "Assume this code is wrong.
     Find the bug. Reply NONE only if you cannot." Findings return you to step 3. NONE: continue.
6. **Commit.** The unit's paths and its ledger flip go in ONE commit:
   - `node scripts/migration/ledger.mjs update <id> --status done` (add `--attempts <n>`
     when you needed n > 0 fix attempts; reviewers read those units first)
   - `git add <each path> docs/migration/LEDGER.jsonl`
   - `git commit -m "migrate(<type>): <id>"`
7. **Report and stop.** Print: unit id, gates run, review outcome, and batch progress
   (`git log --format=%s migration/main..HEAD | grep -c '^migrate('`). If progress >= `batchSize`,
   say the next action is `/migrate-batch`, not another unit.

## Quarantine (fix budget exhausted)
1. `git checkout -- . && git clean -fd`
2. `node scripts/migration/ledger.mjs update <id> --status quarantined --attempts <n> --note "<one-line failure signature>"`
3. `git add docs/migration/LEDGER.jsonl && git commit -m "migrate-meta: quarantine <id>"`
4. Report the signature. This iteration is over; the loop continues next iteration.

## Infra failure (the scripts themselves error)
STOP the loop entirely. Do not quarantine. Report the command and full output verbatim.
This is outer-loop work.
