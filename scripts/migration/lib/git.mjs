import {sh} from './sh.mjs';

const MIGRATE_RE = /^migrate\(([a-z0-9-]+)\): (.+)$/;
const REVERT_RE = /^Revert "migrate\(([a-z0-9-]+)\): (.+)"$/;

export function migrateLog(cwd, ref = 'HEAD') {
  const out = sh(`git log --format=%H%x09%s ${ref}`, {cwd, maxBuffer: 64 * 1024 * 1024});
  const entries = [];
  if (!out) return entries;
  for (const line of out.split('\n')) {
    const tab = line.indexOf('\t');
    const sha = line.slice(0, tab);
    const subject = line.slice(tab + 1);
    let m;
    if ((m = subject.match(MIGRATE_RE))) {
      entries.push({sha, kind: 'migrate', type: m[1], unitId: m[2]});
    } else if ((m = subject.match(REVERT_RE))) {
      entries.push({sha, kind: 'revert', type: m[1], unitId: m[2]});
    }
  }
  return entries;
}

export function migrateNets(cwd, ref = 'HEAD') {
  const nets = new Map();
  for (const e of migrateLog(cwd, ref)) {
    nets.set(e.unitId, (nets.get(e.unitId) ?? 0) + (e.kind === 'migrate' ? 1 : -1));
  }
  return nets;
}

export function isClean(cwd) {
  return sh('git status --porcelain', {cwd}) === '';
}

export function currentBranch(cwd) {
  return sh('git rev-parse --abbrev-ref HEAD', {cwd});
}
