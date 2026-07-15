const STATUSES = new Set(['pending', 'in_progress', 'done', 'quarantined', 'blocked']);

export function parseLedger(text) {
  const units = [];
  const seen = new Set();
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    let unit;
    try {
      unit = JSON.parse(line);
    } catch {
      throw new Error(`LEDGER line ${i + 1}: invalid JSON`);
    }
    if (typeof unit !== 'object' || unit === null || Array.isArray(unit) ||
        !unit.id || !unit.type || !Array.isArray(unit.paths) ||
        !Array.isArray(unit.deps) || !STATUSES.has(unit.status)) {
      throw new Error(`LEDGER line ${i + 1}: missing or invalid fields`);
    }
    if (seen.has(unit.id)) throw new Error(`LEDGER line ${i + 1}: duplicate id ${unit.id}`);
    seen.add(unit.id);
    units.push(unit);
  }
  return units;
}

export function serializeLedger(units) {
  return units.map((u) => JSON.stringify(u)).join('\n') + '\n';
}

export function pickNext(units) {
  const byId = new Map(units.map((u) => [u.id, u]));
  for (const u of units) {
    if (u.status !== 'pending') continue;
    for (const d of u.deps) {
      if (!byId.has(d)) throw new Error(`unit ${u.id}: unknown dep ${d}`);
    }
    if (u.deps.every((d) => byId.get(d).status === 'done')) return u;
  }
  return null;
}

export function updateUnit(units, id, patch) {
  const i = units.findIndex((u) => u.id === id);
  if (i === -1) throw new Error(`unknown unit ${id}`);
  if (patch.status !== undefined && !STATUSES.has(patch.status)) {
    throw new Error(`invalid status ${patch.status}`);
  }
  const next = units.slice();
  next[i] = {...units[i], ...patch};
  return next;
}

export function checkPure(units) {
  const errors = [];
  const byId = new Map(units.map((u) => [u.id, u]));
  for (const u of units) {
    for (const d of u.deps) {
      if (!byId.has(d)) errors.push(`${u.id}: unknown dep ${d}`);
    }
  }
  const color = new Map();
  const visit = (id, stack) => {
    color.set(id, 'gray');
    for (const d of byId.get(id)?.deps ?? []) {
      if (!byId.has(d)) continue;
      if (color.get(d) === 'gray') {
        errors.push(`dep cycle: ${[...stack, d].join(' -> ')}`);
        continue;
      }
      if (!color.has(d)) visit(d, [...stack, d]);
    }
    color.set(id, 'black');
  };
  for (const u of units) {
    if (!color.has(u.id)) visit(u.id, [u.id]);
  }
  return errors;
}
