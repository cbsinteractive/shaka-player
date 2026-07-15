#!/usr/bin/env node
import {readFileSync, readdirSync, statSync, existsSync} from 'node:fs';
import {join} from 'node:path';

const HEADER = '// migration-rails-header';
const hasHeader = (file) => readFileSync(file, 'utf8').split('\n')[0] === HEADER;

function walk(path, out) {
  if (!existsSync(path)) return;
  if (statSync(path).isFile()) {
    out.push(path);
    return;
  }
  for (const name of readdirSync(path)) walk(join(path, name), out);
}

const [mode, ...paths] = process.argv.slice(2);
if (mode === '--check') {
  const bad = paths.filter((p) => !existsSync(p) || !hasHeader(p));
  if (bad.length) {
    console.error(`missing header: ${bad.join(', ')}`);
    process.exit(1);
  }
  console.log('headers OK');
} else if (mode === '--count') {
  const files = [];
  for (const p of paths) walk(p, files);
  console.log(String(files.filter(hasHeader).length));
} else {
  console.error('usage: rails-gate.mjs --check <file...> | --count <path...>');
  process.exit(1);
}
