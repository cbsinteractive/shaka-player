#!/usr/bin/env node
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
