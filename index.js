'use strict';

require('dotenv').config();

const StateManager                    = require('./src/state');
const Notifier                        = require('./src/notifier');
const { escapeHtml }                  = require('./src/notifier');
const { ChainWatcher }                = require('./src/watcher');
const { clearCache, refreshLedgerCache } = require('./src/phragmen');
const { runPhragmenInChild }          = require('./src/phragmen-runner');
const { Lock }                        = require('./src/lock');

// One Phragmén child at a time (each gets a 1.5 GB heap)
const rankLock = new Lock('Phragmén analysis');

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
  offlineThreshold:     parseInt(process.env.OFFLINE_THRESHOLD        || '3',        10),
  onlineThreshold:      parseInt(process.env.ONLINE_THRESHOLD         || '2',        10),
  minStakeChange:       parseFloat(process.env.MIN_STAKE_CHANGE       || '100'),
  nodeRpcEndpoint:      process.env.NODE_RPC_ENDPOINT                 || null,
  nodeHealthInterval:   parseInt(process.env.NODE_HEALTH_INTERVAL     || '60000',    10),
  // Node health thresholds — fall back to the heartbeat ones if not set
  nodeOfflineThreshold: parseInt(process.env.NODE_OFFLINE_THRESHOLD || process.env.OFFLINE_THRESHOLD || '3', 10),
  nodeOnlineThreshold:  parseInt(process.env.NODE_ONLINE_THRESHOLD  || process.env.ONLINE_THRESHOLD  || '2', 10),
  nodeSyncThreshold:    parseInt(process.env.NODE_SYNC_THRESHOLD    || '5', 10),
  // Phragmen schedule: UTC times for 4 daily runs
  // 9:00, 16:00, 22:00 UTC+3 = 6:00, 13:00, 19:00 UTC  + one more at 01:00 UTC
  rankScheduleUTC: (process.env.RANK_SCHEDULE_UTC || '1,6,13,19').split(',').map(h => parseInt(h.trim(), 10)),
};

// ── Phragmén scheduler ────────────────────────────────────────────────────────

function schedulePhragmen(watcher, notifier, state, token) {
  let lastRunHour = -1;

  const tick = async () => {
    const now     = new Date();
    const hourUTC = now.getUTCHours();

    if (!CONFIG.rankScheduleUTC.includes(hourUTC)) return;
    if (lastRunHour === hourUTC) return; // already ran this hour
    if (rankLock.busy) return;           // /rank in progress — retry on the next tick
    lastRunHour = hourUTC;

    // At 6:00 UTC (9:00 UTC+3) — refresh cache
    const forceRefresh = (hourUTC === 6);
    if (forceRefresh) {
      console.log('[Phragmen] Scheduled refresh — clearing nominator cache');
      clearCache();
    }

    console.log(`[Phragmen] Scheduled run at UTC ${hourUTC}:00`);
    try {
      const result   = await rankLock.run(() =>
        runPhragmenInChild(CONFIG.rpcEndpoint, CONFIG.validatorAddress, forceRefresh));
      const messages = Notifier.formatRank(result, CONFIG.validatorAddress, token, { topN: 5 });

      // Save to state for /rank command
      await state.set('last_rank_result', result);
      await state.set('last_rank_token', token);

      // Send to Telegram
      await notifier.send(`📅 <b>Scheduled rank analysis</b> (UTC ${hourUTC}:00)`);
      for (const msg of messages) await notifier.send(msg);
    } catch (e) {
      console.error('[Phragmen] Scheduled run error:', e.message);
      await notifier.send(`🔴 <b>Phragmén analysis error</b>\n<code>${escapeHtml(e.message)}</code>`);
    }
  };

  // Check every minute
  setInterval(() => tick().catch(e => console.error('[Phragmen] Tick error:', e.message)), 60_000);
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
    offlineThreshold:     CONFIG.offlineThreshold,
    onlineThreshold:      CONFIG.onlineThreshold,
    minStakeChange:       CONFIG.minStakeChange,
    nodeRpcEndpoint:      CONFIG.nodeRpcEndpoint,
    nodeHealthInterval:   CONFIG.nodeHealthInterval,
    nodeOfflineThreshold: CONFIG.nodeOfflineThreshold,
    nodeOnlineThreshold:  CONFIG.nodeOnlineThreshold,
    nodeSyncThreshold:    CONFIG.nodeSyncThreshold,
  });

  // ── /status ──────────────────────────────────────────────────────────────
  notifier.setStatusProvider(() => watcher.getStatus());

  // ── /rank — run fresh Phragmén or return cached ───────────────────────────
  notifier.setRankProvider(async (onStart) => {
    const token = watcher.token || 'DOT';
    // Always run fresh on /rank command (child process keeps monitor heap clean)
    const result = await rankLock.run(async () => {
      await onStart();
      return runPhragmenInChild(CONFIG.rpcEndpoint, CONFIG.validatorAddress, false);
    });
    await state.set('last_rank_result', result);
    await state.set('last_rank_token', token);
    return Notifier.formatRank(result, CONFIG.validatorAddress, token, { topN: 10, links: true });
  });

  // ── /nominators ───────────────────────────────────────────────────────────
  notifier.setNominatorsProvider(async (onStart) => {
    const { activeNoms, pendingNoms } = await watcher.scanPool(onStart);
    return Notifier.formatNominators(activeNoms, pendingNoms, watcher.token, CONFIG.validatorAddress);
  });

  // ── /update ───────────────────────────────────────────────────────────────
  notifier.setUpdateProvider(async (onStart) => {
    const { activeNoms, pendingNoms, grandTotal, failed } = await watcher.scanPool(onStart);
    return (
      `✅ <b>Database updated</b>\n` +
      `Active: <b>${activeNoms.length}</b>  Waiting: <b>${pendingNoms.length}</b>\n` +
      `Total bonded: <b>${grandTotal} ${watcher.token}</b>` +
      (failed > 0 ? `\n⚠️ ${failed} ledger queries failed — previous values kept` : '')
    );
  });

  // ── /history ──────────────────────────────────────────────────────────────
  notifier.setHistoryProvider(async () => {
    const history = await state.get('payout_history', []) || [];
    return Notifier.formatHistory(history, watcher.token || 'DOT');
  });

  // ── Graceful shutdown ──────────────────────────────────────────────────────
  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[Main] ${signal} — shutting down…`);
    setTimeout(() => process.exit(0), 10_000).unref();   // don't hang on a stuck close
    for (const [name, fn] of [['polling', () => notifier.stopPolling()], ['chain', () => watcher.disconnect()], ['state', () => state.close()]]) {
      try { await fn(); } catch (e) { console.error(`[Main] Shutdown ${name} error:`, e.message); }
    }
    process.exit(0);
  };
  process.on('SIGINT',  () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('uncaughtException', async (err) => {
    console.error('[Main] Unhandled exception:', err);
    await notifier.send(`🔴 <b>Monitor critical error</b>\n<code>${escapeHtml(err.message)}</code>`).catch(() => {});
    process.exit(1);
  });
  // Stray rejections are logged, not fatal — a transient RPC error must not
  // take the whole monitor down (and PM2 gives up after max_restarts).
  process.on('unhandledRejection', (reason) => {
    console.error('[Main] Unhandled rejection:', reason);
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

main().catch((err) => {
  console.error('[Main] Fatal:', err);
  process.exit(1);
});
