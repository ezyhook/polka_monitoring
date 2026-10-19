'use strict';

/**
 * Slot position analysis for a validator on Asset Hub (staking-async +
 * multi-block election). Three sources, best available wins:
 *
 *   chain      — next era already elected and exported: exact on-chain result
 *   snapshot   — election in progress: Seq-Phragmén + balancing on the
 *                official election snapshot (validated: same 600 winners,
 *                stake error ~0.01%)
 *   simulation — no snapshot yet: same algorithm on the current state, voters
 *                taken in bags-list order up to the snapshot size, exactly as
 *                staking builds the snapshot
 *
 * Runs inside the Phragmén child process (phragmen-worker.js).
 */

const fs   = require('fs');
const path = require('path');
const { seqPhragmen } = require('./npos');

// Voter list (order + stake + targets) — the expensive part, ~1 min to fetch
const VOTERS_CACHE_FILE = path.join(__dirname, '..', '.npos-voters.json');
const VOTERS_TTL        = 60 * 60 * 1000;   // 1h
// Pre-rewrite cache files, removed by clearCache()
const LEGACY_CACHE_FILES = ['.nominators-structure.json', '.nominators-ledgers.json', '.nominators-self.json']
  .map(f => path.join(__dirname, '..', f));

const DECIMALS           = 10;
const PLANCK             = 10 ** DECIMALS;
const BALANCING_ITERS    = 10;
const BATCH_SIZE         = 20;
const DEFAULT_MAX_VOTERS = 22_528;   // 32 pages × 704 on Polkadot Asset Hub

// ── Helpers ───────────────────────────────────────────────────────────────────

function toFloat(planckVal) {
  return Number(BigInt(planckVal.toString())) / PLANCK;
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
    if (ledger.isSome) return toFloat(ledger.unwrap().active);
  } catch (_) {}
  return 0;
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

// ── Cache (one JSON item per line — avoids one huge string in memory) ─────────

function readCache(file, ttl) {
  try {
    if (!fs.existsSync(file)) return null;
    const lines  = fs.readFileSync(file, 'utf8').split('\n');
    const header = JSON.parse(lines[0]);
    const age    = Date.now() - header.savedAt;
    if (age > ttl) return null;
    const data = [];
    for (let i = 1; i < lines.length; i++) if (lines[i]) data.push(JSON.parse(lines[i]));
    return { data, age, meta: header.meta };
  } catch (_) { return null; }
}

function writeCache(file, data, meta) {
  try {
    const tmp = `${file}.${process.pid}.tmp`;   // per-process tmp: no clobbering between workers
    const fd  = fs.openSync(tmp, 'w');
    fs.writeSync(fd, JSON.stringify({ savedAt: Date.now(), meta }) + '\n');
    for (const item of data) fs.writeSync(fd, JSON.stringify(item) + '\n');
    fs.closeSync(fd);
    fs.renameSync(tmp, file);   // atomic replace
  } catch (e) { console.error('[Phragmen] Cache write error:', e.message); }
}

function clearCache() {
  for (const f of [VOTERS_CACHE_FILE, ...LEGACY_CACHE_FILES]) {
    try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch (_) {}
  }
  console.log('[Phragmen] All caches cleared');
}

// ── Election inputs ───────────────────────────────────────────────────────────

/** Voter snapshot size: pages × voters per page of the multi-block election. */
function maxElectingVoters(api) {
  const c = api.consts.multiBlockElection;
  if (c?.pages && c?.voterSnapshotPerBlock) return c.pages.toNumber() * c.voterSnapshotPerBlock.toNumber();
  return api.consts.staking.maxElectingVoters?.toNumber() || DEFAULT_MAX_VOTERS;
}

/**
 * The official election snapshot, if an election is running and the snapshot
 * is complete. Returns null otherwise.
 */
async function loadElectionSnapshot(api) {
  const mbe = api.query.multiBlockElection;
  if (!mbe?.pagedVoterSnapshot || !mbe?.currentPhase) return null;

  const phase = await mbe.currentPhase();
  if (phase.isOff) return null;

  const round  = (await mbe.round()).toNumber();
  const pages  = api.consts.multiBlockElection.pages.toNumber();
  const [tEntries, vEntries] = [
    await mbe.pagedTargetSnapshot.entries(round),
    await mbe.pagedVoterSnapshot.entries(round),
  ];
  if (vEntries.length < pages || tEntries.length === 0) return null;   // still being created

  const unwrap  = (v) => (v && v.isSome !== undefined ? (v.isSome ? v.unwrap() : []) : v);
  const targets = [];
  for (const [, v] of tEntries) for (const t of unwrap(v)) targets.push(t.toString());
  const voters = [];
  for (const [, v] of vEntries) {
    for (const [who, weight, ts] of unwrap(v)) {
      voters.push({ id: who.toString(), stake: toFloat(weight), targets: ts.map(t => t.toString()) });
    }
  }
  const desired = (await mbe.desiredTargets(round)).toJSON();
  console.log(`[Phragmen] Using election snapshot: round ${round}, phase ${phase.type}, ${voters.length} voters, ${targets.length} targets`);
  return { targets, voters, desired, round, phase: phase.type };
}

/**
 * All voters in bags-list order with their stake and targets — the same walk
 * staking does to build the snapshot (nominators + validators' self-votes).
 * Cached for 1h.
 */
async function loadVoters(api, forceRefresh) {
  if (!forceRefresh) {
    const c = readCache(VOTERS_CACHE_FILE, VOTERS_TTL);
    if (c) {
      console.log(`[Phragmen] Voter cache: ${Math.round(c.age / 60_000)}m old, ${c.data.length} voters`);
      return c.data.map(([id, stake, targets]) => ({ id, stake, targets }));
    }
  }

  const t0 = Date.now();
  console.log('[Phragmen] Fetching voter list (bags-list, nominators, ledgers)…');

  // Bags-list: bags (head/tail per threshold) + nodes (linked list)
  const bags = (await api.query.voterList.listBags.entries())
    .map(([key, v]) => ({ upper: BigInt(key.args[0].toString()), head: v.unwrap().head.toString() }))
    .filter(b => b.head)
    .sort((a, b) => (b.upper > a.upper ? 1 : b.upper < a.upper ? -1 : 0));
  const next = new Map();
  for (const [key, v] of await api.query.voterList.listNodes.entries()) {
    if (v.isNone) continue;
    const node = v.unwrap();
    next.set(key.args[0].toString(), node.next.isSome ? node.next.unwrap().toString() : null);
  }

  // Nominations
  const nominations = new Map();
  for (const [key, v] of await api.query.staking.nominators.entries()) {
    if (v.isNone) continue;
    nominations.set(key.args[0].toString(), v.unwrap().targets.map(t => t.toString()));
  }
  const validators = new Set((await api.query.staking.validators.keys()).map(k => k.args[0].toString()));

  // Stakes: all ledgers at once, keyed by stash
  const stakeOf = new Map();
  for (const [, v] of await api.query.staking.ledger.entries()) {
    if (v.isNone) continue;
    const l = v.unwrap();
    stakeOf.set(l.stash.toString(), toFloat(l.active));
  }

  // Walk the list from the highest bag down
  const voters = [];
  for (const bag of bags) {
    let id = bag.head;
    let guard = next.size + 1;
    while (id && guard-- > 0) {
      const targets = nominations.get(id);
      if (targets && targets.length > 0)  voters.push({ id, stake: stakeOf.get(id) || 0, targets });
      else if (validators.has(id))        voters.push({ id, stake: stakeOf.get(id) || 0, targets: [id] });
      id = next.get(id);
    }
  }
  console.log(`[Phragmen] Voter list: ${voters.length} voters in ${((Date.now() - t0) / 1000).toFixed(0)}s`);

  writeCache(VOTERS_CACHE_FILE, voters.map(v => [v.id, v.stake, v.targets]));
  return voters;
}

// ── Era status from chain ─────────────────────────────────────────────────────

/** Rank / total / buffer of a validator in an era's exported exposures. */
async function eraStatus(api, era, validatorAddress) {
  const entries = await api.query.staking.erasStakersOverview.entries(era);
  const sorted  = entries
    .map(([key, val]) => ({ addr: key.args[1].toString(), total: toFloat(val.unwrap().total) }))
    .sort((a, b) => b.total - a.total);
  const idx  = sorted.findIndex(v => v.addr === validatorAddress);
  const last = sorted[sorted.length - 1];
  return {
    cluster:  idx >= 0 ? clusterSize(sorted.map(v => v.total), sorted[idx].total) : null,
    count:    sorted.length,
    isActive: idx >= 0,
    rank:     idx >= 0 ? idx + 1 : null,
    total:    idx >= 0 ? sorted[idx].total : 0,
    marginal: last ? last.total : 0,
    buffer:   idx >= 0 && last ? sorted[idx].total - last.total : null,
  };
}

/**
 * Balancing pulls supports together: ~200 validators can sit within ±0.1% of
 * each other, so a tiny stake change moves the rank by dozens of places.
 * Returns how many *other* validators are within ±0.1% of `stake`.
 */
function clusterSize(stakes, stake) {
  return stakes.filter(s => Math.abs(s - stake) <= stake * 0.001).length - 1;
}

/** Backers of the validator in an exported era: [{ addr, weight }] */
async function eraBackers(api, era, validatorAddress) {
  const ov = await api.query.staking.erasStakersOverview(era, validatorAddress);
  if (ov.isNone) return [];
  const pages  = ov.unwrap().pageCount.toNumber();
  const result = [];
  for (let p = 0; p < pages; p++) {
    const page = await api.query.staking.erasStakersPaged(era, validatorAddress, p);
    if (page.isNone) continue;
    for (const { who, value } of page.unwrap().others) result.push({ addr: who.toString(), weight: toFloat(value) });
  }
  return result;
}

/**
 * Anchor list: backers sorted by the stake they give us.
 *   targets   — nominations that are current validators (others can't receive stake)
 *   nominated — all nominations, incl. chilled / removed validators
 *   exclusive — we are their only valid target: 100% to us in every election.
 * (Not "gave us 100% this era": the election solution is sparse — ~99% of all
 * nominators back exactly one validator per era — so that says nothing.)
 */
function anchorsFrom(backers) {
  const all = backers
    .sort((a, b) => b.weight - a.weight)
    .map(b => ({
      addr:      b.addr,
      budget:    b.budget,
      targets:   b.targets,
      nominated: b.nominated ?? b.targets,
      effective: b.weight,
      exclusive: b.targets === 1,
    }));
  const sum = (list) => list.reduce((s, n) => s + n.effective, 0);
  const exclusive = all.filter(n => n.exclusive);
  return {
    myAnchors:      all.slice(0, 10),
    backerCount:    all.length,
    exclusiveCount: exclusive.length,
    exclusiveTotal: sum(exclusive),
  };
}

/** Run the election on given inputs and describe our validator's position. */
function simulate(inputs, validatorAddress, desired, source, era) {
  const t0 = Date.now();
  const r  = seqPhragmen(inputs.targets, inputs.voters, desired, { balancingIterations: BALANCING_ITERS });
  console.log(`[Phragmen] Seq-Phragmén + balancing (${source}): ${r.winners.length} winners in ${Date.now() - t0}ms`);

  const idx      = r.winners.findIndex(w => w.id === validatorAddress);
  const marginal = r.winners[r.winners.length - 1];
  const isSelf   = (v) => v.targets.length === 1 && v.targets[0] === v.id;
  const noms     = inputs.voters.filter(v => !isSelf(v));

  let waitRank = null;
  if (idx < 0) {
    const elected = new Set(r.winners.map(w => w.id));
    const waiting = inputs.targets.filter(t => !elected.has(t)).sort((a, b) => r.approval(b) - r.approval(a));
    const wi = waiting.indexOf(validatorAddress);
    waitRank = wi >= 0 ? wi + 1 : null;
  }

  const projection = {
    source, era,
    rank:       idx >= 0 ? idx + 1 : null,
    stake:      idx >= 0 ? r.winners[idx].support : r.approval(validatorAddress),
    buffer:     idx >= 0 ? r.winners[idx].support - marginal.support : null,
    cluster:    idx >= 0 ? clusterSize(r.winners.map(w => w.support), r.winners[idx].support) : null,
    marginal:   marginal ? marginal.support : 0,
    total:      r.winners.length,
    waitRank,
    nominators: noms.length,
    avgTargets: noms.length > 0 ? noms.reduce((s, v) => s + v.targets.length, 0) / noms.length : null,
  };
  const backers = r.backers(validatorAddress)
    .filter(b => b.voter !== validatorAddress)
    .map(b => ({ addr: b.voter, budget: b.budget, targets: b.targets, nominated: b.nominated, weight: idx >= 0 ? b.weight : b.budget }));
  return { projection, backers };
}

/** Current-state inputs: voters in bags-list order, capped at the snapshot size. */
async function currentStateInputs(api, forceRefresh) {
  const all       = await loadVoters(api, forceRefresh);
  const maxVoters = maxElectingVoters(api);
  const targets   = (await api.query.staking.validators.keys()).map(k => k.args[0].toString());
  const voters    = all.filter(v => v.stake > 0).slice(0, maxVoters);
  console.log(`[Phragmen] Current state: ${voters.length}/${all.length} voters (cap ${maxVoters}), ${targets.length} targets`);
  return { targets, voters };
}

// ── Main analysis function ────────────────────────────────────────────────────

/**
 * On Asset Hub the election for era N+1 starts as soon as era N becomes
 * active and is exported within ~1h, so:
 *   next     — era N+1: on-chain result once exported, else simulated on the
 *              official snapshot (or current state while the snapshot is built)
 *   forecast — the election after that (era N+2), simulated on current state;
 *              only computed when `next` is already final
 *
 * @param {object}  api               - Polkadot.js ApiPromise (Asset Hub), or api.at(hash)
 * @param {string}  validatorAddress  - SS58 stash address
 * @param {boolean} forceRefresh      - Ignore the voter cache
 * @returns {object} analysis result (see Notifier.formatRank)
 */
async function analyzeSlotPosition(api, validatorAddress, forceRefresh = false) {
  console.log('[Phragmen] Starting analysis…');
  const startTime = Date.now();

  const plannedEra   = (await api.query.staking.currentEra()).unwrap().toNumber();
  const activeEraOpt = await api.query.staking.activeEra();
  const era          = activeEraOpt.isSome ? activeEraOpt.unwrap().index.toNumber() : plannedEra;
  const sessionIdx   = (await api.query.session.currentIndex()).toNumber();
  const maxSlots     = (await api.query.staking.validatorCount()).toNumber();
  const validatorSet = new Set((await api.query.staking.validators.keys()).map(k => k.args[0].toString()));
  const candidates   = validatorSet.size;

  // Active era — real on-chain data
  const now = await eraStatus(api, era, validatorAddress);

  let next = null, forecast = null, backers = [];

  // Next era: exact if already elected and exported
  if (plannedEra > era) {
    const st = await eraStatus(api, plannedEra, validatorAddress);
    if (st.count >= maxSlots) {
      console.log(`[Phragmen] Era ${plannedEra} already elected (${st.count} validators) — on-chain result`);
      next = {
        source: 'chain', era: plannedEra,
        rank: st.rank, stake: st.total, buffer: st.buffer, cluster: st.cluster,
        marginal: st.marginal, total: st.count, waitRank: null,
      };
      backers = await eraBackers(api, plannedEra, validatorAddress);
      const addrs   = backers.map(b => b.addr);
      const noms    = await api.query.staking.nominators.multi(addrs);
      const budgets = await batchGetLedgers(api, addrs);
      backers.forEach((b, i) => {
        const targets = noms[i].isSome ? noms[i].unwrap().targets.map(t => t.toString()) : [];
        b.budget    = budgets.get(b.addr) || 0;
        b.nominated = targets.length;
        b.targets   = targets.filter(t => validatorSet.has(t)).length;   // only current validators count
      });
    }
  }

  if (next) {
    // Next era is final — forecast the election after it from current state
    const inputs = await currentStateInputs(api, forceRefresh);
    forecast = simulate(inputs, validatorAddress, maxSlots, 'simulation', plannedEra + 1).projection;
  } else {
    // Next era not final yet: official snapshot if complete, else current state
    const snap = await loadElectionSnapshot(api).catch((e) => {
      console.warn('[Phragmen] Snapshot read failed:', e.message);
      return null;
    });
    const inputs = snap || await currentStateInputs(api, forceRefresh);
    const target = plannedEra > era ? plannedEra : era + 1;
    const sim    = simulate(inputs, validatorAddress, (snap && snap.desired) || maxSlots, snap ? 'snapshot' : 'simulation', target);
    next    = sim.projection;
    backers = sim.backers;
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`[Phragmen] Done in ${elapsed}s. Era ${next.era} (${next.source}): ${next.rank ? '#' + next.rank : 'waiting'}` +
    (forecast ? `, era ${forecast.era} forecast: ${forecast.rank ? '#' + forecast.rank : 'waiting'}` : ''));

  return {
    era, plannedEra, sessionIdx, maxSlots, candidates,
    isActive: now.isActive, eraTotal: now.total, eraRank: now.rank, eraBuffer: now.buffer, eraCluster: now.cluster,
    next, forecast,
    ...anchorsFrom(backers),
    elapsed,
  };
}

module.exports = { analyzeSlotPosition, clearCache, fmt, toFloat, loadVoters, loadElectionSnapshot, maxElectingVoters, simulate };
