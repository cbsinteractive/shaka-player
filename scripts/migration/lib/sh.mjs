import {execSync} from 'node:child_process';

export function sh(cmd, opts = {}) {
  return execSync(cmd, {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts}).trim();
}

export function shOk(cmd, opts = {}) {
  try {
    sh(cmd, opts);
    return true;
  } catch {
    return false;
  }
}
