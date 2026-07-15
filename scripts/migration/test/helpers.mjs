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
