'use strict';
const test   = require('node:test');
const assert = require('node:assert');
const Notifier = require('../src/notifier');

const base = {
  era: 10, plannedEra: 11, sessionIdx: 60, maxSlots: 600, candidates: 700,
  isActive: true, eraTotal: 1_600_000, eraRank: 150, eraBuffer: 290_000, eraCluster: 180,
  myAnchors: [{ addr: '1ayYF5ZUK8D28DtDMEf88HWSdzU9de2vddVSczjuPLJdejt', budget: 300_000, targets: 4, effective: 300_000, exclusive: false }],
  exclusiveCount: 0, exclusiveTotal: 0, elapsed: '5.0',
};

test('formatRank: on-chain next era + forecast', () => {
  const r = { ...base,
    next:     { source: 'chain', era: 11, rank: 154, stake: 1_599_754, buffer: 290_653, cluster: 186, marginal: 1_309_101, total: 600 },
    forecast: { source: 'simulation', era: 12, rank: 106, stake: 1_599_846, buffer: 290_508, cluster: 184, marginal: 1_309_338, total: 600, nominators: 21783, avgTargets: 9 },
  };
  const [msg] = Notifier.formatRank(r, 'X', 'DOT', { topN: 5 });
  assert.match(msg, /Next era — era 11/);
  assert.match(msg, /on-chain result/);
  assert.match(msg, /Forecast — era 12/);
  assert.match(msg, /22\.2% above last/);
  assert.match(msg, /Comfortable/);
  assert.ok(msg.length < 4000);
});

test('formatRank: not elected shows shortfall and danger levels by buffer %', () => {
  const r = { ...base, isActive: false, forecast: null,
    next: { source: 'snapshot', era: 11, rank: null, stake: 1_200_000, buffer: null, marginal: 1_300_000, total: 600, waitRank: 3 } };
  const [msg] = Notifier.formatRank(r, 'X', 'DOT');
  assert.match(msg, /NOT ELECTED/);
  assert.match(msg, /waiting #3/);
  assert.match(msg, /≈100,000 DOT/);

  const tight = { ...base, forecast: null,
    next: { source: 'chain', era: 11, rank: 590, stake: 1_330_000, buffer: 30_000, cluster: 0, marginal: 1_300_000, total: 600 } };
  assert.match(Notifier.formatRank(tight, 'X', 'DOT')[0], /DANGER ZONE/);
});
