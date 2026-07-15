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
