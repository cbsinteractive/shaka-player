# Agentic Migration Loop Machinery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the loop machinery specced in `docs/superpowers/specs/2026-07-14-agentic-migration-loop-design.md`: ledger, gates, land script, export script, two skills, seed state, the `migration/*` branch bootstrap, and a rails test proving the whole machine end to end.

**Architecture:** Plain Node `.mjs` CLIs with pure-logic libs (`scripts/migration/lib/`) unit-tested via `node --test`; git-dependent behavior tested against throwaway fixture repos. State files live under `docs/migration/`. Skills are markdown protocols that shell out to the CLIs. Nothing here implements the TypeScript conversion itself; unit types and real gates arrive later via `docs/migration/PLAN.md`.

**Tech Stack:** Node >= 18 builtins only (`node:fs`, `node:child_process`, `node:test`, `node:assert`). Git. `gh` CLI (PR creation only). No npm dependencies, no Python.

## Global Constraints

- Zero new npm dependencies; Node builtins only (repo `engines` floor: `node >= 18`, so no `readdirSync` `recursive` option; walk manually).
- No Python anywhere in the machinery; scripts are `.mjs`, per user rule.
- No em dashes in any authored doc, skill, or comment text, per user rule.
- All CLIs assume cwd = repo root; state files are at `docs/migration/*`; CLIs locate sibling scripts via `import.meta.url`, never via cwd.
- Commit message conventions (load-bearing, parsed by `ledger.mjs check`): unit work = `migrate(<type>): <unit-id>`; ledger-only = `migrate-meta: <desc>`; machinery = `feat(migration-tooling): <desc>` or `test(migration-tooling): <desc>`; merges = `land: <desc>`. Machinery changes never share a commit with unit work (spec invariant 4).
- Denylisted-from-upstream paths (must match `export.mjs` `DENY` exactly): `.claude`, `docs/migration`, `docs/superpowers`, `scripts/migration`, `.github/workflows/migration-ci.yml`.
- Unit statuses (exact strings): `pending`, `in_progress`, `done`, `quarantined`, `blocked`.
- All commits end with: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Run all commands from the repo root of this worktree.

---

### Task 1: Shell helper and pure ledger core

**Files:**
- Create: `scripts/migration/lib/sh.mjs`
- Create: `scripts/migration/lib/ledger-core.mjs`
- Test: `scripts/migration/test/ledger-core.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces: `sh(cmd, opts) -> string` (trimmed stdout, throws on nonzero), `shOk(cmd, opts) -> boolean`; `parseLedger(text) -> Unit[]`, `serializeLedger(units) -> string`, `pickNext(units) -> Unit|null`, `updateUnit(units, id, patch) -> Unit[]`, `checkPure(units) -> string[]`. `Unit` = `{id, type, paths: string[], deps: string[], status, attempts: number, batch: string|null, commit: string|null, note: string|null}`.

- [ ] **Step 1: Write the failing test**

```js
// scripts/migration/test/ledger-core.test.mjs
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseLedger, serializeLedger, pickNext, updateUnit, checkPure} from '../lib/ledger-core.mjs';

const U = (id, extra = {}) => JSON.stringify({
  id, type: 'rails-header', paths: [`docs/migration/rails/${id}.txt`],
  deps: [], status: 'pending', attempts: 0, batch: null, commit: null, note: null, ...extra,
});

test('parseLedger parses lines, skips blanks, round-trips', () => {
  const text = U('a') + '\n\n' + U('b') + '\n';
  const units = parseLedger(text);
  assert.equal(units.length, 2);
  assert.equal(serializeLedger(units), U('a') + '\n' + U('b') + '\n');
});

test('parseLedger rejects duplicate ids, bad JSON, bad status', () => {
  assert.throws(() => parseLedger(U('a') + '\n' + U('a') + '\n'), /duplicate id/);
  assert.throws(() => parseLedger('{oops\n'), /line 1: invalid JSON/);
  assert.throws(() => parseLedger(U('a', {status: 'wat'}) + '\n'), /invalid fields/);
});

test('pickNext returns first pending whose deps are all done, in file order', () => {
  const units = parseLedger([
    U('a', {status: 'done'}),
    U('c', {deps: ['b']}),
    U('b'),
  ].join('\n') + '\n');
  assert.equal(pickNext(units).id, 'b'); // c is listed first but blocked on b
  const after = updateUnit(units, 'b', {status: 'done'});
  assert.equal(pickNext(after).id, 'c');
  assert.equal(pickNext(updateUnit(after, 'c', {status: 'done'})), null);
});

test('pickNext throws on unknown dep; updateUnit validates', () => {
  assert.throws(() => pickNext(parseLedger(U('a', {deps: ['ghost']}) + '\n')), /unknown dep/);
  const units = parseLedger(U('a') + '\n');
  assert.throws(() => updateUnit(units, 'ghost', {status: 'done'}), /unknown unit/);
  assert.throws(() => updateUnit(units, 'a', {status: 'wat'}), /invalid status/);
  assert.equal(units[0].status, 'pending'); // updateUnit does not mutate input
});

test('checkPure reports unknown deps and cycles', () => {
  const errs = checkPure(parseLedger([
    U('a', {deps: ['b']}),
    U('b', {deps: ['a']}),
    U('c', {deps: ['ghost']}),
  ].join('\n') + '\n'));
  assert.ok(errs.some((e) => e.includes('unknown dep ghost')));
  assert.ok(errs.some((e) => e.includes('dep cycle')));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scripts/migration/test/ledger-core.test.mjs`
Expected: FAIL, `Cannot find module ... ledger-core.mjs`

- [ ] **Step 3: Write the implementation**

```js
// scripts/migration/lib/sh.mjs
import {execSync} from 'node:child_process';

export function sh(cmd, opts = {}) {
  return execSync(cmd, {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts}).trim();
}

export function shOk(cmd, opts = {}) {
  try {
    sh(cmd, opts);
    return true;
  } catch {
    return false;
  }
}
```

```js
// scripts/migration/lib/ledger-core.mjs
const STATUSES = new Set(['pending', 'in_progress', 'done', 'quarantined', 'blocked']);

export function parseLedger(text) {
  const units = [];
  const seen = new Set();
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    let unit;
    try {
      unit = JSON.parse(line);
    } catch {
      throw new Error(`LEDGER line ${i + 1}: invalid JSON`);
    }
    if (!unit.id || !unit.type || !Array.isArray(unit.paths) ||
        !Array.isArray(unit.deps) || !STATUSES.has(unit.status)) {
      throw new Error(`LEDGER line ${i + 1}: missing or invalid fields`);
    }
    if (seen.has(unit.id)) throw new Error(`LEDGER line ${i + 1}: duplicate id ${unit.id}`);
    seen.add(unit.id);
    units.push(unit);
  }
  return units;
}

export function serializeLedger(units) {
  return units.map((u) => JSON.stringify(u)).join('\n') + '\n';
}

export function pickNext(units) {
  const byId = new Map(units.map((u) => [u.id, u]));
  for (const u of units) {
    if (u.status !== 'pending') continue;
    for (const d of u.deps) {
      if (!byId.has(d)) throw new Error(`unit ${u.id}: unknown dep ${d}`);
    }
    if (u.deps.every((d) => byId.get(d).status === 'done')) return u;
  }
  return null;
}

export function updateUnit(units, id, patch) {
  const i = units.findIndex((u) => u.id === id);
  if (i === -1) throw new Error(`unknown unit ${id}`);
  if (patch.status !== undefined && !STATUSES.has(patch.status)) {
    throw new Error(`invalid status ${patch.status}`);
  }
  const next = units.slice();
  next[i] = {...units[i], ...patch};
  return next;
}

export function checkPure(units) {
  const errors = [];
  const byId = new Map(units.map((u) => [u.id, u]));
  for (const u of units) {
    for (const d of u.deps) {
      if (!byId.has(d)) errors.push(`${u.id}: unknown dep ${d}`);
    }
  }
  const color = new Map();
  const visit = (id, stack) => {
    color.set(id, 'gray');
    for (const d of byId.get(id)?.deps ?? []) {
      if (!byId.has(d)) continue;
      if (color.get(d) === 'gray') {
        errors.push(`dep cycle: ${[...stack, d].join(' -> ')}`);
        continue;
      }
      if (!color.has(d)) visit(d, [...stack, d]);
    }
    color.set(id, 'black');
  };
  for (const u of units) {
    if (!color.has(u.id)) visit(u.id, [u.id]);
  }
  return errors;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test scripts/migration/test/ledger-core.test.mjs`
Expected: PASS, 5 tests

- [ ] **Step 5: Commit**

```bash
git add scripts/migration/lib/sh.mjs scripts/migration/lib/ledger-core.mjs scripts/migration/test/ledger-core.test.mjs
git commit -m "feat(migration-tooling): add shell helper and pure ledger core

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Git helpers and the fixture-repo test harness

**Files:**
- Create: `scripts/migration/lib/git.mjs`
- Create: `scripts/migration/test/helpers.mjs`
- Test: `scripts/migration/test/git.test.mjs`

**Interfaces:**
- Consumes: `sh` from Task 1.
- Produces: `migrateLog(cwd, ref='HEAD') -> {sha, kind: 'migrate'|'revert', type, unitId}[]` (newest first), `migrateNets(cwd, ref='HEAD') -> Map<unitId, number>` (migrate commits minus reverts), `isClean(cwd) -> boolean`, `currentBranch(cwd) -> string`. Test helper: `makeRepo() -> {dir, g(cmd), write(relPath, content), commitAll(msg)}` creating a temp git repo with one initial commit on `main`.

- [ ] **Step 1: Write the test helper**

```js
// scripts/migration/test/helpers.mjs
import {mkdtempSync, writeFileSync, mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, dirname} from 'node:path';
import {execSync} from 'node:child_process';

export function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'migration-test-'));
  const g = (cmd) => execSync(`git ${cmd}`, {cwd: dir, encoding: 'utf8'}).trim();
  g('init -b main');
  g('config user.email test@test.invalid');
  g('config user.name Test');
  g('config commit.gpgsign false');
  const write = (relPath, content) => {
    mkdirSync(join(dir, dirname(relPath)), {recursive: true});
    writeFileSync(join(dir, relPath), content);
  };
  const commitAll = (msg) => {
    g('add -A');
    g(`commit -m ${JSON.stringify(msg)}`);
  };
  write('README', 'fixture\n');
  commitAll('init');
  return {dir, g, write, commitAll};
}
```

- [ ] **Step 2: Write the failing test**

```js
// scripts/migration/test/git.test.mjs
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {makeRepo} from './helpers.mjs';
import {migrateLog, migrateNets, isClean, currentBranch} from '../lib/git.mjs';

test('migrateLog and migrateNets parse the commit conventions', () => {
  const repo = makeRepo();
  repo.write('a.txt', 'x\n');
  repo.commitAll('migrate(rails-header): rails:a');
  repo.write('b.txt', 'x\n');
  repo.commitAll('migrate(rails-header): rails:b');
  repo.g('revert --no-edit HEAD'); // Revert "migrate(rails-header): rails:b"
  repo.write('c.txt', 'x\n');
  repo.commitAll('migrate-meta: seed something'); // must NOT count

  const log = migrateLog(repo.dir);
  assert.deepEqual(log.map((e) => [e.kind, e.unitId]), [
    ['revert', 'rails:b'], ['migrate', 'rails:b'], ['migrate', 'rails:a'],
  ]);
  assert.equal(log[1].type, 'rails-header');
  const nets = migrateNets(repo.dir);
  assert.equal(nets.get('rails:a'), 1);
  assert.equal(nets.get('rails:b'), 0);
});

test('isClean and currentBranch', () => {
  const repo = makeRepo();
  assert.equal(isClean(repo.dir), true);
  assert.equal(currentBranch(repo.dir), 'main');
  repo.write('dirty.txt', 'x\n');
  assert.equal(isClean(repo.dir), false);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node --test scripts/migration/test/git.test.mjs`
Expected: FAIL, `Cannot find module ... git.mjs`

- [ ] **Step 4: Write the implementation**

```js
// scripts/migration/lib/git.mjs
import {sh} from './sh.mjs';

const MIGRATE_RE = /^migrate\(([a-z0-9-]+)\): (.+)$/;
const REVERT_RE = /^Revert "migrate\(([a-z0-9-]+)\): (.+)"$/;

export function migrateLog(cwd, ref = 'HEAD') {
  const out = sh(`git log --format=%H%x09%s ${ref}`, {cwd, maxBuffer: 64 * 1024 * 1024});
  const entries = [];
  if (!out) return entries;
  for (const line of out.split('\n')) {
    const tab = line.indexOf('\t');
    const sha = line.slice(0, tab);
    const subject = line.slice(tab + 1);
    let m;
    if ((m = subject.match(MIGRATE_RE))) {
      entries.push({sha, kind: 'migrate', type: m[1], unitId: m[2]});
    } else if ((m = subject.match(REVERT_RE))) {
      entries.push({sha, kind: 'revert', type: m[1], unitId: m[2]});
    }
  }
  return entries;
}

export function migrateNets(cwd, ref = 'HEAD') {
  const nets = new Map();
  for (const e of migrateLog(cwd, ref)) {
    nets.set(e.unitId, (nets.get(e.unitId) ?? 0) + (e.kind === 'migrate' ? 1 : -1));
  }
  return nets;
}

export function isClean(cwd) {
  return sh('git status --porcelain', {cwd}) === '';
}

export function currentBranch(cwd) {
  return sh('git rev-parse --abbrev-ref HEAD', {cwd});
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test scripts/migration/test/git.test.mjs`
Expected: PASS, 2 tests

- [ ] **Step 6: Commit**

```bash
git add scripts/migration/lib/git.mjs scripts/migration/test/helpers.mjs scripts/migration/test/git.test.mjs
git commit -m "feat(migration-tooling): add git log parsing and fixture-repo test harness

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: `ledger.mjs` CLI (pick, update, check, backfill, stats)

**Files:**
- Create: `scripts/migration/ledger.mjs`
- Test: `scripts/migration/test/ledger-cli.test.mjs`

**Interfaces:**
- Consumes: Task 1 core, Task 2 git helpers.
- Produces the CLI later tasks and skills shell out to:
  - `node scripts/migration/ledger.mjs pick` prints unit JSON, or prints `EMPTY` and exits 2.
  - `node scripts/migration/ledger.mjs update <id> [--status S] [--note N] [--attempts N] [--batch B] [--commit SHA]` rewrites the unit's line.
  - `node scripts/migration/ledger.mjs check [--ref <revs>]` exits 0, or prints each error and exits 1. Checks: pure invariants, plus bidirectional git cross-validation against the given revs (default `HEAD`; `land.mjs` passes the `"HEAD MERGE_HEAD"` union because during a `--no-commit` merge HEAD has not moved): `done` units must have net exactly 1 migrate commit; non-`done` units net 0; commits referencing unknown unit ids with net != 0 are errors.
  - `node scripts/migration/ledger.mjs backfill` fills `commit` (newest migrate sha) for `done` units missing it; prints number filled.
  - `node scripts/migration/ledger.mjs stats` prints status counts, type counts, quarantined list with notes, and 7-day migrate-commit count.

- [ ] **Step 1: Write the failing test**

```js
// scripts/migration/test/ledger-cli.test.mjs
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {execSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {makeRepo} from './helpers.mjs';

const CLI = fileURLToPath(new URL('../ledger.mjs', import.meta.url));
const run = (repo, args) =>
  execSync(`node ${CLI} ${args}`, {cwd: repo.dir, encoding: 'utf8'}).trim();
const runFail = (repo, args) => {
  try {
    execSync(`node ${CLI} ${args}`, {cwd: repo.dir, encoding: 'utf8', stdio: 'pipe'});
    assert.fail(`expected failure: ${args}`);
  } catch (e) {
    return {status: e.status, out: `${e.stdout}${e.stderr}`};
  }
};
const U = (id, extra = {}) => JSON.stringify({
  id, type: 'rails-header', paths: [`docs/migration/rails/${id}.txt`],
  deps: [], status: 'pending', attempts: 0, batch: null, commit: null, note: null, ...extra,
});

function seeded() {
  const repo = makeRepo();
  repo.write('docs/migration/LEDGER.jsonl',
      [U('rails:a'), U('rails:c', {deps: ['rails:b']}), U('rails:b')].join('\n') + '\n');
  repo.commitAll('migrate-meta: seed queue');
  return repo;
}

test('pick respects deps and file order; EMPTY exits 2', () => {
  const repo = seeded();
  assert.equal(JSON.parse(run(repo, 'pick')).id, 'rails:a');
  run(repo, 'update rails:a --status done');
  run(repo, 'update rails:b --status done');
  assert.equal(JSON.parse(run(repo, 'pick')).id, 'rails:c');
  run(repo, 'update rails:c --status quarantined --note "gate: header missing" --attempts 2');
  const r = runFail(repo, 'pick');
  assert.equal(r.status, 2);
  assert.match(r.out, /EMPTY/);
  const line = readFileSync(join(repo.dir, 'docs/migration/LEDGER.jsonl'), 'utf8')
      .split('\n').find((l) => l.includes('rails:c'));
  assert.match(line, /"note":"gate: header missing"/);
  assert.match(line, /"attempts":2/);
});

test('check cross-validates ledger against migrate commits both directions', () => {
  const repo = seeded();
  assert.equal(run(repo, 'check'), 'OK'); // all pending, no migrate commits: consistent
  // done without commit -> error
  run(repo, 'update rails:a --status done');
  let r = runFail(repo, 'check');
  assert.equal(r.status, 1);
  assert.match(r.out, /rails:a: done but 0 net migrate commits/);
  // matching commit -> passes
  repo.write('docs/migration/rails/a.txt', '// migration-rails-header\n');
  repo.commitAll('migrate(rails-header): rails:a');
  assert.equal(run(repo, 'check'), 'OK');
  // commit for unknown unit -> error
  repo.write('x.txt', 'x\n');
  repo.commitAll('migrate(rails-header): rails:ghost');
  r = runFail(repo, 'check');
  assert.match(r.out, /unknown unit rails:ghost/);
});

test('backfill fills commit shas for done units; stats prints counts', () => {
  const repo = seeded();
  run(repo, 'update rails:a --status done');
  repo.write('docs/migration/rails/a.txt', '// migration-rails-header\n');
  repo.commitAll('migrate(rails-header): rails:a');
  assert.match(run(repo, 'backfill'), /backfilled 1/);
  const sha = repo.g('log --format=%H --grep "^migrate(rails-header): rails:a$" -n 1');
  const line = readFileSync(join(repo.dir, 'docs/migration/LEDGER.jsonl'), 'utf8')
      .split('\n').find((l) => l.includes('rails:a'));
  assert.ok(line.includes(sha));
  const stats = run(repo, 'stats');
  assert.match(stats, /done: 1/);
  assert.match(stats, /pending: 2/);
  assert.match(stats, /rails-header: 3/);
  assert.match(stats, /migrate commits last 7 days: 1/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scripts/migration/test/ledger-cli.test.mjs`
Expected: FAIL, `Cannot find module ... ledger.mjs`

- [ ] **Step 3: Write the implementation**

```js
#!/usr/bin/env node
// scripts/migration/ledger.mjs
import {readFileSync, writeFileSync} from 'node:fs';
import {parseLedger, serializeLedger, pickNext, updateUnit, checkPure} from './lib/ledger-core.mjs';
import {migrateLog, migrateNets} from './lib/git.mjs';
import {sh} from './lib/sh.mjs';

const LEDGER = 'docs/migration/LEDGER.jsonl';
const load = () => parseLedger(readFileSync(LEDGER, 'utf8'));
const save = (units) => writeFileSync(LEDGER, serializeLedger(units));

const [cmd, ...args] = process.argv.slice(2);

function parseFlags(list) {
  const flags = {};
  for (let i = 0; i < list.length; i += 2) {
    if (!list[i].startsWith('--') || list[i + 1] === undefined) {
      throw new Error(`bad flag pair near ${list[i]}`);
    }
    flags[list[i].slice(2)] = list[i + 1];
  }
  return flags;
}

switch (cmd) {
  case 'pick': {
    const u = pickNext(load());
    if (!u) {
      console.log('EMPTY');
      process.exit(2);
    }
    console.log(JSON.stringify(u));
    break;
  }
  case 'update': {
    const id = args[0];
    const flags = parseFlags(args.slice(1));
    const patch = {};
    if (flags.status !== undefined) patch.status = flags.status;
    if (flags.note !== undefined) patch.note = flags.note;
    if (flags.batch !== undefined) patch.batch = flags.batch;
    if (flags.commit !== undefined) patch.commit = flags.commit;
    if (flags.attempts !== undefined) patch.attempts = Number(flags.attempts);
    save(updateUnit(load(), id, patch));
    console.log(`updated ${id}`);
    break;
  }
  case 'check': {
    const flags = parseFlags(args);
    const ref = flags.ref ?? 'HEAD';
    const units = load();
    const errors = checkPure(units);
    const nets = migrateNets(process.cwd(), ref);
    const byId = new Map(units.map((u) => [u.id, u]));
    for (const u of units) {
      const net = nets.get(u.id) ?? 0;
      if (u.status === 'done' && net !== 1) {
        errors.push(`${u.id}: done but ${net} net migrate commits`);
      }
      if (u.status !== 'done' && net !== 0) {
        errors.push(`${u.id}: ${u.status} but ${net} net migrate commits`);
      }
    }
    for (const [id, net] of nets) {
      if (!byId.has(id) && net !== 0) errors.push(`commit references unknown unit ${id}`);
    }
    if (errors.length) {
      for (const e of errors) console.error(e);
      process.exit(1);
    }
    console.log('OK');
    break;
  }
  case 'backfill': {
    let units = load();
    const newestShaFor = new Map();
    for (const e of migrateLog(process.cwd())) {
      if (e.kind === 'migrate' && !newestShaFor.has(e.unitId)) newestShaFor.set(e.unitId, e.sha);
    }
    let filled = 0;
    for (const u of units) {
      if (u.status === 'done' && !u.commit && newestShaFor.has(u.id)) {
        units = updateUnit(units, u.id, {commit: newestShaFor.get(u.id)});
        filled++;
      }
    }
    save(units);
    console.log(`backfilled ${filled}`);
    break;
  }
  case 'stats': {
    const units = load();
    const count = (fn) => units.reduce((m, u) => {
      const k = fn(u);
      m.set(k, (m.get(k) ?? 0) + 1);
      return m;
    }, new Map());
    console.log('by status:');
    for (const [k, v] of count((u) => u.status)) console.log(`  ${k}: ${v}`);
    console.log('by type:');
    for (const [k, v] of count((u) => u.type)) console.log(`  ${k}: ${v}`);
    const q = units.filter((u) => u.status === 'quarantined');
    console.log(`quarantined (${q.length}):`);
    for (const u of q) console.log(`  ${u.id}: ${u.note ?? '(no note)'}`);
    const week = sh('git log --format=%s --since=7.days HEAD', {cwd: process.cwd()})
        .split('\n').filter((s) => /^migrate\(/.test(s)).length;
    console.log(`migrate commits last 7 days: ${week}`);
    break;
  }
  default:
    console.error('usage: ledger.mjs pick|update|check|backfill|stats');
    process.exit(1);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test scripts/migration/test/ledger-cli.test.mjs`
Expected: PASS, 3 tests

- [ ] **Step 5: Commit**

```bash
git add scripts/migration/ledger.mjs scripts/migration/test/ledger-cli.test.mjs
git commit -m "feat(migration-tooling): add ledger CLI with git cross-validation

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: `rails-gate.mjs` and `verify.mjs`

**Files:**
- Create: `scripts/migration/rails-gate.mjs`
- Create: `scripts/migration/verify.mjs`
- Test: `scripts/migration/test/verify.test.mjs`

**Interfaces:**
- Consumes: ledger core (unit lookup), `sh`.
- Produces:
  - `node scripts/migration/rails-gate.mjs --check <file...>` exits 0 iff every file's first line is exactly `// migration-rails-header`; prints offenders. `--count <path...>` prints the number of files (recursively under dirs, skipping missing paths) whose first line is the header.
  - `node scripts/migration/verify.mjs --unit <id>` runs `fast` gate commands for the unit's type from `docs/migration/gates.json`, substituting `{paths}` with the unit's double-quoted paths; exits nonzero on first failure.
  - `node scripts/migration/verify.mjs --ratchets` runs every entry of `docs/migration/ratchets.json` (`[{id, direction: 'up'|'down'|'eq', command}]`) and prints a JSON object mapping id to value (numeric when the output parses as an integer).

- [ ] **Step 1: Write the failing test**

```js
// scripts/migration/test/verify.test.mjs
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {makeRepo} from './helpers.mjs';

const VERIFY = fileURLToPath(new URL('../verify.mjs', import.meta.url));
const GATE = fileURLToPath(new URL('../rails-gate.mjs', import.meta.url));
const HEADER = '// migration-rails-header\n';

function seeded() {
  const repo = makeRepo();
  repo.write('docs/migration/gates.json', JSON.stringify({
    'rails-header': {fast: [`node ${GATE} --check {paths}`]},
  }));
  repo.write('docs/migration/ratchets.json', JSON.stringify([
    {id: 'rails-headers', direction: 'up', command: `node ${GATE} --count docs/migration/rails lib/__rails_probe.js`},
  ]));
  repo.write('docs/migration/LEDGER.jsonl', JSON.stringify({
    id: 'rails:a', type: 'rails-header', paths: ['docs/migration/rails/a.txt'],
    deps: [], status: 'pending', attempts: 0, batch: null, commit: null, note: null,
  }) + '\n');
  return repo;
}

test('verify --unit passes when the gate passes and fails when it fails', () => {
  const repo = seeded();
  repo.write('docs/migration/rails/a.txt', HEADER + 'body\n');
  const out = execSync(`node ${VERIFY} --unit rails:a`, {cwd: repo.dir, encoding: 'utf8'});
  assert.match(out, /PASS/);
  repo.write('docs/migration/rails/a.txt', 'no header\n');
  assert.throws(() => execSync(`node ${VERIFY} --unit rails:a`, {cwd: repo.dir, stdio: 'pipe'}));
});

test('verify --ratchets computes numeric values from the manifest', () => {
  const repo = seeded();
  repo.write('docs/migration/rails/a.txt', HEADER);
  repo.write('docs/migration/rails/sub/b.txt', HEADER);
  repo.write('docs/migration/rails/c.txt', 'not counted\n');
  repo.write('lib/__rails_probe.js', HEADER);
  const out = JSON.parse(execSync(`node ${VERIFY} --ratchets`, {cwd: repo.dir, encoding: 'utf8'}));
  assert.deepEqual(out, {'rails-headers': 3});
});

test('verify --unit fails on unknown unit or missing gate type', () => {
  const repo = seeded();
  assert.throws(() => execSync(`node ${VERIFY} --unit ghost`, {cwd: repo.dir, stdio: 'pipe'}));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scripts/migration/test/verify.test.mjs`
Expected: FAIL, `Cannot find module ... verify.mjs`

- [ ] **Step 3: Write the implementations**

```js
#!/usr/bin/env node
// scripts/migration/rails-gate.mjs
import {readFileSync, readdirSync, statSync, existsSync} from 'node:fs';
import {join} from 'node:path';

const HEADER = '// migration-rails-header';
const hasHeader = (file) => readFileSync(file, 'utf8').split('\n')[0] === HEADER;

function walk(path, out) {
  if (!existsSync(path)) return;
  if (statSync(path).isFile()) {
    out.push(path);
    return;
  }
  for (const name of readdirSync(path)) walk(join(path, name), out);
}

const [mode, ...paths] = process.argv.slice(2);
if (mode === '--check') {
  const bad = paths.filter((p) => !existsSync(p) || !hasHeader(p));
  if (bad.length) {
    console.error(`missing header: ${bad.join(', ')}`);
    process.exit(1);
  }
  console.log('headers OK');
} else if (mode === '--count') {
  const files = [];
  for (const p of paths) walk(p, files);
  console.log(String(files.filter(hasHeader).length));
} else {
  console.error('usage: rails-gate.mjs --check <file...> | --count <path...>');
  process.exit(1);
}
```

```js
#!/usr/bin/env node
// scripts/migration/verify.mjs
import {readFileSync} from 'node:fs';
import {execSync} from 'node:child_process';
import {parseLedger} from './lib/ledger-core.mjs';
import {sh} from './lib/sh.mjs';

const GATES = 'docs/migration/gates.json';
const RATCHETS = 'docs/migration/ratchets.json';

const [mode, arg] = process.argv.slice(2);

if (mode === '--unit') {
  const units = parseLedger(readFileSync('docs/migration/LEDGER.jsonl', 'utf8'));
  const unit = units.find((u) => u.id === arg);
  if (!unit) {
    console.error(`unknown unit ${arg}`);
    process.exit(1);
  }
  const gates = JSON.parse(readFileSync(GATES, 'utf8'))[unit.type];
  if (!gates || !Array.isArray(gates.fast)) {
    console.error(`no fast gates configured for type ${unit.type}`);
    process.exit(1);
  }
  const quoted = unit.paths.map((p) => `"${p}"`).join(' ');
  for (const tmpl of gates.fast) {
    const cmd = tmpl.replaceAll('{paths}', quoted);
    console.log(`gate: ${cmd}`);
    execSync(cmd, {stdio: 'inherit'}); // nonzero exit propagates
  }
  console.log(`PASS ${arg}`);
} else if (mode === '--ratchets') {
  const manifest = JSON.parse(readFileSync(RATCHETS, 'utf8'));
  const values = {};
  for (const r of manifest) {
    const out = sh(r.command, {maxBuffer: 64 * 1024 * 1024});
    values[r.id] = /^-?\d+$/.test(out) ? Number(out) : out;
  }
  console.log(JSON.stringify(values, null, 2));
} else {
  console.error('usage: verify.mjs --unit <id> | --ratchets');
  process.exit(1);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test scripts/migration/test/verify.test.mjs`
Expected: PASS, 3 tests

- [ ] **Step 5: Commit**

```bash
git add scripts/migration/rails-gate.mjs scripts/migration/verify.mjs scripts/migration/test/verify.test.mjs
git commit -m "feat(migration-tooling): add gate runner and rails gate

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: `land.mjs`, the sole merge path

**Files:**
- Create: `scripts/migration/land.mjs`
- Test: `scripts/migration/test/land.test.mjs`

**Interfaces:**
- Consumes: `sh`, `isClean`, `currentBranch`; shells out to sibling `verify.mjs --ratchets` and `ledger.mjs check --ref "HEAD MERGE_HEAD"` (resolved via `import.meta.url`, run with `cwd` = target repo; the ref union is required because during a `--no-commit` merge HEAD has not moved, so a plain check would never see the batch's commits).
- Produces:
  - `node scripts/migration/land.mjs --init` on `migration/main`: writes `docs/migration/RATCHET_BASELINE.json` from current ratchet values and commits it.
  - `node scripts/migration/land.mjs --batch <branch>` on `migration/main`: no-ff no-commit merge; abort on conflict; run ledger check and ratchets on the merged tree; compare against baseline honoring directions (`up` means new >= old, `down` means new <= old, `eq` means string-equal); ratchets new to the manifest are allowed and noted; ratchets missing from the manifest are dropped from comparison with a loud note; any violation aborts the merge and exits 1 leaving `migration/main` clean; success writes the new baseline into the merge commit `land: <branch> (<n> units)` where n counts `migrate(` subjects in `migration/main..<branch>`.
  - Internal helper exported for tests: `compare(baseline, current, manifest) -> {failures: string[], notes: string[]}`.

- [ ] **Step 1: Write the failing test**

```js
// scripts/migration/test/land.test.mjs
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {makeRepo} from './helpers.mjs';
import {compare} from '../land.mjs';

const LAND = fileURLToPath(new URL('../land.mjs', import.meta.url));

test('compare honors directions, new ratchets, dropped ratchets', () => {
  const manifest = [
    {id: 'a', direction: 'up', command: 'x'},
    {id: 'b', direction: 'down', command: 'x'},
    {id: 'c', direction: 'eq', command: 'x'},
    {id: 'n', direction: 'up', command: 'x'},
  ];
  const {failures, notes} = compare(
      {a: 5, b: 5, c: 'v1', dropped: 9},
      {a: 4, b: 6, c: 'v2', n: 1},
      manifest);
  assert.deepEqual(failures, [
    'a: 5 -> 4 violates up',
    'b: 5 -> 6 violates down',
    'c: v1 -> v2 violates eq',
  ]);
  assert.ok(notes.some((s) => s.includes('new ratchet n')));
  assert.ok(notes.some((s) => s.includes('ratchet dropped: dropped')));
});

// Fixture: a repo whose single ratchet reads a number from count.txt.
function landRepo() {
  const repo = makeRepo();
  repo.write('docs/migration/LEDGER.jsonl', '');
  repo.write('docs/migration/gates.json', '{}');
  repo.write('docs/migration/ratchets.json', JSON.stringify([
    {id: 'count', direction: 'up', command: 'cat count.txt'},
  ]));
  repo.write('count.txt', '1');
  repo.commitAll('feat(migration-tooling): seed');
  repo.g('branch -m migration/main');
  execSync(`node ${LAND} --init`, {cwd: repo.dir, encoding: 'utf8'});
  return repo;
}

test('land --init writes and commits the baseline', () => {
  const repo = landRepo();
  assert.match(repo.g('log --format=%s -n 1'), /land: initialize ratchet baseline/);
  assert.equal(repo.g('status --porcelain'), '');
  const baseline = JSON.parse(repo.g('show HEAD:docs/migration/RATCHET_BASELINE.json'));
  assert.deepEqual(baseline, {count: 1});
});

test('land --batch merges a good batch and updates the baseline', () => {
  const repo = landRepo();
  repo.g('checkout -b migration/batch-000');
  repo.write('count.txt', '2');
  repo.write('f.txt', 'x\n');
  repo.commitAll('migrate(rails-header): rails:f');
  repo.write('docs/migration/LEDGER.jsonl', JSON.stringify({
    id: 'rails:f', type: 'rails-header', paths: ['f.txt'], deps: [],
    status: 'done', attempts: 0, batch: null, commit: null, note: null,
  }) + '\n');
  repo.commitAll('migrate-meta: reconcile ledger for test');
  repo.g('checkout migration/main');
  const out = execSync(`node ${LAND} --batch migration/batch-000`, {cwd: repo.dir, encoding: 'utf8'});
  assert.match(out, /LANDED migration\/batch-000 \(1 units\)/);
  assert.match(repo.g('log --format=%s -n 1'), /land: migration\/batch-000 \(1 units\)/);
  const baseline = JSON.parse(repo.g('show HEAD:docs/migration/RATCHET_BASELINE.json'));
  assert.deepEqual(baseline, {count: 2});
});

test('land --batch refuses a regression and leaves migration/main untouched', () => {
  const repo = landRepo();
  const before = repo.g('rev-parse HEAD');
  repo.g('checkout -b migration/batch-000');
  repo.write('count.txt', '0');
  repo.commitAll('migrate-meta: tamper');
  repo.g('checkout migration/main');
  try {
    execSync(`node ${LAND} --batch migration/batch-000`, {cwd: repo.dir, stdio: 'pipe'});
    assert.fail('expected refusal');
  } catch (e) {
    assert.match(`${e.stdout}${e.stderr}`, /count: 1 -> 0 violates up/);
  }
  assert.equal(repo.g('rev-parse HEAD'), before);
  assert.equal(repo.g('status --porcelain'), '');
});

test('land --batch refuses when not on migration/main', () => {
  const repo = landRepo();
  repo.g('checkout -b migration/batch-000');
  try {
    execSync(`node ${LAND} --batch migration/batch-000`, {cwd: repo.dir, stdio: 'pipe'});
    assert.fail('expected refusal');
  } catch (e) {
    assert.match(`${e.stdout}${e.stderr}`, /must run on migration\/main/);
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scripts/migration/test/land.test.mjs`
Expected: FAIL, `Cannot find module ... land.mjs`

- [ ] **Step 3: Write the implementation**

```js
#!/usr/bin/env node
// scripts/migration/land.mjs
import {readFileSync, writeFileSync, existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {sh, shOk} from './lib/sh.mjs';
import {isClean, currentBranch} from './lib/git.mjs';

const BASELINE = 'docs/migration/RATCHET_BASELINE.json';
const RATCHETS = 'docs/migration/ratchets.json';
const VERIFY = fileURLToPath(new URL('./verify.mjs', import.meta.url));
const LEDGER_CLI = fileURLToPath(new URL('./ledger.mjs', import.meta.url));

export function compare(baseline, current, manifest) {
  const failures = [];
  const notes = [];
  for (const r of manifest) {
    const cur = current[r.id];
    if (!(r.id in baseline)) {
      notes.push(`new ratchet ${r.id} = ${cur}`);
      continue;
    }
    const base = baseline[r.id];
    const ok = r.direction === 'up' ? cur >= base :
        r.direction === 'down' ? cur <= base :
        String(cur) === String(base);
    if (!ok) failures.push(`${r.id}: ${base} -> ${cur} violates ${r.direction}`);
  }
  for (const id of Object.keys(baseline)) {
    if (!manifest.some((r) => r.id === id)) {
      notes.push(`ratchet dropped: ${id} (baseline was ${baseline[id]})`);
    }
  }
  return {failures, notes};
}

function main() {
  const cwd = process.cwd();
  const [mode, branch] = process.argv.slice(2);
  const die = (msg) => {
    console.error(msg);
    process.exit(1);
  };
  if (currentBranch(cwd) !== 'migration/main') die('must run on migration/main');
  if (!isClean(cwd)) die('working tree must be clean');
  const ratchets = () => JSON.parse(sh(`node ${VERIFY} --ratchets`, {cwd, maxBuffer: 64 * 1024 * 1024}));

  if (mode === '--init') {
    writeFileSync(BASELINE, JSON.stringify(ratchets(), null, 2) + '\n');
    sh(`git add ${BASELINE}`, {cwd});
    sh('git commit -m "land: initialize ratchet baseline"', {cwd});
    console.log('baseline initialized');
    return;
  }
  if (mode !== '--batch' || !branch) die('usage: land.mjs --init | --batch <branch>');
  if (!existsSync(BASELINE)) die('no baseline; run land.mjs --init first');

  if (!shOk(`git merge --no-ff --no-commit ${branch}`, {cwd})) {
    shOk('git merge --abort', {cwd});
    die(`merge conflict merging ${branch}; aborted`);
  }
  const abort = (msg) => {
    sh('git merge --abort', {cwd});
    die(msg);
  };
  if (!shOk(`node ${LEDGER_CLI} check --ref "HEAD MERGE_HEAD"`, {cwd})) {
    abort('ledger check failed on merged tree; aborted');
  }
  const baseline = JSON.parse(readFileSync(BASELINE, 'utf8'));
  const manifest = JSON.parse(readFileSync(RATCHETS, 'utf8'));
  const current = ratchets();
  const {failures, notes} = compare(baseline, current, manifest);
  for (const n of notes) console.log(`note: ${n}`);
  if (failures.length) abort(failures.join('\n'));

  const n = sh(`git log --format=%s migration/main..${branch}`, {cwd})
      .split('\n').filter((s) => /^migrate\(/.test(s)).length;
  writeFileSync(BASELINE, JSON.stringify(current, null, 2) + '\n');
  sh(`git add ${BASELINE}`, {cwd});
  sh(`git commit -m "land: ${branch} (${n} units)"`, {cwd});
  console.log(`LANDED ${branch} (${n} units)`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test scripts/migration/test/land.test.mjs`
Expected: PASS, 5 tests

- [ ] **Step 5: Commit**

```bash
git add scripts/migration/land.mjs scripts/migration/test/land.test.mjs
git commit -m "feat(migration-tooling): add land script, the sole ratcheted merge path

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: `export.mjs`, machinery-free upstream branches

**Files:**
- Create: `scripts/migration/export.mjs`
- Test: `scripts/migration/test/export.test.mjs`

**Interfaces:**
- Consumes: `sh`, `shOk`.
- Produces: `node scripts/migration/export.mjs --onto <ref> --out <branch> [--from <ref>=migration/main] [--paths <p...>] [--message <msg>]`. Builds `<branch>` at `<ref>` plus one squashed commit containing the tree diff from `<ref>` to `<from>` restricted to `--paths` (default whole tree) and always excluding the `DENY` list. Prints `EMPTY EXPORT` and creates no branch when the restricted diff is empty. Uses a temp worktree; never touches the current checkout.

- [ ] **Step 1: Write the failing test**

```js
// scripts/migration/test/export.test.mjs
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {makeRepo} from './helpers.mjs';

const EXPORT = fileURLToPath(new URL('../export.mjs', import.meta.url));

function repoWithHistory() {
  const repo = makeRepo();
  repo.g('branch base');
  repo.write('lib/thing.js', 'product change\n');
  repo.write('docs/migration/LEDGER.jsonl', 'machinery\n');
  repo.write('.claude/skills/migrate-next/SKILL.md', 'machinery\n');
  repo.write('scripts/migration/x.mjs', 'machinery\n');
  repo.commitAll('migrate(rails-header): rails:thing');
  repo.g('branch -m migration/main');
  return repo;
}

test('export produces a clean branch containing only product paths', () => {
  const repo = repoWithHistory();
  const out = execSync(
      `node ${EXPORT} --onto base --out export-check --message "export test"`,
      {cwd: repo.dir, encoding: 'utf8'});
  assert.match(out, /EXPORTED export-check/);
  const files = repo.g('diff --name-only base export-check').split('\n');
  assert.deepEqual(files, ['lib/thing.js']);
  assert.match(repo.g('log --format=%s -n 1 export-check'), /export test/);
});

test('export prints EMPTY EXPORT and creates no branch when only machinery changed', () => {
  const repo = repoWithHistory();
  repo.g('checkout base');
  repo.write('lib/thing.js', 'product change\n'); // make product trees identical
  repo.commitAll('sync product');
  repo.g('branch base2');
  repo.g('checkout migration/main');
  const out = execSync(
      `node ${EXPORT} --onto base2 --out empty-check`,
      {cwd: repo.dir, encoding: 'utf8'});
  assert.match(out, /EMPTY EXPORT/);
  assert.equal(repo.g('branch --list empty-check'), '');
});

test('export refuses to overwrite an existing branch', () => {
  const repo = repoWithHistory();
  repo.g('branch taken');
  assert.throws(() => execSync(
      `node ${EXPORT} --onto base --out taken`, {cwd: repo.dir, stdio: 'pipe'}));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scripts/migration/test/export.test.mjs`
Expected: FAIL, `Cannot find module ... export.mjs`

- [ ] **Step 3: Write the implementation**

```js
#!/usr/bin/env node
// scripts/migration/export.mjs
import {mkdtempSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {sh, shOk} from './lib/sh.mjs';

const DENY = ['.claude', 'docs/migration', 'docs/superpowers', 'scripts/migration',
  '.github/workflows/migration-ci.yml'];

const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? dflt : args[i + 1];
};
const from = flag('from', 'migration/main');
const onto = flag('onto', 'upstream/main');
const out = flag('out', null);
const message = flag('message', `export: product diff ${onto}..${from}`);
const pathsIdx = args.indexOf('--paths');
const paths = pathsIdx === -1 ? ['.'] : args.slice(pathsIdx + 1).filter((a) => !a.startsWith('--'));

if (!out) {
  console.error('usage: export.mjs --onto <ref> --out <branch> [--from <ref>] [--paths <p...>] [--message <msg>]');
  process.exit(1);
}
if (shOk(`git rev-parse --verify ${out}`)) {
  console.error(`branch ${out} already exists`);
  process.exit(1);
}

const cwd = process.cwd();
const big = {maxBuffer: 256 * 1024 * 1024};
const excludes = DENY.map((p) => `':(exclude)${p}'`).join(' ');
const pathspec = paths.map((p) => `'${p}'`).join(' ');
const diff = sh(`git diff --binary ${onto} ${from} -- ${pathspec} ${excludes}`, {cwd, ...big});
if (diff === '') {
  console.log('EMPTY EXPORT');
  process.exit(0);
}

const tmp = mkdtempSync(join(tmpdir(), 'migration-export-'));
try {
  sh(`git worktree add --detach ${tmp} ${onto}`, {cwd});
  const patch = join(tmp, '.export.patch');
  writeFileSync(patch, diff + '\n');
  sh(`git apply --index --whitespace=nowarn ${patch}`, {cwd: tmp, ...big});
  rmSync(patch);
  sh(`git checkout -b ${out}`, {cwd: tmp});
  sh(`git commit -m ${JSON.stringify(message)}`, {cwd: tmp});
  console.log(sh(`git diff --stat ${onto} ${out}`, {cwd: tmp, ...big}));
  console.log(`EXPORTED ${out}`);
} finally {
  shOk(`git worktree remove --force ${tmp}`, {cwd});
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test scripts/migration/test/export.test.mjs`
Expected: PASS, 3 tests

- [ ] **Step 5: Run the whole machinery suite**

Run: `node --test scripts/migration/test/`
Expected: PASS, all tests from Tasks 1 through 6

- [ ] **Step 6: Commit**

```bash
git add scripts/migration/export.mjs scripts/migration/test/export.test.mjs
git commit -m "feat(migration-tooling): add machinery-free upstream export script

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Seed state files and amend the spec's ledger-only commit cases

**Files:**
- Create: `docs/migration/LEDGER.jsonl` (empty file)
- Create: `docs/migration/gates.json`
- Create: `docs/migration/ratchets.json`
- Create: `docs/migration/loop.json`
- Create: `docs/migration/PLAYBOOK.md`
- Modify: `docs/superpowers/specs/2026-07-14-agentic-migration-loop-design.md` (invariant 1)

**Interfaces:**
- Consumes: file formats defined in Tasks 3 through 5.
- Produces: the state files skills and scripts read; `loop.json` shape: `{"batchSize": 4, "fixAttempts": 2, "reviewer": "human", "sampleK": 3}`.

- [ ] **Step 1: Create the state files**

`docs/migration/LEDGER.jsonl`: create empty (zero bytes).

```json
// docs/migration/gates.json
{
  "rails-header": {"fast": ["node scripts/migration/rails-gate.mjs --check {paths}"]}
}
```

```json
// docs/migration/ratchets.json
[
  {"id": "rails-headers", "direction": "up",
   "command": "node scripts/migration/rails-gate.mjs --count docs/migration/rails lib/__rails_probe.js"}
]
```

```json
// docs/migration/loop.json
{"batchSize": 4, "fixAttempts": 2, "reviewer": "human", "sampleK": 3}
```

(JSON files must not contain the `//` filename comments above; those are plan annotations only.)

```markdown
<!-- docs/migration/PLAYBOOK.md -->
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
```

- [ ] **Step 2: Amend the spec's invariant 1**

In `docs/superpowers/specs/2026-07-14-agentic-migration-loop-design.md`, replace:

> Ledger-only commits are permitted for exactly two cases: status-only transitions (quarantine, unblock) and the batch skill's metadata backfill (`commit`, `batch` fields).

with:

> Ledger-only commits are permitted for exactly three cases: status-only transitions (quarantine, unblock), queue seeding (adding new `pending` units), and the batch skill's metadata backfill (`commit`, `batch` fields). Ledger-only commits use the `migrate-meta:` message prefix so they never match the `migrate(<type>):` convention.

- [ ] **Step 3: Sanity-run the CLIs against the seeded state**

Run: `node scripts/migration/ledger.mjs check`
Expected: `OK`
Run: `node scripts/migration/ledger.mjs stats`
Expected: empty status/type sections, `quarantined (0):`, a 7-day count line
Run: `node scripts/migration/verify.mjs --ratchets`
Expected: `{ "rails-headers": 0 }`

- [ ] **Step 4: Commit**

```bash
git add docs/migration docs/superpowers/specs/2026-07-14-agentic-migration-loop-design.md
git commit -m "feat(migration-tooling): seed migration state files and playbook

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: The two skills and optional CI workflow

**Files:**
- Create: `.claude/skills/migrate-next/SKILL.md`
- Create: `.claude/skills/migrate-batch/SKILL.md`
- Create: `.github/workflows/migration-ci.yml`

**Interfaces:**
- Consumes: every CLI surface from Tasks 3 through 5, state files from Task 7.
- Produces: the agent-facing protocol. No code; review each file against spec sections 6 and 8 before committing.

- [ ] **Step 1: Write `.claude/skills/migrate-next/SKILL.md`**

````markdown
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
   - `node scripts/migration/ledger.mjs update <id> --status done`
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
````

- [ ] **Step 2: Write `.claude/skills/migrate-batch/SKILL.md`**

````markdown
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
   - `node scripts/migration/verify.mjs --ratchets` next to the values in
     `docs/migration/RATCHET_BASELINE.json`
   - Quarantines from this batch with notes; any unit with `attempts` > 0 flagged "read first".
4. **PR (when pushing).** `git push origin migration/batch-NNN` then
   `gh pr create --base migration/main --head migration/batch-NNN --title "migration: batch-NNN (<n> units)"`
   with the report as body. Working purely locally: present the report instead.
5. **Human review gate.** STOP. Do not land without explicit approval in this conversation.
6. **Land.** From a `migration/main` checkout:
   `node scripts/migration/land.mjs --batch migration/batch-NNN`
   A refusal is final: report it verbatim, do not force, do not retry with modifications.
7. **Next branch.** `git checkout -b migration/batch-<NNN+1> migration/main`
````

- [ ] **Step 3: Write `.github/workflows/migration-ci.yml`**

```yaml
name: migration-ci
on:
  pull_request:
    branches: ['migration/main']
jobs:
  machinery:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: node --test scripts/migration/test/
      - run: node scripts/migration/ledger.mjs check
      - run: node scripts/migration/verify.mjs --ratchets
```

- [ ] **Step 4: Review against spec, then commit**

Check each skill against spec sections 6 and 8: seven protocol steps present, quarantine path present, infra-failure halt present, reviewer toggle present, land refusal is final, machinery paths forbidden. Then:

```bash
git add .claude/skills/migrate-next/SKILL.md .claude/skills/migrate-batch/SKILL.md .github/workflows/migration-ci.yml
git commit -m "feat(migration-tooling): add migrate-next and migrate-batch skills and optional CI

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 9: Bootstrap the `migration/*` namespace

**Files:**
- No file changes; branch and tag operations plus one `land.mjs --init` commit.

**Interfaces:**
- Consumes: everything built so far, committed on the current worktree branch.
- Produces: local `migration/main` branch containing all machinery, tag `migration-bootstrap`, committed `docs/migration/RATCHET_BASELINE.json`. Nothing is pushed; pushing `migration/*` to `origin` is the user's call (it is harmless to other fork users, but it is their fork).

- [ ] **Step 1: Create and check out the integration branch**

Run: `git checkout -b migration/main`
Expected: `Switched to a new branch 'migration/main'` (created at the tip of the machinery branch, which sits on fork main history)

- [ ] **Step 2: Initialize the ratchet baseline**

Run: `node scripts/migration/land.mjs --init`
Expected: `baseline initialized`; `git log --format=%s -n 1` prints `land: initialize ratchet baseline`; `git show HEAD:docs/migration/RATCHET_BASELINE.json` shows `rails-headers: 0`

- [ ] **Step 3: Tag the bootstrap point**

Run: `git tag migration-bootstrap && git status --porcelain`
Expected: no output from status (clean)

---

### Task 10: Rails test, the machine proven end to end

**Files:**
- Transient: rails units under `docs/migration/rails/` and `lib/__rails_probe.js`, all retired by the end of this task.

**Interfaces:**
- Consumes: the entire machine.
- Produces: confidence. Exercises pick ordering with deps, gate pass, gate fail to quarantine, meta commits, backfill, stats, land success, ledger-check refusal, ratchet refusal, dropped-ratchet path, export inclusion, and export emptiness. Ends with pristine state: empty ledger, empty manifest, no rails files.

- [ ] **Step 1: Start batch-000 and seed the rails queue**

```bash
git checkout -b migration/batch-000 migration/main
cat >> docs/migration/LEDGER.jsonl <<'EOF'
{"id":"rails:a","type":"rails-header","paths":["docs/migration/rails/a.txt"],"deps":[],"status":"pending","attempts":0,"batch":null,"commit":null,"note":null}
{"id":"rails:c","type":"rails-header","paths":["docs/migration/rails/c.txt"],"deps":["rails:b"],"status":"pending","attempts":0,"batch":null,"commit":null,"note":null}
{"id":"rails:b","type":"rails-header","paths":["docs/migration/rails/b.txt"],"deps":[],"status":"pending","attempts":0,"batch":null,"commit":null,"note":null}
{"id":"rails:probe","type":"rails-header","paths":["lib/__rails_probe.js"],"deps":[],"status":"pending","attempts":0,"batch":null,"commit":null,"note":null}
{"id":"rails:poison","type":"rails-header","paths":["docs/migration/rails/poison.txt"],"deps":[],"status":"pending","attempts":0,"batch":null,"commit":null,"note":null}
EOF
git add docs/migration/LEDGER.jsonl
git commit -m "migrate-meta: seed rails queue"
```

(rails:c is deliberately listed before rails:b to prove dependency ordering.)

- [ ] **Step 2: Convert rails:a, rails:b, rails:c in picked order**

For each round, run `node scripts/migration/ledger.mjs pick` and confirm the sequence a, then b (c is listed earlier but blocked), then c. For each picked unit `<id>` with path `<path>`:

```bash
printf '// migration-rails-header\nrails unit <id>\n' > <path>   # mkdir -p docs/migration/rails first
node scripts/migration/verify.mjs --unit <id>                     # expect: headers OK / PASS <id>
node scripts/migration/ledger.mjs update <id> --status done
git add <path> docs/migration/LEDGER.jsonl
git commit -m "migrate(rails-header): <id>"
```

Expected after three rounds: `git log --format=%s migration/main..HEAD | grep -c '^migrate('` prints `3`.

- [ ] **Step 3: Convert rails:probe the same way**

Same recipe with path `lib/__rails_probe.js`. Expected: batch progress `4`, which meets `batchSize`; in real operation migrate-next would now say "run /migrate-batch".

- [ ] **Step 4: Poison unit fails and is quarantined**

```bash
printf 'wrong content, no header\n' > docs/migration/rails/poison.txt
node scripts/migration/verify.mjs --unit rails:poison
```

Expected: FAIL (nonzero exit, `missing header`). Simulate the exhausted fix budget:

```bash
git checkout -- . && git clean -fd docs/migration/rails
node scripts/migration/ledger.mjs update rails:poison --status quarantined --attempts 2 --note "gate: header missing after 2 attempts"
git add docs/migration/LEDGER.jsonl
git commit -m "migrate-meta: quarantine rails:poison"
node scripts/migration/ledger.mjs check
```

Expected: `OK` (quarantined with zero migrate commits is consistent).

- [ ] **Step 5: Backfill and report**

```bash
node scripts/migration/ledger.mjs backfill    # expect: backfilled 4
git add docs/migration/LEDGER.jsonl && git commit -m "migrate-meta: backfill batch-000"
node scripts/migration/ledger.mjs stats
```

Expected stats: `done: 4`, `pending: 0`, `quarantined (1):` listing rails:poison with its note, `migrate commits last 7 days: 4`.

- [ ] **Step 6: Land batch-000**

```bash
git checkout migration/main
node scripts/migration/land.mjs --batch migration/batch-000
```

Expected: `LANDED migration/batch-000 (4 units)`; baseline now `{"rails-headers": 4}`.

- [ ] **Step 7: Negative test one, ledger check refuses a status/commit mismatch**

```bash
git checkout -b migration/batch-bad migration/main
git revert --no-edit $(git log --format=%H --grep '^migrate(rails-header): rails:b$' -n 1)
git checkout migration/main
node scripts/migration/land.mjs --batch migration/batch-bad
```

Expected: exit 1, `ledger check failed on merged tree; aborted` (rails:b is `done` but its net commit count in the merged tree is 0). Confirm `git status --porcelain` is empty and `git log --format=%s -n 1` is still the batch-000 land. Then `git branch -D migration/batch-bad`.

- [ ] **Step 8: Negative test two, ratchet refuses a silent regression**

```bash
git checkout -b migration/batch-bad2 migration/main
printf 'header removed\n' > docs/migration/rails/b.txt
git add docs/migration/rails/b.txt
git commit -m "migrate-meta: tamper with b"
git checkout migration/main
node scripts/migration/land.mjs --batch migration/batch-bad2
```

Expected: exit 1, `rails-headers: 4 -> 3 violates up`, merge aborted, `migration/main` unchanged and clean. Then `git branch -D migration/batch-bad2`.

- [ ] **Step 9: Export contains exactly the probe**

```bash
node scripts/migration/export.mjs --onto migration-bootstrap --out rails-export-check --message "rails export check"
git diff --name-only migration-bootstrap rails-export-check
```

Expected: `EXPORTED rails-export-check`; the diff lists exactly one file, `lib/__rails_probe.js`. The rails files under `docs/migration/rails/` and every machinery path are absent by denylist. Then `git branch -D rails-export-check`.

- [ ] **Step 10: Cleanup batch-001 retires rails and exercises the dropped-ratchet path**

```bash
git checkout -b migration/batch-001 migration/main
for id in rails:probe rails:c rails:b rails:a; do
  git revert --no-edit $(git log --format=%H --grep "^migrate(rails-header): $id\$" -n 1)
done
# retire the rails units and config; these are meta/machinery commits, kept separate
node --input-type=module - <<'EOF'
import {readFileSync, writeFileSync} from 'node:fs';
const keep = readFileSync('docs/migration/LEDGER.jsonl', 'utf8')
  .split('\n').filter((l) => l && !l.includes('"rails:'));
writeFileSync('docs/migration/LEDGER.jsonl', keep.length ? keep.join('\n') + '\n' : '');
EOF
git add docs/migration/LEDGER.jsonl
git commit -m "migrate-meta: retire rails units"
printf '[]\n' > docs/migration/ratchets.json
printf '{}\n' > docs/migration/gates.json
git add docs/migration/ratchets.json docs/migration/gates.json
git commit -m "feat(migration-tooling): remove rails gate and ratchet config

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
node scripts/migration/ledger.mjs check    # expect OK: reverts zero the nets, lines deleted
git checkout migration/main
node scripts/migration/land.mjs --batch migration/batch-001
```

Expected: land prints `note: ratchet dropped: rails-headers (baseline was 4)` and `LANDED migration/batch-001 (0 units)`; new baseline is `{}`.

- [ ] **Step 11: Final pristine-state assertions**

```bash
node scripts/migration/ledger.mjs check          # OK
node scripts/migration/verify.mjs --ratchets     # {}
ls docs/migration/rails lib/__rails_probe.js 2>&1  # both gone (No such file or directory)
node scripts/migration/export.mjs --onto migration-bootstrap --out post-cleanup-check
```

Expected: the export prints `EMPTY EXPORT` (product tree is back to identical with bootstrap), proving machinery-only history exports to nothing. The machine is validated; the loop is ready for a real unit type once `docs/migration/PLAN.md` defines one.

---

## Self-Review Notes

- Spec coverage: topology (Task 9), layout (Tasks 1-8), ledger and invariants (1, 3), inner-loop protocol (8), gates/ratchets/land (4, 5), batching/review (8), export (6), recovery surfaces (3: check, stats), rails test incl. negative paths and dropped-ratchet rule (10), spec invariant amendment (7). Outer-loop process (spec section 10) is human procedure encoded in the skills' stop points and `loop.json` toggles; no additional code is warranted.
- Deliberately deferred to `docs/migration/PLAN.md` work: real unit types, real gate commands, real ratchets (tsc errors, test counts, API surface golden), queue generation from the import graph, upstream PR chunking.
- Type consistency spot-checks: status strings, `migrate-meta:` prefix, `LANDED`/`EMPTY EXPORT`/`OK`/`EMPTY` sentinel outputs, and the `DENY` list are each defined once and used verbatim across tasks.
