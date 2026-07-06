'use strict';

require('dotenv').config();

const StateManager     = require('./src/state');
const Notifier         = require('./src/notifier');
const { ChainWatcher, toToken, toFloat } = require('./src/watcher');

// ── Config ────────────────────────────────────────────────────────────────────

function requireEnv(name) {
  const val = process.env[name];
  if (!val) { console.error(`[Config] Missing required env var: ${name}`); process.exit(1); }
  return val;
}

const CONFIG = {
  validatorAddress:     requireEnv('VALIDATOR_ADDRESS'),
  telegramToken:        requireEnv('TELEGRAM_BOT_TOKEN'),
  telegramChatId:       requireEnv('TELEGRAM_CHAT_ID'),
  rpcEndpoint:          process.env.RPC_ENDPOINT             || 'wss://polkadot-asset-hub-rpc.polkadot.io',
  rcRpcEndpoint:        process.env.RC_RPC_ENDPOINT          || 'wss://rpc.polkadot.io',
  network:              process.env.NETWORK                  || 'polkadot',
  dbPath:               process.env.DB_PATH                  || './data/state.db',
  heartbeatMs:          parseInt(process.env.HEARTBEAT_INTERVAL       || '60000',    10),
  cooldownMs:           parseInt(process.env.NOTIFICATION_COOLDOWN    || '300000',   10),
  nomCheckMs:           parseInt(process.env.NOM_CHECK_INTERVAL       || '300000',   10),
  keyCheckMs:           parseInt(process.env.KEY_CHECK_INTERVAL       || '300000',   10),
  pendingCheckInterval: parseInt(process.env.PENDING_CHECK_INTERVAL   || '14400000', 10),
  oversubLimit:         parseInt(process.env.OVERSUB_LIMIT            || '512',      10),
  offlineThreshold:     parseInt(process.env.OFFLINE_THRESHOLD        || '3',        10),
  onlineThreshold:      parseInt(process.env.ONLINE_THRESHOLD         || '2',        10),
  minStakeChange:       parseFloat(process.env.MIN_STAKE_CHANGE       || '100'),
};

// ── Shared nominator scan (used by /nominators and /update) ───────────────────

async function scanNominators(watcher, state) {
  const era      = await watcher._currentEra();
  const exposure = await watcher._getExposure(era);

  const eraActiveSet = new Set(
    exposure ? exposure.others.map(n => n.who.toString()) : []
  );

  // Collect all addresses nominating this validator
  let allNomAddrs = [];
  try {
    const entries = await watcher.api.query.staking.nominators.entries();
    for (const [key, nomOpt] of entries) {
      if (nomOpt.isNone) continue;
      const targets = nomOpt.unwrap().targets.map(t => t.toString());
      if (!targets.includes(CONFIG.validatorAddress)) continue;
      allNomAddrs.push(key.args[0].toString());
    }
  } catch (e) {
    console.error('[scanNominators] Scan error:', e.message);
  }
  console.log(`[scanNominators] Found: ${allNomAddrs.length} nominators`);

  // Fetch ledger.active for every nominator in parallel batches
  const BATCH = 30;
  const allNoms = [];
  for (let i = 0; i < allNomAddrs.length; i += BATCH) {
    const batch   = allNomAddrs.slice(i, i + BATCH);
    const results = await Promise.all(batch.map(async (addr) => {
      try {
        let nl = await watcher.api.query.staking.ledger(addr);
        if (nl.isNone) {
          const nb = await watcher.api.query.staking.bonded(addr);
          if (nb.isSome) nl = await watcher.api.query.staking.ledger(nb.unwrap());
        }
        return {
          addr,
          amount: nl.isSome ? toToken(nl.unwrap().active.toString(), watcher.decimals) : '0',
          active: eraActiveSet.has(addr),
        };
      } catch (_) {
        return { addr, amount: '0', active: eraActiveSet.has(addr) };
      }
    }));
    allNoms.push(...results);
  }

  // Persist unified pool
  const poolMap    = {};
  const activeMap  = {};
  const pendingMap = {};
  for (const n of allNoms) {
    poolMap[n.addr] = n.amount;
    if (n.active) activeMap[n.addr] = n.amount;
    else          pendingMap[n.addr] = n.amount;
  }

  await state.set('nominators_pool', poolMap);
  await state.set('pool_bootstrapped', true);
  await state.set('nominators_active', activeMap);
  await state.set('nominators', activeMap);
  await state.set('active_bootstrapped', true);
  await state.set('nominators_pending', pendingMap);
  await state.set('nominators_pending_prev', pendingMap);
  await state.set('pending_bootstrapped', true);

  // Own stake for total
  let ownStakeNum = 0;
  try {
    let ledger = await watcher.api.query.staking.ledger(watcher.addr);
    if (ledger.isNone) {
      const bonded = await watcher.api.query.staking.bonded(watcher.addr);
      if (bonded.isSome) ledger = await watcher.api.query.staking.ledger(bonded.unwrap());
    }
    if (ledger.isSome) ownStakeNum = parseFloat(toToken(ledger.unwrap().active.toString(), watcher.decimals));
  } catch (_) {}

  const grandTotal = (ownStakeNum + allNoms.reduce((s, n) => s + parseFloat(n.amount || 0), 0)).toFixed(4);
  console.log(`[scanNominators] Done: ${allNoms.filter(n=>n.active).length} active, ${allNoms.filter(n=>!n.active).length} waiting, total: ${grandTotal} ${watcher.token}`);

  return { allNoms, activeNoms: allNoms.filter(n => n.active), pendingNoms: allNoms.filter(n => !n.active), grandTotal };
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────

async function main() {
  console.log('═══════════════════════════════════════════════');
  console.log('   Polkadot Validator Monitor');
  console.log('═══════════════════════════════════════════════');
  console.log(`Validator : ${CONFIG.validatorAddress}`);
  console.log(`Network   : ${CONFIG.network}`);
  console.log(`AH RPC    : ${CONFIG.rpcEndpoint}`);
  console.log(`RC RPC    : ${CONFIG.rcRpcEndpoint}`);
  console.log(`Min stake change: ${CONFIG.minStakeChange} ${CONFIG.network === 'kusama' ? 'KSM' : 'DOT'}`);
  console.log('═══════════════════════════════════════════════\n');

  const state    = new StateManager(CONFIG.dbPath);
  await state.open();

  const notifier = new Notifier(CONFIG.telegramToken, CONFIG.telegramChatId, CONFIG.cooldownMs);

  const watcher  = new ChainWatcher({
    rpcEndpoint:          CONFIG.rpcEndpoint,
    rcRpcEndpoint:        CONFIG.rcRpcEndpoint,
    validatorAddress:     CONFIG.validatorAddress,
    state,
    notifier,
    network:              CONFIG.network,
    heartbeatInterval:    CONFIG.heartbeatMs,
    nomCheckInterval:     CONFIG.nomCheckMs,
    keyCheckInterval:     CONFIG.keyCheckMs,
    pendingCheckInterval: CONFIG.pendingCheckInterval,
    oversubLimit:         CONFIG.oversubLimit,
    offlineThreshold:     CONFIG.offlineThreshold,
    onlineThreshold:      CONFIG.onlineThreshold,
    minStakeChange:       CONFIG.minStakeChange,
  });

  // ── /status ────────────────────────────────────────────────────────────────
  notifier.setStatusProvider(() => watcher.getStatus());

  // ── /nominators — full scan + display ─────────────────────────────────────
  notifier.setNominatorsProvider(async () => {
    const { activeNoms, pendingNoms } = await scanNominators(watcher, state);
    return Notifier.formatNominators(activeNoms, pendingNoms, watcher.token, CONFIG.validatorAddress);
  });

  // ── /update — full scan, update DB only, no display ───────────────────────
  notifier.setUpdateProvider(async () => {
    const { activeNoms, pendingNoms, grandTotal } = await scanNominators(watcher, state);
    return (
      `✅ <b>Database updated</b>\n` +
      `Active: <b>${activeNoms.length}</b>  Waiting: <b>${pendingNoms.length}</b>\n` +
      `Total bonded: <b>${grandTotal} ${watcher.token}</b>`
    );
  });

  // ── /history ───────────────────────────────────────────────────────────────
  notifier.setHistoryProvider(async () => {
    const history = await state.get('payout_history', []) || [];
    return Notifier.formatHistory(history, watcher.token || 'DOT');
  });

  // ── Graceful shutdown ──────────────────────────────────────────────────────
  const shutdown = async (signal) => {
    console.log(`\n[Main] ${signal} received — shutting down…`);
    await notifier.stopPolling();
    await watcher.disconnect();
    await state.close();
    process.exit(0);
  };
  process.on('SIGINT',  () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('uncaughtException', async (err) => {
    console.error('[Main] Unhandled exception:', err);
    await notifier.send(`🔴 <b>Monitor critical error</b>\n<code>${err.message}</code>`).catch(() => {});
    process.exit(1);
  });

  // ── Start ──────────────────────────────────────────────────────────────────
  try {
    await watcher.connect();
    await watcher.startMonitoring();

    await notifier.send(
      `🚀 <b>Monitor started</b>\n` +
      `Network: <b>${CONFIG.network}</b>\n` +
      `Validator: <code>${CONFIG.validatorAddress}</code>\n` +
      `/status /nominators /update /history /help`
    );

    console.log('\n[Main] Monitoring active. Press Ctrl+C to stop.\n');
  } catch (err) {
    console.error('[Main] Startup error:', err.message);
    await notifier.connectionError(CONFIG.rpcEndpoint, err.message).catch(() => {});
    process.exit(1);
  }
}

main();
