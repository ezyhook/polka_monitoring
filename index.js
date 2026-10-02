'use strict';

require('dotenv').config();

const StateManager                    = require('./src/state');
const Notifier                        = require('./src/notifier');
const { ChainWatcher, toToken, toFloat } = require('./src/watcher');
const { clearCache, refreshLedgerCache } = require('./src/phragmen');
const { runPhragmenInChild }          = require('./src/phragmen-runner');

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
  nodeRpcEndpoint:      process.env.NODE_RPC_ENDPOINT                 || null,
  nodeHealthInterval:   parseInt(process.env.NODE_HEALTH_INTERVAL     || '60000',    10),
  // Phragmen schedule: UTC times for 4 daily runs
  // 9:00, 16:00, 22:00 UTC+3 = 6:00, 13:00, 19:00 UTC  + one more at 01:00 UTC
  rankScheduleUTC: (process.env.RANK_SCHEDULE_UTC || '1,6,13,19').split(',').map(h => parseInt(h.trim(), 10)),
};

// ── Shared nominator scan ─────────────────────────────────────────────────────

async function scanNominators(watcher, state) {
  const era      = await watcher._currentEra();
  const exposure = await watcher._getExposure(era);
  const eraActiveSet = new Set(
    exposure ? exposure.others.map(n => n.who.toString()) : []
  );

  let allNomAddrs = [];
  try {
    const entries = await watcher.api.query.staking.nominators.entries();
    for (const [key, nomOpt] of entries) {
      if (nomOpt.isNone) continue;
      const targets = nomOpt.unwrap().targets.map(t => t.toString());
      if (!targets.includes(CONFIG.validatorAddress)) continue;
      allNomAddrs.push(key.args[0].toString());
    }
  } catch (e) { console.error('[scanNominators] Error:', e.message); }

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
        return { addr, amount: nl.isSome ? toToken(nl.unwrap().active.toString(), watcher.decimals) : '0', active: eraActiveSet.has(addr) };
      } catch (_) { return { addr, amount: '0', active: eraActiveSet.has(addr) }; }
    }));
    allNoms.push(...results);
  }

  const poolMap = {}, activeMap = {}, pendingMap = {};
  for (const n of allNoms) {
    poolMap[n.addr]    = n.amount;
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

// ── Phragmén scheduler ────────────────────────────────────────────────────────

function schedulePhragmen(watcher, notifier, state, token) {
  let lastRunHour = -1;

  const tick = async () => {
    const now     = new Date();
    const hourUTC = now.getUTCHours();

    if (!CONFIG.rankScheduleUTC.includes(hourUTC)) return;
    if (lastRunHour === hourUTC) return; // already ran this hour
    lastRunHour = hourUTC;

    // At 6:00 UTC (9:00 UTC+3) — refresh cache
    const forceRefresh = (hourUTC === 6);
    if (forceRefresh) {
      console.log('[Phragmen] Scheduled refresh — clearing nominator cache');
      clearCache();
    }

    console.log(`[Phragmen] Scheduled run at UTC ${hourUTC}:00`);
    try {
      const result   = await runPhragmenInChild(CONFIG.rcRpcEndpoint, CONFIG.validatorAddress, forceRefresh);
      const messages = Notifier.formatRank(result, CONFIG.validatorAddress, token, { topN: 5 });

      // Save to state for /rank command
      await state.set('last_rank_result', result);
      await state.set('last_rank_token', token);

      // Send to Telegram
      await notifier.send(`📅 <b>Scheduled rank analysis</b> (UTC ${hourUTC}:00)`);
      for (const msg of messages) await notifier.send(msg);
    } catch (e) {
      console.error('[Phragmen] Scheduled run error:', e.message);
      await notifier.send(`🔴 <b>Phragmén analysis error</b>\n<code>${e.message}</code>`);
    }
  };

  // Check every minute
  setInterval(tick, 60_000);
  console.log(`[Phragmen] Scheduler active. Runs at UTC: ${CONFIG.rankScheduleUTC.join(', ')}:00`);
  console.log(`[Phragmen] That is UTC+3: ${CONFIG.rankScheduleUTC.map(h => ((h + 3) % 24)).join(', ')}:00`);
}

// ── Ledger cache auto-refresh ─────────────────────────────────────────────────

function scheduleLedgerCacheRefresh(watcher) {
  const INTERVAL = 60 * 60_000; // 1 hour
  setInterval(async () => {
    console.log('[Phragmen] Auto-refreshing ledger cache…');
    try {
      await refreshLedgerCache(watcher.api);
      console.log('[Phragmen] Ledger cache refreshed');
    } catch (e) {
      console.error('[Phragmen] Ledger cache refresh error:', e.message);
    }
  }, INTERVAL);
  console.log('[Phragmen] Ledger cache auto-refresh: every 1h');
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
  console.log(`Min stake : ${CONFIG.minStakeChange} DOT`);
  console.log('═══════════════════════════════════════════════\n');

  const state    = new StateManager(CONFIG.dbPath);
  await state.open();

  const notifier = new Notifier(CONFIG.telegramToken, CONFIG.telegramChatId, CONFIG.cooldownMs);

  const watcher  = new ChainWatcher({
    rpcEndpoint:          CONFIG.rpcEndpoint,
    rcRpcEndpoint:        CONFIG.rcRpcEndpoint,
    validatorAddress:     CONFIG.validatorAddress,
    state, notifier,
    network:              CONFIG.network,
    heartbeatInterval:    CONFIG.heartbeatMs,
    nomCheckInterval:     CONFIG.nomCheckMs,
    keyCheckInterval:     CONFIG.keyCheckMs,
    pendingCheckInterval: CONFIG.pendingCheckInterval,
    oversubLimit:         CONFIG.oversubLimit,
    offlineThreshold:     CONFIG.offlineThreshold,
    onlineThreshold:      CONFIG.onlineThreshold,
    minStakeChange:       CONFIG.minStakeChange,
    nodeRpcEndpoint:      CONFIG.nodeRpcEndpoint,
    nodeHealthInterval:   CONFIG.nodeHealthInterval,
  });

  // ── /status ──────────────────────────────────────────────────────────────
  notifier.setStatusProvider(() => watcher.getStatus());

  // ── /rank — run fresh Phragmén or return cached ───────────────────────────
  notifier.setRankProvider(async () => {
    const token = watcher.token || 'DOT';
    // Always run fresh on /rank command (child process keeps monitor heap clean)
    const result = await runPhragmenInChild(CONFIG.rcRpcEndpoint, CONFIG.validatorAddress, false);
    await state.set('last_rank_result', result);
    await state.set('last_rank_token', token);
    return Notifier.formatRank(result, CONFIG.validatorAddress, token, { topN: 10, links: true });
  });

  // ── /nominators ───────────────────────────────────────────────────────────
  notifier.setNominatorsProvider(async () => {
    const { activeNoms, pendingNoms } = await scanNominators(watcher, state);
    return Notifier.formatNominators(activeNoms, pendingNoms, watcher.token, CONFIG.validatorAddress);
  });

  // ── /update ───────────────────────────────────────────────────────────────
  notifier.setUpdateProvider(async () => {
    const { activeNoms, pendingNoms, grandTotal } = await scanNominators(watcher, state);
    return (
      `✅ <b>Database updated</b>\n` +
      `Active: <b>${activeNoms.length}</b>  Waiting: <b>${pendingNoms.length}</b>\n` +
      `Total bonded: <b>${grandTotal} ${watcher.token}</b>`
    );
  });

  // ── /history ──────────────────────────────────────────────────────────────
  notifier.setHistoryProvider(async () => {
    const history = await state.get('payout_history', []) || [];
    return Notifier.formatHistory(history, watcher.token || 'DOT');
  });

  // ── Graceful shutdown ──────────────────────────────────────────────────────
  const shutdown = async (signal) => {
    console.log(`\n[Main] ${signal} — shutting down…`);
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

    // Start Phragmén scheduler after watcher is ready
    schedulePhragmen(watcher, notifier, state, watcher.token || 'DOT');

    await notifier.send(
      `🚀 <b>Monitor started</b>\n` +
      `Network: <b>${CONFIG.network}</b>\n` +
      `Validator: <code>${CONFIG.validatorAddress}</code>\n` +
      `/status /nominators /rank /update /history /help`
    );

    console.log('\n[Main] Monitoring active. Press Ctrl+C to stop.\n');
  } catch (err) {
    console.error('[Main] Startup error:', err.message);
    await notifier.connectionError(CONFIG.rpcEndpoint, err.message).catch(() => {});
    process.exit(1);
  }
}

main();
