---
name: migrate-batch
description: Assemble the current migration/batch-NNN branch into a reviewed, ratchet-checked landing on migration/main. Use when migrate-next reports the batch is full, or on demand.
---

# migrate-batch: report, review, land

1. **Preflight.** On a `migration/batch-NNN` branch, clean tree,
   `node scripts/migration/ledger.mjs check` prints `OK`.
2. **Backfill.** `node scripts/migration/ledger.mjs backfill`. If it changed the ledger:
   `git add docs/migration/LEDGER.jsonl && git commit -m "migrate-meta: backfill batch-NNN"`
3. **Report.** Assemble and print:
   - `node scripts/migration/ledger.mjs stats`
   - `git log --format='%h %s' migration/main..HEAD`
   - `git diff --stat migration/main..HEAD`
   - `node scripts/migration/land.mjs --compare` (the exact land-time ratchet verdict;
     works from the batch branch)
   - Quarantines from this batch with notes; any unit with `attempts` > 0 flagged "read first".
4. **PR (when pushing).** `git push origin migration/batch-NNN` then
   `gh pr create --base migration/main --head migration/batch-NNN --title "migration: batch-NNN (<n> units)"`
   with the report as body. Working purely locally: present the report instead.
5. **Human review gate.** STOP. Do not land without explicit approval in this conversation.
6. **Land.** From a `migration/main` checkout:
   `node scripts/migration/land.mjs --batch migration/batch-NNN`
   A refusal is final: report it verbatim, do not force, do not retry with modifications.
7. **Next branch.** `git checkout -b migration/batch-<NNN+1> migration/main`
