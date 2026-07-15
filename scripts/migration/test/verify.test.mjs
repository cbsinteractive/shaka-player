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
