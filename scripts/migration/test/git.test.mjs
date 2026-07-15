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
