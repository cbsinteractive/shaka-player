#!/usr/bin/env node
// scripts/migration/ledger.mjs
import {readFileSync, writeFileSync} from 'node:fs';
import {parseLedger, serializeLedger, pickNext, updateUnit, checkPure} from './lib/ledger-core.mjs';
import {migrateLog, migrateNets} from './lib/git.mjs';
import {sh} from './lib/sh.mjs';

const LEDGER = 'docs/migration/LEDGER.jsonl';
const load = () => parseLedger(readFileSync(LEDGER, 'utf8'));
const save = (units) => writeFileSync(LEDGER, serializeLedger(units));

const [cmd, ...args] = process.argv.slice(2);

function parseFlags(list) {
  const flags = {};
  for (let i = 0; i < list.length; i += 2) {
    if (!list[i].startsWith('--') || list[i + 1] === undefined) {
      throw new Error(`bad flag pair near ${list[i]}`);
    }
    flags[list[i].slice(2)] = list[i + 1];
  }
  return flags;
}

switch (cmd) {
  case 'pick': {
    const u = pickNext(load());
    if (!u) {
      console.log('EMPTY');
      process.exit(2);
    }
    console.log(JSON.stringify(u));
    break;
  }
  case 'update': {
    const id = args[0];
    const flags = parseFlags(args.slice(1));
    const patch = {};
    if (flags.status !== undefined) patch.status = flags.status;
    if (flags.note !== undefined) patch.note = flags.note;
    if (flags.batch !== undefined) patch.batch = flags.batch;
    if (flags.commit !== undefined) patch.commit = flags.commit;
    if (flags.attempts !== undefined) patch.attempts = Number(flags.attempts);
    save(updateUnit(load(), id, patch));
    console.log(`updated ${id}`);
    break;
  }
  case 'check': {
    const flags = parseFlags(args);
    const ref = flags.ref ?? 'HEAD';
    const units = load();
    const errors = checkPure(units);
    const nets = migrateNets(process.cwd(), ref);
    const byId = new Map(units.map((u) => [u.id, u]));
    for (const u of units) {
      const net = nets.get(u.id) ?? 0;
      if (u.status === 'done' && net !== 1) {
        errors.push(`${u.id}: done but ${net} net migrate commits`);
      }
      if (u.status !== 'done' && net !== 0) {
        errors.push(`${u.id}: ${u.status} but ${net} net migrate commits`);
      }
    }
    for (const [id, net] of nets) {
      if (!byId.has(id) && net !== 0) errors.push(`commit references unknown unit ${id}`);
    }
    if (errors.length) {
      for (const e of errors) console.error(e);
      process.exit(1);
    }
    console.log('OK');
    break;
  }
  case 'backfill': {
    let units = load();
    const newestShaFor = new Map();
    for (const e of migrateLog(process.cwd())) {
      if (e.kind === 'migrate' && !newestShaFor.has(e.unitId)) newestShaFor.set(e.unitId, e.sha);
    }
    let filled = 0;
    for (const u of units) {
      if (u.status === 'done' && !u.commit && newestShaFor.has(u.id)) {
        units = updateUnit(units, u.id, {commit: newestShaFor.get(u.id)});
        filled++;
      }
    }
    save(units);
    console.log(`backfilled ${filled}`);
    break;
  }
  case 'stats': {
    const units = load();
    const count = (fn) => units.reduce((m, u) => {
      const k = fn(u);
      m.set(k, (m.get(k) ?? 0) + 1);
      return m;
    }, new Map());
    console.log('by status:');
    for (const [k, v] of count((u) => u.status)) console.log(`  ${k}: ${v}`);
    console.log('by type:');
    for (const [k, v] of count((u) => u.type)) console.log(`  ${k}: ${v}`);
    const q = units.filter((u) => u.status === 'quarantined');
    console.log(`quarantined (${q.length}):`);
    for (const u of q) console.log(`  ${u.id}: ${u.note ?? '(no note)'}`);
    const week = sh('git log --format=%s --since=7.days HEAD', {cwd: process.cwd()})
        .split('\n').filter((s) => /^migrate\(/.test(s)).length;
    console.log(`migrate commits last 7 days: ${week}`);
    break;
  }
  default:
    console.error('usage: ledger.mjs pick|update|check|backfill|stats');
    process.exit(1);
}
