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
