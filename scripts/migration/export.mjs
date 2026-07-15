#!/usr/bin/env node
// scripts/migration/export.mjs
import {mkdtempSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execSync} from 'node:child_process';
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
const FLAG_NAMES = new Set(['--from', '--onto', '--out', '--message', '--paths']);
const pathsIdx = args.indexOf('--paths');
let paths = ['.'];
if (pathsIdx !== -1) {
  paths = [];
  for (let i = pathsIdx + 1; i < args.length && !FLAG_NAMES.has(args[i]); i++) {
    paths.push(args[i]);
  }
  if (paths.length === 0) {
    console.error('--paths requires at least one path');
    process.exit(1);
  }
}

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
const diff = execSync(`git diff --binary ${onto} ${from} -- ${pathspec} ${excludes}`,
    {cwd, ...big});
if (diff.length === 0) {
  console.log('EMPTY EXPORT');
  process.exit(0);
}

const tmp = mkdtempSync(join(tmpdir(), 'migration-export-'));
try {
  sh(`git worktree add --detach ${tmp} ${onto}`, {cwd});
  const patch = join(tmp, '.export.patch');
  writeFileSync(patch, diff);
  sh(`git apply --index --whitespace=nowarn ${patch}`, {cwd: tmp, ...big});
  rmSync(patch);
  sh(`git checkout -b ${out}`, {cwd: tmp});
  sh(`git commit -m ${JSON.stringify(message)}`, {cwd: tmp});
  console.log(sh(`git diff --stat ${onto} ${out}`, {cwd: tmp, ...big}));
  console.log(`EXPORTED ${out}`);
} finally {
  shOk(`git worktree remove --force ${tmp}`, {cwd});
}
