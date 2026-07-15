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
    let ok;
    if (r.direction === 'eq') {
      ok = String(cur) === String(base);
    } else if (typeof cur !== 'number' || typeof base !== 'number') {
      failures.push(`${r.id}: non-numeric value for direction ${r.direction} (${base} -> ${cur})`);
      continue;
    } else {
      ok = r.direction === 'up' ? cur >= base : cur <= base;
    }
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
  const ratchets = () => JSON.parse(sh(`node ${VERIFY} --ratchets`, {cwd, maxBuffer: 64 * 1024 * 1024}));

  if (mode === '--compare') {
    if (!existsSync(BASELINE)) die('no baseline; run land.mjs --init first');
    const baseline = JSON.parse(readFileSync(BASELINE, 'utf8'));
    const manifest = JSON.parse(readFileSync(RATCHETS, 'utf8'));
    const current = ratchets();
    const {failures, notes} = compare(baseline, current, manifest);
    for (const n of notes) console.log(`note: ${n}`);
    console.log(JSON.stringify(current, null, 2));
    if (failures.length) die(failures.join('\n'));
    console.log('RATCHETS OK vs baseline');
    return;
  }

  if (currentBranch(cwd) !== 'migration/main') die('must run on migration/main');
  if (!isClean(cwd)) die('working tree must be clean');

  if (mode === '--init') {
    writeFileSync(BASELINE, JSON.stringify(ratchets(), null, 2) + '\n');
    sh(`git add ${BASELINE}`, {cwd});
    sh('git commit -m "land: initialize ratchet baseline"', {cwd});
    console.log('baseline initialized');
    return;
  }
  if (mode !== '--batch' || !branch) die('usage: land.mjs --init | --batch <branch> | --compare');
  if (!existsSync(BASELINE)) die('no baseline; run land.mjs --init first');

  if (!shOk(`git merge --no-ff --no-commit ${branch}`, {cwd})) {
    shOk('git merge --abort', {cwd});
    die(`merge conflict merging ${branch}; aborted`);
  }
  const abort = (msg) => {
    shOk('git merge --abort', {cwd});
    die(msg);
  };
  try {
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
  } catch (e) {
    shOk('git merge --abort', {cwd});
    die(`land failed mid-merge: ${e.message}; merge aborted`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
