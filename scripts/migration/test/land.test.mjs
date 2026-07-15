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
