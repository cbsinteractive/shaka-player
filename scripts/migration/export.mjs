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
