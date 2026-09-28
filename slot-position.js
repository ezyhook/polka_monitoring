'use strict';

/**
 * Polkadot Slot Position Predictor
 *
 * Simulates NPoS election to predict validator rank in the next era.
 * Uses Sequential Phragmén with correct budget splitting.
 *
 * Key fix: each nominator's budget is divided proportionally among their
 * selected validators based on inverse loads — not given in full to each.
 */

const { ApiPromise, WsProvider } = require('@polkadot/api');
const fs   = require('fs');
const path = require('path');

const STRUCTURE_CACHE_FILE = path.join(__dirname, '.nominators-structure.json');
const LEDGERS_CACHE_FILE   = path.join(__dirname, '.nominators-ledgers.json');
const SELF_CACHE_FILE      = path.join(__dirname, '.nominators-self.json');
const STRUCTURE_TTL =  1 * 60 * 60 * 1000;
const LEDGERS_TTL   =  1 * 60 * 60 * 1000;
const SELF_TTL      =  1 * 60 * 60 * 1000;

function readCache(file, ttl) {
  try {
    if (!fs.existsSync(file)) return null;
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const age = Date.now() - raw.savedAt;
    return age > ttl ? null : { data: raw.data, age };
  } catch (_) { return null; }
}
function writeCache(file, data) {
  try { fs.writeFileSync(file, JSON.stringify({ data, savedAt: Date.now() })); }
  catch (e) { console.warn('Cache write error:', e.message); }
}

function loadStructureCache() {
  const c = readCache(STRUCTURE_CACHE_FILE, STRUCTURE_TTL);
  if (c) console.log(`      Structure cache: ${Math.round(c.age / 60_000)}m old (${c.data.length} nominators)`);
  return c ? c.data : null;
}
function saveStructureCache(d) { writeCache(STRUCTURE_CACHE_FILE, d); console.log(`      Structure cache saved: ${d.length} nominators`); }

function loadLedgersCache() {
  const c = readCache(LEDGERS_CACHE_FILE, LEDGERS_TTL);
  if (c) console.log(`      Ledger cache: ${Math.round(c.age / 60_000)}m old`);
  return c ? new Map(c.data.map(([k, v]) => [k, BigInt(v)])) : null;
}
function saveLedgersCache(m) { const e = [...m.entries()].filter(([,v])=>v>0n).map(([k,v])=>[k,v.toString()]); writeCache(LEDGERS_CACHE_FILE, e); console.log(`      Ledger cache saved: ${e.length} entries (${m.size-e.length} zeros skipped)`); }

function loadSelfCache(candidates) {
  const c = readCache(SELF_CACHE_FILE, SELF_TTL);
  if (!c) return null;
  const map     = new Map(c.data.map(([k, v]) => [k, BigInt(v)]));
  const missing = candidates.filter(a => !map.has(a));
  if (missing.length > candidates.length * 0.1) return null;
  console.log(`      Self-stake cache: ${Math.round(c.age / 60_000)}m old`);
  return { map, missing };
}
function saveSelfCache(m) { writeCache(SELF_CACHE_FILE, [...m.entries()].map(([k,v])=>[k,v.toString()])); }

// Legacy alias
function loadCache() { return loadStructureCache(); }
function saveCache(d) { saveStructureCache(d); }

const RPC_ENDPOINT = process.env.RPC_ENDPOINT || 'wss://polkadot-asset-hub-rpc.polkadot.io';

// Address: CLI arg takes priority, then env var — never fall back to a hardcoded default
const VALIDATOR_ADDRESS = process.argv[2] || process.env.VALIDATOR_ADDRESS || '';
if (!VALIDATOR_ADDRESS) {
  console.error('Usage: node slot-position.js <validator-address>');
  console.error('       or set VALIDATOR_ADDRESS in .env');
  process.exit(1);
}

const DECIMALS = 10;
const PLANCK            = BigInt(10 ** DECIMALS);
const BATCH_SIZE        = 20;

// ── Helpers ───────────────────────────────────────────────────────────────────

function toFloat(planckBigInt) {
  return Number(planckBigInt) / Number(PLANCK);
}

function fmt(dot) {
  return dot.toLocaleString('en', { maximumFractionDigits: 2 }) + ' DOT';
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
    if (i % 200 === 0 && i > 0) process.stdout.write(`\r  Ledger reads: ${i}/${addrs.length}   `);
  }
  process.stdout.write(`\r  Ledger reads: ${addrs.length}/${addrs.length} ✓\n`);
  return result;
}

// ── Sequential Phragmén + Balancing ──────────────────────────────────────────
//
// Phase 1 — Sequential Phragmén: elect validators one by one, highest score first.
//   score(v) = selfStake(v) + Σ_i [ budget_i / (1 + load_i) ]
//   After election: load_i += 1 / score_elected  for each supporter i
//
// Phase 2 — Balancing: redistribute stake among elected validators to equalise
//   the "support" each receives. Iteratively moves stake from over-supported to
//   under-supported validators until convergence (or max iterations).
//   This is what the real runtime does after election to improve fairness.
//
// Balancing significantly improves rank accuracy vs Phase 1 alone.

function runPhragmen(candidates, nominatorVotes, selfStakes, maxSlots) {
  const loads     = new Map();
  const selected  = [];
  const remaining = new Set(candidates);

  // Reverse index: nominator -> list of validators they support
  const nomToValidators = new Map();
  for (const [validator, votes] of nominatorVotes) {
    for (const { nomAddr, budget } of votes) {
      if (!loads.has(nomAddr)) loads.set(nomAddr, 0);
      if (!nomToValidators.has(nomAddr)) nomToValidators.set(nomAddr, []);
      nomToValidators.get(nomAddr).push({ validator, budget });
    }
  }

  const limit = Math.min(maxSlots, candidates.length);

  // ── Phase 1: Sequential Phragmén election ────────────────────────────────────
  for (let round = 0; round < limit; round++) {
    let best = null, bestScore = -Infinity;
    for (const v of remaining) {
      let score = selfStakes.get(v) || 0;
      for (const { nomAddr, effectiveBudget } of (nominatorVotes.get(v) || [])) {
        if (effectiveBudget <= 0) continue;
        // Use effectiveBudget (budget/targets) so exclusive nominators weight more
        score += effectiveBudget / (1 + (loads.get(nomAddr) || 0));
      }
      if (score > bestScore) { bestScore = score; best = v; }
    }
    if (!best) break;

    selected.push({ address: best, stake: bestScore });
    remaining.delete(best);

    const loadIncrease = bestScore > 0 ? 1 / bestScore : 0;
    for (const { nomAddr } of (nominatorVotes.get(best) || [])) {
      loads.set(nomAddr, (loads.get(nomAddr) || 0) + loadIncrease);
    }
  }

  const selectedSet = new Set(selected.map(v => v.address));

  // ── Phase 2: Balancing ────────────────────────────────────────────────────────
  // Each nominator distributes their budget proportionally among their elected validators.
  // The share going to validator v from nominator i = budget_i * (1/load_v) / Σ_j(1/load_j)
  // where load_v is the current "support score" of v.
  // We iterate until support scores stop changing significantly.

  // Initialise support scores from Phase 1
  const support = new Map(); // validator -> current support (stake)
  for (const { address, stake } of selected) support.set(address, stake);

  const MAX_ITER    = 200;
  const CONVERGENCE = 0.0001; // stop when max change < 0.01%

  for (let iter = 0; iter < MAX_ITER; iter++) {
    // For each nominator, compute their allocation across elected validators
    // Allocation is proportional to 1/support (equalise support)
    const newSupport = new Map();
    for (const addr of selectedSet) newSupport.set(addr, selfStakes.get(addr) || 0);

    for (const [nomAddr, targets] of nomToValidators) {
      const electedTargets = targets.filter(t => selectedSet.has(t.validator));
      if (electedTargets.length === 0) continue;

      const budget = electedTargets[0].budget; // same budget for all targets of this nominator

      // Weight = 1 / support[v] — validators with less support attract more stake
      const weights = electedTargets.map(t => ({
        validator: t.validator,
        w: support.get(t.validator) > 0 ? 1 / support.get(t.validator) : 0,
      }));
      const totalW = weights.reduce((s, w) => s + w.w, 0);
      if (totalW === 0) continue;

      for (const { validator, w } of weights) {
        const share = budget * (w / totalW);
        newSupport.set(validator, (newSupport.get(validator) || 0) + share);
      }
    }

    // Check convergence
    // Apply damping: blend new and old values to prevent oscillation
    const DAMPING = 0.5;
    let maxChange = 0;
    for (const [addr, newVal] of newSupport) {
      const oldVal  = support.get(addr) || 0;
      const blended = oldVal * DAMPING + newVal * (1 - DAMPING);
      if (oldVal > 0) maxChange = Math.max(maxChange, Math.abs(blended - oldVal) / oldVal);
      support.set(addr, blended);
    }

    if (maxChange < CONVERGENCE) {
      process.stdout.write(`
      Balancing converged at iteration ${iter + 1}/${MAX_ITER}     
`);
      break;
    }
    if (iter === MAX_ITER - 1) {
      process.stdout.write(`
      Balancing reached max iterations (${MAX_ITER})              
`);
    }
  }

  // Rebuild selected with balanced stakes, re-sort by balanced support
  const activeSet = selected
    .map(v => ({ address: v.address, stake: support.get(v.address) || 0 }))
    .sort((a, b) => b.stake - a.stake);

  // Score waiting by simple sum
  const waiting = [...remaining]
    .map(v => {
      let score = selfStakes.get(v) || 0;
      for (const { budget } of (nominatorVotes.get(v) || [])) score += budget;
      return { address: v, stake: score };
    })
    .sort((a, b) => b.stake - a.stake);

  return { activeSet, waitingList: waiting, selectedSet };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('Polkadot Slot Position Predictor');
  console.log('═══════════════════════════════════════════════');
  console.log(`Validator: ${VALIDATOR_ADDRESS}`);
  console.log(`RPC:       ${RPC_ENDPOINT}\n`);

  const api = await ApiPromise.create({ provider: new WsProvider(RPC_ENDPOINT, 5_000) });

  try {
    // Current active status from chain (real, not simulated)
    console.log('[0/5] Current on-chain status…');
    const eraOpt   = await api.query.staking.currentEra();
    const era      = eraOpt.unwrap().toNumber();
    const sessionIdx = (await api.query.session.currentIndex()).toNumber();

    // Check if validator is in active set right now
    let isCurrentlyActive = false;
    let currentEraTotal   = null;
    let currentEraRank    = null;
    try {
      let exposure = null;
      if (typeof api.query.staking.erasStakersOverview === 'function') {
        const ov = await api.query.staking.erasStakersOverview(era, VALIDATOR_ADDRESS).catch(() => null);
        if (ov && !ov.isNone) {
          isCurrentlyActive = true;
          currentEraTotal   = BigInt(ov.unwrap().total.toString());
        }
      } else if (typeof api.query.staking.erasStakers === 'function') {
        const exp = await api.query.staking.erasStakers(era, VALIDATOR_ADDRESS).catch(() => null);
        if (exp && !exp.total.isZero()) {
          isCurrentlyActive = true;
          currentEraTotal   = BigInt(exp.total.toString());
        }
      }

      // If active — compute rank among all active validators
      if (isCurrentlyActive) {
        const allExposures = typeof api.query.staking.erasStakersOverview?.entries === 'function'
          ? await api.query.staking.erasStakersOverview.entries(era).catch(() => [])
          : await api.query.staking.erasStakers.entries(era).catch(() => []);

        const sorted = allExposures
          .map(([key, val]) => {
            const v = val.unwrap ? val.unwrap() : val;
            return { addr: key.args[key.args.length - 1].toString(), total: BigInt(v.total.toString()) };
          })
          .sort((a, b) => (b.total > a.total ? 1 : b.total < a.total ? -1 : 0));

        const idx = sorted.findIndex(v => v.addr === VALIDATOR_ADDRESS);
        currentEraRank = idx >= 0 ? idx + 1 : null;
        const last     = sorted[sorted.length - 1];
        const buffer   = currentEraTotal - last.total;

        console.log(`      Era ${era}  Session ${sessionIdx}`);
        console.log(`      ✅ ACTIVE  —  Rank #${currentEraRank}/${sorted.length} by era stake`);
        console.log(`      Era total: ${fmt(toFloat(currentEraTotal))}  Buffer over last: +${fmt(toFloat(buffer))}`);
      } else {
        console.log(`      Era ${era}  Session ${sessionIdx}`);
        console.log(`      ⏳ WAITING — not in current active set`);
      }
    } catch (e) {
      console.log(`      Could not determine active status: ${e.message}`);
    }

    // Check if validator has declared intent (staking.validators entry exists)
    try {
      const prefs = await api.query.staking.validators(VALIDATOR_ADDRESS);
      const hasIntent = prefs && !prefs.isEmpty;
      if (!isCurrentlyActive) {
        if (hasIntent) {
          console.log(`      ✅ Has validate intent — eligible for next era election`);
        } else {
          console.log(`      ❌ No validate intent — validator is CHILLED`);
          console.log(`         Must call staking.validate() to re-enter election queue`);
        }
      }
    } catch (_) {}
    console.log();

    // Network params
    console.log('[1/5] Network parameters…');
    const maxSlots          = (await api.query.staking.validatorCount()).toNumber();
    let minActiveBond = 0;
    try {
      const raw = await api.query.staking.minimumActiveStake();
      minActiveBond = toFloat(BigInt(raw.toString()));
    } catch (_) {
      try {
        const raw = await api.query.staking.minNominatorBond();
        minActiveBond = toFloat(BigInt(raw.toString()));
      } catch (_2) {
        console.log('      minActiveBond not available — using 0');
      }
    }
    const maxElectingVoters = api.consts.staking.maxElectingVoters?.toNumber() || 22500;
    const maxNomRewarded    = api.consts.staking.maxNominatorRewardedPerValidator?.toNumber() || 512;
    console.log(`      Active set size: ${maxSlots} slots`);
    console.log(`      Min active bond: ${minActiveBond.toFixed(2)} DOT`);
    console.log(`      Max electing voters: ${maxElectingVoters}`);
    console.log(`      Max rewarded/validator: ${maxNomRewarded}\n`);

    // Candidates — exclude blocked
    console.log('[2/5] Validator candidates…');
    const validatorEntries = await api.query.staking.validators.entries();
    const allCandidates = validatorEntries.map(([key, prefs]) => ({
      addr:    key.args[0].toString(),
      blocked: prefs.blocked.isTrue,
    }));
    const blockedCount = allCandidates.filter(c => c.blocked).length;
    console.log(`      Total in staking.validators: ${allCandidates.length}`);
    console.log(`      Blocked (nominations closed): ${blockedCount}`);

    // Include ALL candidates — blocked validators can still be elected
    // if they already have sufficient stake from previous nominations.
    // Only new nominations are blocked, not the validator itself from election.
    const candidates = allCandidates.map(c => c.addr);
    console.log(`      Candidates for simulation: ${candidates.length}`);
    if (candidates.length < maxSlots) {
      console.log(`      ⚠️  Fewer candidates (${candidates.length}) than slots (${maxSlots}).`);
      console.log(`         All candidates will be elected. Buffer analysis limited.\n`);
    } else {
      console.log();
    }

    // Nominators — load from cache or fetch fresh
    console.log('[3/5] Collecting nominators…');
    const candidateSet = new Set(candidates);

    // Tier 1: structure cache — 23h
    let validNominators;
    const structData = loadStructureCache();
    if (structData) {
      validNominators = structData
        .map(n => ({ addr: n.addr, targets: n.targets.filter(t => candidateSet.has(t)) }))
        .filter(n => n.targets.length > 0);
    } else {
      const entries = await api.query.staking.nominators.entries();
      validNominators = entries
        .filter(([, v]) => !v.isNone)
        .map(([key, v]) => ({ addr: key.args[0].toString(), targets: v.unwrap().targets.map(t => t.toString()).filter(t => candidateSet.has(t)) }))
        .filter(n => n.targets.length > 0);
      console.log(`      Total nominators: ${entries.length}, with valid targets: ${validNominators.length}`);
      saveStructureCache(validNominators);
    }

    // Tier 2: ledger balances — 1h cache
    let ledgerMap = loadLedgersCache();
    if (!ledgerMap) {
      console.log(`      Fetching ledger balances for ${validNominators.length} nominators…`);
      ledgerMap = await batchGetLedgers(api, validNominators.map(n => n.addr));
      saveLedgersCache(ledgerMap);
    } else {
      const allAddrs  = validNominators.map(n => n.addr);
      const missing   = allAddrs.filter(a => !ledgerMap.has(a));
      const zeroCount = allAddrs.filter(a => (ledgerMap.get(a) || 0n) === 0n).length;
      if (missing.length > 0) {
        console.log(`      Fetching ${missing.length} missing ledger entries…`);
        const newE = await batchGetLedgers(api, missing);
        for (const [k,v] of newE) ledgerMap.set(k, v);
      }
      if (zeroCount > allAddrs.length * 0.05) {
        console.warn(`      ${zeroCount} zero-balance entries — refreshing ledger cache…`);
        ledgerMap = await batchGetLedgers(api, allAddrs);
        saveLedgersCache(ledgerMap);
      }
    }

    // Tier 3: self-stakes — 1h cache
    console.log('[4/5] Self-stakes for candidates…');
    let selfStakesRaw;
    const selfC = loadSelfCache(candidates);
    if (selfC) {
      selfStakesRaw = selfC.map;
      if (selfC.missing.length > 0) {
        const newS = await batchGetLedgers(api, selfC.missing);
        for (const [k,v] of newS) selfStakesRaw.set(k, v);
      }
    } else {
      selfStakesRaw = await batchGetLedgers(api, candidates);
      saveSelfCache(selfStakesRaw);
    }

    // Convert to float DOT for Phragmén arithmetic
    const selfStakes = new Map();
    for (const [addr, planck] of selfStakesRaw) selfStakes.set(addr, toFloat(planck));

    // Build vote graph with three on-chain filters
    // Filter 1: Min Active Bond
    let filteredNominators = validNominators
      .map(n => ({ ...n, budget: toFloat(ledgerMap.get(n.addr) || 0n) }))
      .filter(n => n.budget >= minActiveBond && n.budget > 0);
    console.log(`      After minActiveBond filter: ${filteredNominators.length} (removed ${validNominators.length - filteredNominators.length})`);

    // Filter 2: Bags-List cap
    filteredNominators.sort((a, b) => b.budget - a.budget);
    filteredNominators = filteredNominators.slice(0, maxElectingVoters);
    console.log(`      After Bags-List cap: ${filteredNominators.length}`);

    const nominatorVotes = new Map();
    candidates.forEach(c => nominatorVotes.set(c, []));

    for (const { addr, targets, budget } of filteredNominators) {
      const effectiveBudget = budget / targets.length;
      for (const target of targets) {
        nominatorVotes.get(target)?.push({ nomAddr: addr, budget, effectiveBudget, targetCount: targets.length });
      }
    }

    // Filter 3: MaxNominatorRewardedPerValidator
    for (const [validator, votes] of nominatorVotes.entries()) {
      if (votes.length > maxNomRewarded) {
        votes.sort((a, b) => b.effectiveBudget - a.effectiveBudget);
        nominatorVotes.set(validator, votes.slice(0, maxNomRewarded));
      }
    }
    console.log(`      MaxNomRewarded cap (${maxNomRewarded}) applied\n`);

    // Avg targets per nominator — informational only
    let totalTargetsSum = 0;
    for (const { targets } of validNominators) totalTargetsSum += targets.length;
    const avgTargets = validNominators.length > 0 ? totalTargetsSum / validNominators.length : 1;
    console.log(`  Avg targets per nominator: ${avgTargets.toFixed(2)}`);

    // Run simulation
    console.log('\n[5/5] Running Sequential Phragmén…');
    const { activeSet, waitingList, selectedSet } = runPhragmen(candidates, nominatorVotes, selfStakes, maxSlots);
    console.log(`      Active: ${activeSet.length}, Waiting: ${waitingList.length}\n`);

    // Results
    console.log('═══════════════════════════════════════════════');
    console.log('RESULTS');
    console.log('═══════════════════════════════════════════════');

    const activeIdx = activeSet.findIndex(v => v.address === VALIDATOR_ADDRESS);
    const waitIdx   = waitingList.findIndex(v => v.address === VALIDATOR_ADDRESS);
    const marginal  = activeSet[activeSet.length - 1];
    const firstOut  = waitingList[0];

    console.log(`Candidates:    ${candidates.length}`);
    console.log(`Active slots:  ${maxSlots}`);

    if (activeIdx >= 0) {
      const rank          = activeIdx + 1;
      const me            = activeSet[activeIdx];
      const marginalStake = marginal?.stake || 0;
      const myStake       = me.stake;
      const buffer        = myStake - marginalStake;

      console.log(`✅ IN ACTIVE SET`);
      console.log(`   Rank:              #${rank} of ${activeSet.length}`);
      console.log(`   Predicted stake:   ${fmt(myStake)}`);
      console.log(`   Marginal (#${activeSet.length}):    ${fmt(marginalStake)}`);
      console.log(`   Buffer over last:  +${fmt(buffer)}`);

      if (candidates.length >= maxSlots) {
        const pct = ((activeSet.length - rank) / activeSet.length * 100).toFixed(1);
        console.log(`   Safety:            ${pct}% above ejection line`);
        if (rank > activeSet.length * 0.9)       console.log(`   ⚠️  DANGER ZONE — bottom 10%!`);
        else if (rank > activeSet.length * 0.75) console.log(`   ⚡ CAUTION — bottom 25%`);
        else                                      console.log(`   ✅ Comfortable position`);
      } else {
        console.log(`   ⚠️  Buffer unreliable: fewer candidates (${candidates.length}) than slots (${maxSlots})`);
      }
    } else if (waitIdx >= 0) {
      const rank   = waitIdx + 1;
      const me     = waitingList[waitIdx];
      const needed = (marginal?.stake || 0) - me.stake;
      console.log(`❌ WAITING`);
      console.log(`   Waiting rank:      #${rank}`);
      console.log(`   Predicted stake:   ${fmt(me.stake)}`);
      console.log(`   Needed to enter:   +${fmt(needed)}`);
    } else {
      console.log(`❓ Validator not found`);
    }

    // ── Anchor nominator analysis ──────────────────────────────────────────────
    console.log('\n═══════════════════════════════════════════════');
    console.log('ANCHOR NOMINATOR ANALYSIS');
    console.log('═══════════════════════════════════════════════');
    console.log('Concentrated stake (1 target = full budget, no dilution)\n');

    // Build anchor map — include VALIDATOR_ADDRESS even if not in staking.validators
    // (validator may have withdrawn candidacy but still have nominators)
    const anchorSet = new Set([...candidates, VALIDATOR_ADDRESS]);
    const anchorMap = new Map();
    anchorSet.forEach(c => anchorMap.set(c, []));

    for (const { addr, targets, budget } of filteredNominators) {
      if (budget < 1) continue;
      const targetCount = targets.length;  // targets is an array of strings
      const effective   = budget / targetCount;
      for (const target of targets) {
        if (anchorMap.has(target)) {
          anchorMap.get(target).push({ nomAddr: addr, budget, targets: targetCount, effective });
        }
      }
    }

    // Our validator — full analysis
    const allMyAnchors = (anchorMap.get(VALIDATOR_ADDRESS) || [])
      .sort((a, b) => b.effective - a.effective);

    // Exclusive nominators (100% to this validator)
    const exclusiveNoms  = allMyAnchors.filter(n => n.targets === 1);
    const exclusiveCount = exclusiveNoms.length;
    const exclusiveTotal = exclusiveNoms.reduce((s, n) => s + n.budget, 0);

    console.log(`Our validator: ${VALIDATOR_ADDRESS.slice(0, 8)}…`);
    console.log(`🔒 Exclusive (100% to you): ${exclusiveCount} nominators — ${fmt(exclusiveTotal)}`);
    console.log();

    const myAnchors = allMyAnchors.slice(0, 10);
    if (myAnchors.length > 0) {
      console.log('Top 10 by effective stake:');
      myAnchors.forEach((n, i) => {
        const anchor = n.targets === 1 ? ' ← exclusive' : '';
        console.log(`  ${i + 1}. ${n.nomAddr.slice(0, 8)}…  budget: ${fmt(n.budget)}  targets: ${n.targets}  effective: ${fmt(n.effective)}${anchor}`);
      });
    } else {
      console.log('No nominators found for this validator.');
    }


    console.log('\n═══════════════════════════════════════════════');

  } finally {
    await api.disconnect();
    console.log('\nDone.');
  }
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
