'use strict';

require('dotenv').config();

const StateManager     = require('./src/state');
const Notifier         = require('./src/notifier');
const { ChainWatcher, toToken } = require('./src/watcher');

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
  offlineThreshold:     parseInt(process.env.OFFLINE_THRESHOLD          || '3',        10),
  onlineThreshold:      parseInt(process.env.ONLINE_THRESHOLD           || '2',        10),
};

// ── Bootstrap ─────────────────────────────────────────────────────────────────

async function main() {
  console.log('═══════════════════════════════════════════════');
  console.log('   Polkadot Validator Monitor');
  console.log('═══════════════════════════════════════════════');
  console.log(`Validator : ${CONFIG.validatorAddress}`);
  console.log(`Network   : ${CONFIG.network}`);
  console.log(`AH RPC    : ${CONFIG.rpcEndpoint}`);
  console.log(`RC RPC    : ${CONFIG.rcRpcEndpoint}`);
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
  });

  // ── Command providers ──────────────────────────────────────────────────────

  notifier.setStatusProvider(() => watcher.getStatus());

  notifier.setNominatorsProvider(async () => {
    // Fetch ALL nominators via staking.nominators scan, then read ledger.active for each.
    // ledger.active is the full bonded amount — not the era-capped share from erasStakers.
    // Active/waiting split is determined by presence in the current era erasStakers.
    const era      = await watcher._currentEra();
    const exposure = await watcher._getExposure(era);

    // Active set — era participants (for display tagging only, NOT for stake amounts)
    const eraActiveSet = new Set(
      exposure ? exposure.others.map(n => n.who.toString()) : []
    );

    // Scan all nominators pointing at this validator
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
      console.error('[/nominators] Scan error:', e.message);
    }
    console.log(`[/nominators] Total nominators found: ${allNomAddrs.length}`);

    // Fetch ledger.active for every nominator in parallel batches of 30
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
        } catch (_) {
          return { addr, amount: '0', active: eraActiveSet.has(addr) };
        }
      }));
      allNoms.push(...results);
    }

    const activeNoms  = allNoms.filter(n => n.active);
    const pendingNoms = allNoms.filter(n => !n.active);
    const grandTotal  = allNoms.reduce((s, n) => s + parseFloat(n.amount || 0), 0).toFixed(4);
    console.log(`[/nominators] Done: ${activeNoms.length} active, ${pendingNoms.length} waiting, bonded: ${grandTotal} ${watcher.token}`);

    // Persist unified pool for /status "All bonded" calculation
    const poolMap = {};
    for (const n of allNoms) poolMap[n.addr] = n.amount;
    await state.set('nominators_pool', poolMap);
    await state.set('pool_bootstrapped', true);

    const activeMap = {};
    for (const n of activeNoms) activeMap[n.addr] = n.amount;
    await state.set('nominators_active', activeMap);
    await state.set('nominators', activeMap);
    await state.set('active_bootstrapped', true);

    const pendingMap = {};
    for (const n of pendingNoms) pendingMap[n.addr] = n.amount;
    await state.set('nominators_pending', pendingMap);
    await state.set('nominators_pending_prev', pendingMap);
    await state.set('pending_bootstrapped', true);

    return Notifier.formatNominators(activeNoms, pendingNoms, watcher.token, CONFIG.validatorAddress);
  })
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
      `/status /nominators /history /help`
    );

    console.log('\n[Main] Monitoring active. Press Ctrl+C to stop.\n');
  } catch (err) {
    console.error('[Main] Startup error:', err.message);
    await notifier.connectionError(CONFIG.rpcEndpoint, err.message).catch(() => {});
    process.exit(1);
  }
}

main();
