import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseLedger, serializeLedger, pickNext, updateUnit, checkPure} from '../lib/ledger-core.mjs';

const U = (id, extra = {}) => JSON.stringify({
  id, type: 'rails-header', paths: [`docs/migration/rails/${id}.txt`],
  deps: [], status: 'pending', attempts: 0, batch: null, commit: null, note: null, ...extra,
});

test('parseLedger parses lines, skips blanks, round-trips', () => {
  const text = U('a') + '\n\n' + U('b') + '\n';
  const units = parseLedger(text);
  assert.equal(units.length, 2);
  assert.equal(serializeLedger(units), U('a') + '\n' + U('b') + '\n');
});

test('parseLedger rejects duplicate ids, bad JSON, bad status', () => {
  assert.throws(() => parseLedger(U('a') + '\n' + U('a') + '\n'), /duplicate id/);
  assert.throws(() => parseLedger('{oops\n'), /line 1: invalid JSON/);
  assert.throws(() => parseLedger(U('a', {status: 'wat'}) + '\n'), /invalid fields/);
  assert.throws(() => parseLedger('null\n'), /invalid fields/);
});

test('pickNext returns first pending whose deps are all done, in file order', () => {
  const units = parseLedger([
    U('a', {status: 'done'}),
    U('c', {deps: ['b']}),
    U('b'),
  ].join('\n') + '\n');
  assert.equal(pickNext(units).id, 'b'); // c is listed first but blocked on b
  const after = updateUnit(units, 'b', {status: 'done'});
  assert.equal(pickNext(after).id, 'c');
  assert.equal(pickNext(updateUnit(after, 'c', {status: 'done'})), null);
});

test('pickNext throws on unknown dep; updateUnit validates', () => {
  assert.throws(() => pickNext(parseLedger(U('a', {deps: ['ghost']}) + '\n')), /unknown dep/);
  const units = parseLedger(U('a') + '\n');
  assert.throws(() => updateUnit(units, 'ghost', {status: 'done'}), /unknown unit/);
  assert.throws(() => updateUnit(units, 'a', {status: 'wat'}), /invalid status/);
  assert.equal(units[0].status, 'pending'); // updateUnit does not mutate input
});

test('checkPure reports unknown deps and cycles', () => {
  const errs = checkPure(parseLedger([
    U('a', {deps: ['b']}),
    U('b', {deps: ['a']}),
    U('c', {deps: ['ghost']}),
  ].join('\n') + '\n'));
  assert.ok(errs.some((e) => e.includes('unknown dep ghost')));
  assert.ok(errs.some((e) => e.includes('dep cycle')));
});
