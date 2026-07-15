# Migration Playbook

Rules the inner loop MUST follow. Every rule has an ID, a date, a triggering example,
and a why. The outer loop (the human) is the only writer. Agents: read the Global
section plus the section for your unit's type. Nothing else here concerns you.

## Global

- **G1 (2026-07-14) Faithful translation only.** Mechanical conversion; no refactors,
  no improvements, no drive-by fixes. Why: reviewability by upstream maintainers is
  the project's north star; clever diffs are unreviewable diffs.
- **G2 (2026-07-14) The paragraph test.** If a change needs a paragraph-long comment
  to justify it, it is wrong. Quarantine instead. Why: long justifications are how
  stubs and hacks sneak past review (Bun lesson).
- **G3 (2026-07-14) Machinery is out of scope.** Never modify `scripts/migration/`,
  `.claude/skills/`, or this playbook during unit work. Why: machinery reverts must
  never revert migration work, and vice versa.
- **G4 (2026-07-14) No new dependencies.** Adding a package is a human decision.
  Why: supply chain risk and upstream acceptability.

## Unit type: rails-header (rails test only)

- **R1 (2026-07-14) Exact header.** The unit's file must exist and its first line
  must be exactly `// migration-rails-header`. Why: proves gates catch
  single-character drift.

<!-- Real unit types (esm-convert, ts-convert, upstream-sync, ...) are added when
     docs/migration/PLAN.md defines them. -->
