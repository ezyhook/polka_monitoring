'use strict';

/**
 * Era Buffer Calculator
 *
 * For ACTIVE validators: rank, era stake, buffer over last (#600), surrounding validators.
 * For WAITING validators: how far below the active set threshold, what's needed to enter.
 *
 * Usage:
 *   node era-buffer.js                                    # uses VALIDATOR_ADDRESS from .env
 *   VALIDATOR_ADDRESS=1xxx... node era-buffer.js          # env override
 *   node era-buffer.js 1xxx...                            # command-line argument
 */

require('dotenv').config();

const { ApiPromise, WsProvider } = require('@polkadot/api');

const RPC_ENDPOINT      = process.env.RPC_ENDPOINT || 'wss://polkadot-asset-hub-rpc.polkadot.io';
const VALIDATOR_ADDRESS = process.argv[2] || process.env.VALIDATOR_ADDRESS || '14PkBX3BUF71wDh44BLeNby2u7X9ZBu36V28LMcBrdK35yC2';
const DECIMALS          = 10;
const PLANCK            = BigInt(10 ** DECIMALS);
const BATCH             = 20;

function fmt(planckVal) {
  const dot = Number(BigInt(planckVal.toString())) / Number(PLANCK);
  return dot.toLocaleString('en', { maximumFractionDigits: 2 }) + ' DOT';
}

function fmtDot(dot) {
  return dot.toLocaleString('en', { maximumFractionDigits: 2 }) + ' DOT';
}

async function getLedger(api, addr) {
  try {
    let nl = await api.query.staking.ledger(addr);
    if (nl.isNone) {
      const nb = await api.query.staking.bonded(addr);
      if (nb.isSome) nl = await api.query.staking.ledger(nb.unwrap());
    }
    return nl.isSome ? BigInt(nl.unwrap().active.toString()) : 0n;
  } catch (_) { return 0n; }
}

async function main() {
  console.log('Era Buffer Calculator');
  console.log('═══════════════════════════════════════════════');
  console.log(`Validator: ${VALIDATOR_ADDRESS}`);
  console.log(`RPC:       ${RPC_ENDPOINT}\n`);

  const api = await ApiPromise.create({ provider: new WsProvider(RPC_ENDPOINT, 5_000) });

  try {
    const eraOpt = await api.query.staking.currentEra();
    const era    = eraOpt.unwrap().toNumber();
    console.log(`Era: ${era}  Session: ${(await api.query.session.currentIndex()).toNumber()}\n`);

    // Validate intent check
    const prefs     = await api.query.staking.validators(VALIDATOR_ADDRESS).catch(() => null);
    const hasIntent = prefs && !prefs.isEmpty;
    console.log(`Validate intent: ${hasIntent ? '✅ Yes' : '❌ No (chilled)'}`);

    // Fetch all active validators
    console.log('Fetching active set exposures…');
    let entries = [];
    if (typeof api.query.staking.erasStakersOverview?.entries === 'function') {
      entries = await api.query.staking.erasStakersOverview.entries(era);
    } else if (typeof api.query.staking.erasStakers?.entries === 'function') {
      entries = await api.query.staking.erasStakers.entries(era);
    }

    if (entries.length === 0) { console.error('No era data found.'); return; }

    const activeSet = entries
      .map(([key, val]) => {
        const v    = val.unwrap ? val.unwrap() : val;
        const addr = key.args[key.args.length - 1].toString();
        return { addr, total: BigInt(v.total.toString()), own: BigInt(v.own.toString()) };
      })
      .sort((a, b) => (b.total > a.total ? 1 : b.total < a.total ? -1 : 0));

    const activeCount = activeSet.length;
    const last        = activeSet[activeCount - 1];
    const first       = activeSet[0];
    const myIdx       = activeSet.findIndex(v => v.addr === VALIDATOR_ADDRESS);

    console.log(`Active set: ${activeCount} validators`);
    console.log(`Threshold (#${activeCount}): ${fmt(last.total)}\n`);
    console.log('═══════════════════════════════════════════════');

    if (myIdx >= 0) {
      // ── ACTIVE ──────────────────────────────────────────────────────────────
      const me      = activeSet[myIdx];
      const rank    = myIdx + 1;
      const buffer  = me.total - last.total;
      const toFirst = first.total - me.total;
      const riskPct = ((activeCount - rank) / activeCount * 100).toFixed(1);
      const nextBelow = activeSet[myIdx + 1];

      console.log('STATUS: ✅ ACTIVE');
      console.log('═══════════════════════════════════════════════');
      console.log(`Rank:             #${rank} of ${activeCount}`);
      console.log(`Era total:        ${fmt(me.total)}`);
      console.log(`  Own stake:      ${fmt(me.own)}`);
      console.log(`  Nominators:     ${fmt(me.total - me.own)}`);
      console.log();
      console.log(`#1  (strongest):  ${fmt(first.total)}`);
      console.log(`#${activeCount} (weakest):   ${fmt(last.total)}  (${last.addr.slice(0,8)}…)`);
      console.log();
      console.log(`Buffer over #${activeCount}: +${fmt(buffer)}`);
      if (nextBelow) {
        console.log(`Gap to #${rank+1}:       +${fmt(me.total - nextBelow.total)}  (${nextBelow.addr.slice(0,8)}…)`);
      }
      console.log(`Distance to #1:   -${fmt(toFirst)}`);
      console.log(`Safety:            ${riskPct}% above ejection`);

      if (rank > activeCount * 0.9)       console.log('\n⚠️  DANGER ZONE — bottom 10%!');
      else if (rank > activeCount * 0.75) console.log('\n⚡ CAUTION — bottom 25%');
      else                                console.log('\n✅ SAFE');

      console.log('\n═══════════════════════════════════════════════');
      console.log('Surrounding validators (±5):');
      const from = Math.max(0, myIdx - 5);
      const to   = Math.min(activeCount - 1, myIdx + 5);
      for (let i = from; i <= to; i++) {
        const v      = activeSet[i];
        const marker = i === myIdx ? ' ◄ YOU' : '';
        console.log(`  #${String(i+1).padStart(3)}  ${fmt(v.total).padStart(22)}  ${v.addr.slice(0,8)}…${marker}`);
      }

    } else {
      // ── WAITING ──────────────────────────────────────────────────────────────
      console.log('STATUS: ⏳ WAITING — not in current active set');
      console.log('═══════════════════════════════════════════════');

      // Get our ledger.active as proxy for nomination weight
      const myLedger = await getLedger(api, VALIDATOR_ADDRESS);
      const needed   = last.total > myLedger ? last.total - myLedger : 0n;

      console.log(`Our ledger.active: ${fmt(myLedger)}`);
      console.log(`Threshold (#${activeCount}):  ${fmt(last.total)}`);
      if (needed > 0n) {
        console.log(`Deficit:           -${fmt(needed)} to reach threshold`);
      } else {
        console.log(`Above threshold by: +${fmt(myLedger - last.total)}`);
        console.log(`  → Should enter next era if nominations remain`);
      }

      // Scan all waiting validators with their total nominated stake
      console.log('\nScanning waiting validators to find queue position…');
      const validatorEntries = await api.query.staking.validators.entries();
      const activeAddrs      = new Set(activeSet.map(v => v.addr));
      const waitingAddrs     = validatorEntries
        .map(([key]) => key.args[0].toString())
        .filter(addr => !activeAddrs.has(addr));

      console.log(`Waiting candidates: ${waitingAddrs.length}`);

      // Batch fetch ledger for all waiting validators
      const waitingStakes = new Map();
      for (let i = 0; i < waitingAddrs.length; i += BATCH) {
        const batch   = waitingAddrs.slice(i, i + BATCH);
        const results = await Promise.all(batch.map(addr => getLedger(api, addr)));
        batch.forEach((addr, j) => waitingStakes.set(addr, results[j]));
      }

      const waitingList = waitingAddrs
        .map(addr => ({ addr, stake: waitingStakes.get(addr) || 0n }))
        .sort((a, b) => (b.stake > a.stake ? 1 : b.stake < a.stake ? -1 : 0));

      const myWaitIdx = waitingList.findIndex(v => v.addr === VALIDATOR_ADDRESS);
      const myWaitRank = myWaitIdx >= 0 ? myWaitIdx + 1 : null;

      if (myWaitRank) {
        const myWaitStake = waitingList[myWaitIdx].stake;
        console.log(`\nWaiting queue rank: #${myWaitRank} of ${waitingList.length}`);
        console.log(`Own ledger.active:  ${fmt(myWaitStake)}`);

        // Show surrounding in waiting queue
        console.log('\nSurrounding in waiting queue (±3):');
        const wFrom = Math.max(0, myWaitIdx - 3);
        const wTo   = Math.min(waitingList.length - 1, myWaitIdx + 3);
        for (let i = wFrom; i <= wTo; i++) {
          const v      = waitingList[i];
          const marker = i === myWaitIdx ? ' ◄ YOU' : '';
          console.log(`  #${String(i+1).padStart(3)}  ${fmt(v.stake).padStart(22)}  ${v.addr.slice(0,8)}…${marker}`);
        }
      }

      // Show bottom of active set for comparison
      console.log('\nBottom of active set (#595-#600):');
      for (let i = Math.max(0, activeCount - 5); i < activeCount; i++) {
        const v = activeSet[i];
        console.log(`  #${String(i+1).padStart(3)}  ${fmt(v.total).padStart(22)}  ${v.addr.slice(0,8)}…`);
      }
    }

    console.log('\n═══════════════════════════════════════════════');

  } finally {
    await api.disconnect();
    console.log('Done.');
  }
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
