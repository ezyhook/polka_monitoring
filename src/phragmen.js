'use strict';

/**
 * Phragmén-based slot position analysis module.
 * Computes predicted NPoS rank for a validator using Sequential Phragmén + Balancing.
 * Designed to run periodically (4x/day) and on /rank command.
 */

const fs   = require('fs');
const path = require('path');

// Three-tier cache:
//   STRUCTURE — nominators.entries() (who nominates whom) — 23h TTL, ~1 min to fetch
//   LEDGERS   — ledger.active for all nominators           — 1h TTL,  ~30s to fetch
//   SELF      — self-stake for all candidates              — 1h TTL,  ~5s to fetch
const STRUCTURE_CACHE_FILE = path.join(__dirname, '..', '.nominators-structure.json');
const LEDGERS_CACHE_FILE   = path.join(__dirname, '..', '.nominators-ledgers.json');
const SELF_CACHE_FILE      = path.join(__dirname, '..', '.nominators-self.json');
const STRUCTURE_TTL =  1 * 60 * 60 * 1000;  // 23h
const LEDGERS_TTL   =  1 * 60 * 60 * 1000;  //  1h
const SELF_TTL      =  1 * 60 * 60 * 1000;  //  1h
const BATCH_SIZE = 20;
const DECIMALS   = 10;
const PLANCK     = BigInt(10 ** DECIMALS);

// ── Helpers ───────────────────────────────────────────────────────────────────

function toFloat(planckVal) {
  return Number(BigInt(planckVal.toString())) / Number(PLANCK);
}

function fmt(dot) {
  return dot.toLocaleString('en', { maximumFractionDigits: 0 }) + ' DOT';
}

async function getLedgerActive(api, addr) {
  try {
    let ledger = await api.query.staking.ledger(addr);
    if (ledger.isNone) {
      const bonded = await api.query.staking.bonded(addr);
      if (bonded.isSome) ledger = await api.query.staking.ledger(bonded.unwrap());
    }
    if (ledger.isSome) return BigInt(ledger.unwrap().active.toString());
  } catch (_) {}
  return 0n;
}

async function batchGetLedgers(api, addrs) {
  const result = new Map();
  for (let i = 0; i < addrs.length; i += BATCH_SIZE) {
    const batch  = addrs.slice(i, i + BATCH_SIZE);
    const values = await Promise.all(batch.map(addr => getLedgerActive(api, addr)));
    batch.forEach((addr, j) => result.set(addr, values[j]));
  }
  return result;
}

// ── Cache ─────────────────────────────────────────────────────────────────────

// ── Cache helpers ────────────────────────────────────────────────────────────

function readCache(file, ttl) {
  try {
    if (!fs.existsSync(file)) return null;
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const age = Date.now() - raw.savedAt;
    if (age > ttl) return null;
    return { data: raw.data, age };
  } catch (_) { return null; }
}

function writeCache(file, data) {
  try {
    fs.writeFileSync(file, JSON.stringify({ data, savedAt: Date.now() }));
  } catch (e) { console.error('[Phragmen] Cache write error:', e.message); }
}

function loadStructureCache() {
  const c = readCache(STRUCTURE_CACHE_FILE, STRUCTURE_TTL);
  if (c) console.log(`[Phragmen] Structure cache: ${Math.round(c.age / 60_000)}m old, ${c.data.length} nominators`);
  return c ? c.data : null;
}

function saveStructureCache(nominators) {
  writeCache(STRUCTURE_CACHE_FILE, nominators);
  console.log(`[Phragmen] Structure cache saved: ${nominators.length} nominators`);
}

function loadLedgersCache() {
  const c = readCache(LEDGERS_CACHE_FILE, LEDGERS_TTL);
  if (c) console.log(`[Phragmen] Ledger cache: ${Math.round(c.age / 60_000)}m old, ${c.data.length} entries`);
  return c ? new Map(c.data.map(([k, v]) => [k, BigInt(v)])) : null;
}

function saveLedgersCache(ledgerMap) {
  // Only save non-zero entries — zeros are likely RPC failures, not real zero balances
  const entries = [...ledgerMap.entries()].filter(([, v]) => v > 0n).map(([k, v]) => [k, v.toString()]);
  writeCache(LEDGERS_CACHE_FILE, entries);
  const zeroCount = ledgerMap.size - entries.length;
  console.log(`[Phragmen] Ledger cache saved: ${entries.length} entries${zeroCount > 0 ? ` (skipped ${zeroCount} zeros)` : ''}`);
}

function loadSelfCache(candidates) {
  const c = readCache(SELF_CACHE_FILE, SELF_TTL);
  if (!c) return null;
  // Only valid if it covers all current candidates
  const cached = new Map(c.data.map(([k, v]) => [k, BigInt(v)]));
  const missing = candidates.filter(a => !cached.has(a));
  if (missing.length > candidates.length * 0.1) return null; // >10% missing — refresh
  if (c) console.log(`[Phragmen] Self-stake cache: ${Math.round(c.age / 60_000)}m old`);
  return { map: cached, missing };
}

function saveSelfCache(selfMap) {
  writeCache(SELF_CACHE_FILE, [...selfMap.entries()].map(([k, v]) => [k, v.toString()]));
  console.log(`[Phragmen] Self-stake cache saved: ${selfMap.size} entries`);
}

function clearCache() {
  for (const f of [STRUCTURE_CACHE_FILE, LEDGERS_CACHE_FILE, SELF_CACHE_FILE]) {
    try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch (_) {}
  }
  console.log('[Phragmen] All caches cleared');
}

// ── Sequential Phragmén + Balancing ──────────────────────────────────────────

function runPhragmen(candidates, nominatorVotes, selfStakes, maxSlots) {
  const loads         = new Map();
  const selected      = [];
  const remaining     = new Set(candidates);
  const nomToValidators = new Map();

  for (const [validator, votes] of nominatorVotes) {
    for (const { nomAddr, budget, effectiveBudget } of votes) {
      if (!loads.has(nomAddr)) loads.set(nomAddr, 0);
      if (!nomToValidators.has(nomAddr)) nomToValidators.set(nomAddr, []);
      nomToValidators.get(nomAddr).push({ validator, budget, effectiveBudget });
    }
  }

  const limit = Math.min(maxSlots, candidates.length);

  // Phase 1: Sequential Phragmén
  for (let round = 0; round < limit; round++) {
    let best = null, bestScore = -Infinity;
    for (const v of remaining) {
      let score = selfStakes.get(v) || 0;
      for (const { nomAddr, effectiveBudget } of (nominatorVotes.get(v) || [])) {
        if (effectiveBudget <= 0) continue;
        score += effectiveBudget / (1 + (loads.get(nomAddr) || 0));
      }
      if (score > bestScore) { bestScore = score; best = v; }
    }
    if (!best) break;

    selected.push({ address: best, stake: bestScore });
    remaining.delete(best);

    const loadInc = bestScore > 0 ? 1 / bestScore : 0;
    for (const { nomAddr } of (nominatorVotes.get(best) || [])) {
      loads.set(nomAddr, (loads.get(nomAddr) || 0) + loadInc);
    }
  }

  const selectedSet = new Set(selected.map(v => v.address));

  // Phase 2: Balancing with damping
  const support = new Map();
  for (const addr of selectedSet) {
    let s = selfStakes.get(addr) || 0;
    for (const { effectiveBudget } of (nominatorVotes.get(addr) || [])) s += effectiveBudget;
    support.set(addr, s || 1);
  }

  const MAX_ITER   = 200;
  const DAMPING    = 0.5;
  const CONVERGENCE = 0.0001;

  for (let iter = 0; iter < MAX_ITER; iter++) {
    const newSupport = new Map();
    for (const addr of selectedSet) newSupport.set(addr, selfStakes.get(addr) || 0);

    for (const [, targets] of nomToValidators) {
      const elected = targets.filter(t => selectedSet.has(t.validator));
      if (elected.length === 0) continue;
      const budget  = elected[0].budget;
      const weights = elected.map(t => ({ validator: t.validator, w: 1 / (support.get(t.validator) || 1) }));
      const totalW  = weights.reduce((s, w) => s + w.w, 0);
      if (totalW === 0) continue;
      for (const { validator, w } of weights) {
        newSupport.set(validator, (newSupport.get(validator) || 0) + budget * (w / totalW));
      }
    }

    let maxChange = 0;
    for (const [addr, newVal] of newSupport) {
      const oldVal  = support.get(addr) || 0;
      const blended = oldVal * DAMPING + newVal * (1 - DAMPING);
      if (oldVal > 0) maxChange = Math.max(maxChange, Math.abs(blended - oldVal) / oldVal);
      support.set(addr, blended);
    }

    if (maxChange < CONVERGENCE) break;
  }

  const activeSet = selected
    .map(v => ({ address: v.address, stake: support.get(v.address) || 0 }))
    .sort((a, b) => b.stake - a.stake);

  const waitingList = [...remaining]
    .map(v => {
      let score = selfStakes.get(v) || 0;
      for (const { budget } of (nominatorVotes.get(v) || [])) score += budget;
      return { address: v, stake: score };
    })
    .sort((a, b) => b.stake - a.stake);

  return { activeSet, waitingList, selectedSet };
}

// ── Main analysis function ────────────────────────────────────────────────────

/**
 * Run full Phragmén analysis for a validator.
 * @param {object} api               - Polkadot.js ApiPromise (Asset Hub)
 * @param {string} validatorAddress  - SS58 stash address
 * @param {boolean} forceRefresh     - Ignore cache and fetch fresh data
 * @returns {object} analysis result
 */
async function analyzeSlotPosition(api, validatorAddress, forceRefresh = false) {
  console.log('[Phragmen] Starting analysis…');
  const startTime = Date.now();

  // Current on-chain status
  const eraOpt     = await api.query.staking.currentEra();
  const era        = eraOpt.unwrap().toNumber();
  const sessionIdx = (await api.query.session.currentIndex()).toNumber();
  const maxSlots          = (await api.query.staking.validatorCount()).toNumber();
  // minActiveBond — try multiple locations (moved after AHM)
  let minActiveBond = 0;
  try {
    const raw = await api.query.staking.minimumActiveStake();
    minActiveBond = toFloat(BigInt(raw.toString()));
  } catch (_) {
    try {
      const raw = await api.query.staking.minNominatorBond();
      minActiveBond = toFloat(BigInt(raw.toString()));
    } catch (_2) {
      console.log('[Phragmen] minActiveBond not available — using 0 (no filter)');
    }
  }
  const maxElectingVoters = api.consts.staking.maxElectingVoters?.toNumber() || 22500;
  const maxNomRewarded    = api.consts.staking.maxNominatorRewardedPerValidator?.toNumber() || 512;
  console.log(`[Phragmen] minActiveBond: ${minActiveBond.toFixed(2)} DOT, maxElectingVoters: ${maxElectingVoters}, maxNomRewarded: ${maxNomRewarded}`);

  // Current active status
  let isActive = false, eraTotal = 0n, eraRank = null, eraBuffer = 0n;
  try {
    let allExposures = [];
    if (typeof api.query.staking.erasStakersOverview?.entries === 'function') {
      const ov = await api.query.staking.erasStakersOverview(era, validatorAddress).catch(() => null);
      if (ov && !ov.isNone) {
        isActive = true;
        eraTotal = BigInt(ov.unwrap().total.toString());
      }
      allExposures = await api.query.staking.erasStakersOverview.entries(era).catch(() => []);
    } else if (typeof api.query.staking.erasStakers?.entries === 'function') {
      const exp = await api.query.staking.erasStakers(era, validatorAddress).catch(() => null);
      if (exp && !exp.total.isZero()) {
        isActive = true;
        eraTotal = BigInt(exp.total.toString());
      }
      allExposures = await api.query.staking.erasStakers.entries(era).catch(() => []);
    }

    if (isActive && allExposures.length > 0) {
      const sorted = allExposures
        .map(([key, val]) => {
          const v = val.unwrap ? val.unwrap() : val;
          return { addr: key.args[key.args.length - 1].toString(), total: BigInt(v.total.toString()) };
        })
        .sort((a, b) => (b.total > a.total ? 1 : -1));
      const idx  = sorted.findIndex(v => v.addr === validatorAddress);
      eraRank    = idx >= 0 ? idx + 1 : null;
      eraBuffer  = eraTotal - sorted[sorted.length - 1].total;
    }
  } catch (e) {
    console.error('[Phragmen] Era status error:', e.message);
  }

  // Candidates
  const validatorEntries = await api.query.staking.validators.entries();
  const candidates       = validatorEntries.map(([key]) => key.args[0].toString());
  const candidateSet     = new Set(candidates);

  // ── Tier 1: Nominator structure — 23h cache ──────────────────────────────────
  let validNominators;
  const structureData = forceRefresh ? null : loadStructureCache();
  if (structureData) {
    validNominators = structureData
      .map(n => ({ addr: n.addr, targets: n.targets.filter(t => candidateSet.has(t)) }))
      .filter(n => n.targets.length > 0);
  } else {
    console.log('[Phragmen] Fetching nominator structure (~1 min)…');
    const nominatorEntries = await api.query.staking.nominators.entries();
    validNominators = nominatorEntries
      .filter(([, v]) => !v.isNone)
      .map(([key, v]) => ({
        addr:    key.args[0].toString(),
        targets: v.unwrap().targets.map(t => t.toString()).filter(t => candidateSet.has(t)),
      }))
      .filter(n => n.targets.length > 0);
    saveStructureCache(validNominators);
  }

  // ── Tier 2: Ledger balances — 1h cache ───────────────────────────────────────
  let ledgerMap = forceRefresh ? null : loadLedgersCache();
  if (!ledgerMap) {
    console.log(`[Phragmen] Fetching ledger balances for ${validNominators.length} nominators…`);
    ledgerMap = await batchGetLedgers(api, validNominators.map(n => n.addr));
    saveLedgersCache(ledgerMap);
  } else {
    // Fetch balances for any nominators not in cache
    const allAddrs = validNominators.map(n => n.addr);
    const missing  = allAddrs.filter(a => !ledgerMap.has(a));
    // Also check for zero-balance entries that may be stale
    const zeroCount = allAddrs.filter(a => (ledgerMap.get(a) || 0n) === 0n).length;
    if (missing.length > 0) {
      console.log(`[Phragmen] Fetching ${missing.length} missing ledger entries…`);
      const newEntries = await batchGetLedgers(api, missing);
      for (const [k, v] of newEntries) ledgerMap.set(k, v);
    }
    if (zeroCount > allAddrs.length * 0.05) {
      // >5% zeros suggests stale/corrupt cache — refresh
      console.warn(`[Phragmen] ${zeroCount} zero-balance entries detected — refreshing ledger cache…`);
      ledgerMap = await batchGetLedgers(api, allAddrs);
      saveLedgersCache(ledgerMap);
    }
  }

  // ── Tier 3: Self-stakes — 1h cache ───────────────────────────────────────────
  let selfStakesRaw;
  const selfCached = forceRefresh ? null : loadSelfCache(candidates);
  if (selfCached) {
    selfStakesRaw = selfCached.map;
    if (selfCached.missing.length > 0) {
      console.log(`[Phragmen] Fetching ${selfCached.missing.length} new candidate self-stakes…`);
      const newStakes = await batchGetLedgers(api, selfCached.missing);
      for (const [k, v] of newStakes) selfStakesRaw.set(k, v);
    }
  } else {
    console.log(`[Phragmen] Fetching self-stakes for ${candidates.length} candidates…`);
    selfStakesRaw = await batchGetLedgers(api, candidates);
    saveSelfCache(selfStakesRaw);
  }

  // Build vote graph with three on-chain filters:
  // 1. Min Active Bond — discard nominators below the dynamic threshold
  // 2. MaxElectingVoters (Bags-List cap) — keep only top N by stake
  // 3. MaxNominatorRewardedPerValidator — cap per-validator nominator list to top 512

  // Filter 1: Min Active Bond
  let filteredNominators = validNominators
    .map(n => ({ ...n, budget: toFloat(ledgerMap.get(n.addr) || 0n) }))
    .filter(n => n.budget >= minActiveBond && n.budget > 0);
  console.log(`[Phragmen] After minActiveBond filter: ${filteredNominators.length} (removed ${validNominators.length - filteredNominators.length})`);

  // Filter 2: Bags-List cap — sort by stake descending, keep top maxElectingVoters
  filteredNominators.sort((a, b) => b.budget - a.budget);
  filteredNominators = filteredNominators.slice(0, maxElectingVoters);
  console.log(`[Phragmen] After Bags-List cap (${maxElectingVoters}): ${filteredNominators.length}`);

  const nominatorVotes = new Map();
  candidates.forEach(c => nominatorVotes.set(c, []));

  let totalTargets = 0;
  for (const { addr, targets, budget } of filteredNominators) {
    const effectiveBudget = budget / targets.length;
    totalTargets += targets.length;
    for (const target of targets) {
      nominatorVotes.get(target)?.push({ nomAddr: addr, budget, effectiveBudget, targetCount: targets.length });
    }
  }

  // Filter 3: MaxNominatorRewardedPerValidator — cap per-validator to top 512 by effectiveBudget
  for (const [validator, votes] of nominatorVotes.entries()) {
    if (votes.length > maxNomRewarded) {
      votes.sort((a, b) => b.effectiveBudget - a.effectiveBudget);
      nominatorVotes.set(validator, votes.slice(0, maxNomRewarded));
    }
  }
  console.log(`[Phragmen] MaxNomRewarded cap applied (${maxNomRewarded} per validator)`);

  const avgTargets = filteredNominators.length > 0 ? totalTargets / filteredNominators.length : 1;

  // Self-stakes as float
  const selfStakes = new Map();
  for (const [addr, planck] of selfStakesRaw) selfStakes.set(addr, toFloat(planck));

  // Run simulation
  console.log(`[Phragmen] Running simulation (${candidates.length} candidates, ${validNominators.length} nominators)…`);
  const { activeSet, waitingList, selectedSet } = runPhragmen(candidates, nominatorVotes, selfStakes, maxSlots);

  // Our rank
  const activeIdx = activeSet.findIndex(v => v.address === validatorAddress);
  const waitIdx   = waitingList.findIndex(v => v.address === validatorAddress);
  const marginal  = activeSet[activeSet.length - 1];
  const predicted = activeIdx >= 0 ? activeSet[activeIdx] : (waitIdx >= 0 ? waitingList[waitIdx] : null);
  const predRank  = activeIdx >= 0 ? activeIdx + 1 : null;
  const predBuffer = activeIdx >= 0 ? (predicted?.stake || 0) - (marginal?.stake || 0) : null;

  // Anchor nominators for our validator
  const allMyVotes = (nominatorVotes.get(validatorAddress) || [])
    .sort((a, b) => b.effectiveBudget - a.effectiveBudget)
    .map(n => ({
      addr:      n.nomAddr,
      budget:    n.budget,
      targets:   n.targetCount,
      effective: n.effectiveBudget,
      exclusive: n.targetCount === 1,
    }));

  // Exclusive nominators summary (targets === 1, full budget goes only to us)
  const exclusiveNoms  = allMyVotes.filter(n => n.exclusive);
  const exclusiveCount = exclusiveNoms.length;
  const exclusiveTotal = exclusiveNoms.reduce((s, n) => s + n.budget, 0);

  const myVotes = allMyVotes.slice(0, 10);



  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`[Phragmen] Done in ${elapsed}s. Predicted rank: ${predRank ? '#' + predRank + '/' + activeSet.length : 'waiting'}`);

  return {
    era, sessionIdx, maxSlots,
    isActive, eraTotal: toFloat(eraTotal), eraRank, eraBuffer: toFloat(eraBuffer),
    candidates: candidates.length,
    nominators: validNominators.length,
    avgTargets,
    predRank, predBuffer, predStake: predicted?.stake || 0,
    marginalStake: marginal?.stake || 0,
    totalActive: activeSet.length,
    waitRank: waitIdx >= 0 ? waitIdx + 1 : null,
    myAnchors: myVotes,
    exclusiveCount,
    exclusiveTotal,

    elapsed,
  };
}

/**
 * Refresh ledger and self-stake caches without running full analysis.
 * Called every hour by the monitor to keep balances fresh.
 */
async function refreshLedgerCache(api) {
  const structureData = loadStructureCache();
  if (!structureData) {
    console.log('[Phragmen] No structure cache yet — skipping ledger refresh');
    return;
  }
  const addrs    = structureData.map(n => n.addr);
  const ledgers  = await batchGetLedgers(api, addrs);
  saveLedgersCache(ledgers);

  // Refresh self-stakes too
  const validatorEntries = await api.query.staking.validators.entries();
  const candidates       = validatorEntries.map(([key]) => key.args[0].toString());
  const selfStakes       = await batchGetLedgers(api, candidates);
  saveSelfCache(selfStakes);
}

module.exports = { analyzeSlotPosition, clearCache, refreshLedgerCache, fmt, toFloat };
