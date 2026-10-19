'use strict';
// Run: node --test test/
const test   = require('node:test');
const assert = require('node:assert');
const { seqPhragmen } = require('../src/npos');

const voters = [
  { id: 10, stake: 10, targets: [1, 2] },
  { id: 20, stake: 20, targets: [1, 3] },
  { id: 30, stake: 30, targets: [2, 3] },
];
const support = (r) => Object.fromEntries(r.winners.map(w => [w.id, Math.round(w.support * 1e6) / 1e6]));

test('seq-phragmen without balancing matches sp-npos-elections', () => {
  // sp-npos-elections `seq_phragmen_works`: winners (2, 25), (3, 35)
  const r = seqPhragmen([1, 2, 3], voters, 2, { balancingIterations: 0 });
  assert.deepStrictEqual(support(r), { 2: 25, 3: 35 });
});

test('balancing equalises supports', () => {
  const r = seqPhragmen([1, 2, 3], voters, 2, { balancingIterations: 10 });
  assert.deepStrictEqual(support(r), { 2: 30, 3: 30 });
  const b = r.backers(2).find(x => x.voter === 30);
  assert.strictEqual(Math.round(b.weight), 20);
});

test('full budget counts for every target (approval), not budget / targets', () => {
  const r = seqPhragmen(['A', 'B'], [{ id: 1, stake: 100, targets: ['A', 'B'] }], 2, { balancingIterations: 0 });
  assert.strictEqual(r.approval('A'), 100);
  assert.strictEqual(r.approval('B'), 100);
});

test('ignores unknown targets, zero stake and duplicates', () => {
  const r = seqPhragmen(['A'], [
    { id: 1, stake: 0,  targets: ['A'] },
    { id: 2, stake: 50, targets: ['A', 'A', 'X'] },
  ], 1);
  assert.deepStrictEqual(support(r), { A: 50 });
});
