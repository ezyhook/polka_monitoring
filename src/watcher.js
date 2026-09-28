'use strict';

const { ApiPromise, WsProvider } = require('@polkadot/api');

/**
 * Converts a planck value to a human-readable token string.
 * If the value already contains a decimal point it is returned as-is.
 */
function toToken(value, decimals) {
  const str = value.toString();
  if (str.includes('.')) return str;
  const n      = BigInt(str);
  const factor = BigInt(10 ** decimals);
  const whole  = n / factor;
  const frac   = n % factor;
  return `${whole}.${frac.toString().padStart(decimals, '0').slice(0, 4)}`;
}

/**
 * Convert any stored value (planck string or token string) to a float.
 */
function toFloat(value, decimals) {
  const str = value.toString();
  return str.includes('.') ? parseFloat(str) : parseFloat(toToken(str, decimals));
}

class ChainWatcher {
  constructor(opts) {
    this.rpc            = opts.rpcEndpoint;
    this.rcRpc          = opts.rcRpcEndpoint || 'wss://rpc.polkadot.io';
    this.addr           = opts.validatorAddress;
    this.state          = opts.state;
    this.notifier       = opts.notifier;
    this.network        = opts.network || 'polkadot';
    this.heartbeatMs    = opts.heartbeatInterval    || 60_000;
    this.nomCheckMs     = opts.nomCheckInterval     || 5 * 60_000;
    this.keyCheckMs     = opts.keyCheckInterval     || 5 * 60_000;
    this.pendingCheckMs = opts.pendingCheckInterval || 4 * 60 * 60_000;
    this.oversubLimit   = opts.oversubLimit         || 512;
    this.minStakeChange = opts.minStakeChange       || 100;  // minimum DOT change to trigger alert

    this.api     = null;
    this.rcApi   = null;
    this.decimals = 10;
    this.token    = 'DOT';

    this._heartbeatTimer  = null;
    this._lastBlock       = 0;
    this._wasOnline       = null;
    this._startTime       = Date.now();
    this._unsubs          = [];
    this._offlineStrikes  = 0;
    this._onlineStrikes   = 0;
    this.offlineThreshold = opts.offlineThreshold || 3;
    this.onlineThreshold  = opts.onlineThreshold  || 2;

    // Node HTTP health check (optional — disabled if nodeRpcEndpoint is empty)
    this.nodeRpc          = opts.nodeRpcEndpoint || '';
    this._nodeOnline      = null;   // null = unknown, true/false = last known state
    this._nodeOffStrikes  = 0;
    this._nodeOnStrikes   = 0;
    this._nodeHealthTimer = null;
    this.nodeHealthMs     = opts.nodeHealthInterval || 60_000;
  }

  // ── Connection ────────────────────────────────────────────────────────────────

  async connect() {
    console.log(`[Chain] Connecting to Asset Hub: ${this.rpc}`);
    const provider = new WsProvider(this.rpc, 5_000);
    provider.on('disconnected', () => { console.warn('[Chain] AH disconnected'); this._handleOffline(); });
    provider.on('connected',    () => console.log('[Chain] AH connected'));
    provider.on('error',        (e) => console.error('[Chain] AH error:', e.message));

    this.api = await ApiPromise.create({ provider });

    const chainInfo = await this.api.registry.getChainProperties();
    if (chainInfo) {
      const dec     = chainInfo.tokenDecimals.toHuman();
      const sym     = chainInfo.tokenSymbol.toHuman();
      this.decimals = Array.isArray(dec) ? Number(dec[0]) : Number(dec);
      this.token    = Array.isArray(sym) ? sym[0] : sym;
    }
    console.log(`[Chain] Network: ${this.network}, token: ${this.token}, decimals: ${this.decimals}`);

    try {
      const rcProvider = new WsProvider(this.rcRpc, 5_000);
      rcProvider.on('disconnected', async () => {
        console.warn('[Chain] RC disconnected — session keys unavailable until reconnected');
        this.rcApi = null;
      });
      rcProvider.on('connected', async () => {
        console.log('[Chain] RC reconnected');
        if (!this.rcApi) {
          try {
            this.rcApi = await ApiPromise.create({ provider: rcProvider });
          } catch (_) {}
        }
      });
      rcProvider.on('error', (e) => console.error('[Chain] RC error:', e.message));
      this.rcApi = await Promise.race([
        ApiPromise.create({ provider: rcProvider }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('RC connect timeout')), 15_000)),
      ]);
      console.log(`[Chain] Relay Chain connected: ${this.rcRpc}`);
    } catch (e) {
      console.warn(`[Chain] Relay Chain connection failed (${e.message}) — session keys unavailable`);
    }

    await this._notifyOnline();
  }

  async disconnect() {
    this._stopHeartbeat();
    for (const unsub of this._unsubs) { try { unsub(); } catch (_) {} }
    if (this.rcApi) await this.rcApi.disconnect().catch(() => {});
    if (this.api)   await this.api.disconnect();
  }

  // ── Start ─────────────────────────────────────────────────────────────────────

  async startMonitoring() {
    await this._subscribeNewBlocks();
    await this._subscribeEvents();
    await this._startHeartbeat();
    await this._loadRecentPayouts();
    this._startNodeHealthCheck();
    console.log('[Monitor] All subscriptions active.');
  }

  // ── Block subscription ────────────────────────────────────────────────────────

  async _subscribeNewBlocks() {
    const unsub = await this.api.rpc.chain.subscribeNewHeads(async (header) => {
      this._lastBlock = Date.now();
      const blockNum  = header.number.toNumber();
      if (this._wasOnline === false || this._wasOnline === null) await this._notifyOnline();
      await this._checkActiveSet(blockNum);
      await this._checkNominators();
      await this._checkSessionKeys();
      await this._checkOversubscribed();
    });
    this._unsubs.push(unsub);
  }

  // ── Event subscription ────────────────────────────────────────────────────────

  async _subscribeEvents() {
    const unsub = await this.api.query.system.events(async (events) => {
      for (const { event } of events) {
        const { section, method, data } = event;

        if (section === 'staking' && method === 'Rewarded') {
          const [stash, , amount] = data;
          if (stash.toString() === this.addr) {
            const amtStr = toToken(amount.toString(), this.decimals);
            const era    = await this._currentEra();
            await this.state.set('last_payout_era', era);
            await this._savePayoutHistory(era, amtStr);
            await this.notifier.payoutReceived(this.addr, era, amtStr, this.token);
          }
        }

        if (section === 'staking' && method === 'Slashed') {
          const [stash, amount] = data;
          if (stash.toString() === this.addr) {
            await this.notifier.validatorSlashed(this.addr, toToken(amount.toString(), this.decimals), this.token);
          }
        }

        if (section === 'staking' && method === 'Chilled') {
          const [stash] = data;
          if (stash.toString() === this.addr) await this.notifier.validatorChilled(this.addr);
        }

        if (section === 'session' && method === 'NewSession') {
          const [sessionIndex] = data;
          await this._handleNewSession(sessionIndex.toNumber());
        }
      }
    });
    this._unsubs.push(unsub);
  }

  // ── Active / Inactive ─────────────────────────────────────────────────────────

  async _checkActiveSet(blockNum) {
    if (blockNum % 100 !== 0 && blockNum % 100 !== 1) return;
    const era      = await this._currentEra();
    const exposure = await this._getExposure(era);
    const isActive = exposure ? !exposure.total.isZero() : false;

    const prevActive = await this.state.get('is_active', null);
    if (prevActive === null) {
      await this.state.set('is_active', isActive);
      await this.state.set('last_era', era);
      return;
    }
    const prevEra = await this.state.get('last_era', 0);
    if (era !== prevEra || isActive !== prevActive) {
      await this.state.set('is_active', isActive);
      await this.state.set('last_era', era);
      if (isActive && !prevActive)  await this.notifier.validatorActive(this.addr, era);
      if (!isActive && prevActive)  await this.notifier.validatorInactive(this.addr, era);
    }
  }

  // ── Nominator monitoring ──────────────────────────────────────────────────────
  //
  // Active nominators (erasStakers) — checked every nomCheckMs, updates display cache only.
  // Full pool diff (staking.nominators + ledger.active) — every pendingCheckMs, fires alerts.
  // Pool uses ledger.active for ALL nominators so totals are consistent.

  async _checkNominators() {
    const now = Date.now();

    const lastActive = await this.state.get('nominators_last_check', 0);
    if (now - lastActive >= this.nomCheckMs) {
      await this.state.set('nominators_last_check', now);
      await this._checkActiveNominators();
    }

    const lastPending = await this.state.get('pending_noms_last_check', 0);
    if (now - lastPending >= this.pendingCheckMs) {
      await this.state.set('pending_noms_last_check', now);
      await this._checkPendingNominators();
    }
  }

  /** Updates the active nominator display cache from erasStakers. No alerts fired here. */
  async _checkActiveNominators() {
    const era = await this._currentEra();
    let exposure;
    try { exposure = await this._getExposure(era); }
    catch (e) { console.error('[Nominators/Active] Error:', e.message); return; }
    if (!exposure) return;

    const currentNoms = {};
    for (const { who, value } of exposure.others) currentNoms[who.toString()] = value.toString();
    await this.state.set('nominators_active', currentNoms);
    await this.state.set('nominators', currentNoms);
  }

  /**
   * Full pool diff — scans staking.nominators for all addresses targeting this validator,
   * reads ledger.active (full bonded amount) for each, then diffs against the saved pool.
   * Alerts are sent only when change exceeds minStakeChange.
   * Own stake (validator's self-bond) is included in total calculations.
   */
  async _checkPendingNominators() {
    console.log('[Nominators] Running full pool scan…');

    // Own stake — validator's self-bond, always included in total
    let ownStake = 0;
    try {
      let ledger = await this.api.query.staking.ledger(this.addr);
      if (ledger.isNone) {
        const bonded = await this.api.query.staking.bonded(this.addr);
        if (bonded.isSome) ledger = await this.api.query.staking.ledger(bonded.unwrap());
      }
      if (ledger.isSome) ownStake = toFloat(ledger.unwrap().active.toString(), this.decimals);
    } catch (_) {}

    // Scan all nominators
    let allNomEntries;
    try { allNomEntries = await this.api.query.staking.nominators.entries(); }
    catch (e) { console.error('[Nominators] Scan error:', e.message); return; }

    const nomAddrs = [];
    for (const [key, nomOpt] of allNomEntries) {
      if (nomOpt.isNone) continue;
      const targets = nomOpt.unwrap().targets.map(t => t.toString());
      if (targets.includes(this.addr)) nomAddrs.push(key.args[0].toString());
    }

    // Fetch ledger.active for every nominator in batches of 20
    const BATCH = 20;
    const currentPool = {};  // addr -> token string (ledger.active)
    for (let i = 0; i < nomAddrs.length; i += BATCH) {
      const batch   = nomAddrs.slice(i, i + BATCH);
      const results = await Promise.all(batch.map(async (addr) => {
        try {
          let nl = await this.api.query.staking.ledger(addr);
          if (nl.isNone) {
            const nb = await this.api.query.staking.bonded(addr);
            if (nb.isSome) nl = await this.api.query.staking.ledger(nb.unwrap());
          }
          return { addr, amount: nl.isSome ? toToken(nl.unwrap().active.toString(), this.decimals) : '0' };
        } catch (_) { return { addr, amount: '0' }; }
      }));
      for (const { addr, amount } of results) currentPool[addr] = amount;
    }

    await this.state.set('nominators_pending', currentPool);

    // Bootstrap — save baseline silently on first run
    const bootstrapped = await this.state.get('pool_bootstrapped', false);
    if (!bootstrapped) {
      await this.state.set('nominators_pool', currentPool);
      await this.state.set('pool_bootstrapped', true);
      console.log(`[Nominators] Bootstrap: ${nomAddrs.length} nominators, own stake: ${ownStake.toFixed(4)} ${this.token}`);
      return;
    }

    const prevPool = await this.state.get('nominators_pool', {}) || {};

    // Calculate totals including own stake
    const calcTotal = (pool) =>
      ownStake + Object.values(pool).reduce((s, v) => s + toFloat(v, this.decimals), 0);

    const prevTotal = calcTotal(prevPool);

    const allAddrs = new Set([...Object.keys(currentPool), ...Object.keys(prevPool)]);
    let changed = false;

    for (const nomAddr of allAddrs) {
      const curr = currentPool[nomAddr];
      const prev = prevPool[nomAddr];

      if (curr && !prev) {
        const stake = toFloat(curr, this.decimals);
        if (stake < this.minStakeChange) continue;
        changed = true;
        const newTotal = calcTotal(currentPool);
        const delta    = newTotal - prevTotal;
        await this.notifier.nominatorJoined(nomAddr, stake.toFixed(4), newTotal.toFixed(4), delta.toFixed(4), this.token);

      } else if (!curr && prev) {
        const stake = toFloat(prev, this.decimals);
        if (stake < this.minStakeChange) continue;
        changed = true;
        const newTotal = calcTotal(currentPool);
        const delta    = newTotal - prevTotal;
        await this.notifier.nominatorLeft(nomAddr, stake.toFixed(4), newTotal.toFixed(4), delta.toFixed(4), this.token);

      } else if (curr && prev) {
        const oldAmt = toFloat(prev, this.decimals);
        const newAmt = toFloat(curr, this.decimals);
        const diff   = Math.abs(newAmt - oldAmt);
        if (diff < this.minStakeChange) continue;
        changed = true;
        const newTotal = calcTotal(currentPool);
        const delta    = newTotal - prevTotal;
        await this.notifier.nominatorStakeChanged(nomAddr, oldAmt.toFixed(4), newAmt.toFixed(4), newTotal.toFixed(4), delta.toFixed(4), this.token);
      }
    }

    if (changed) await this.state.set('nominators_pool', currentPool);
    const total = calcTotal(currentPool);
    console.log(`[Nominators] Done: ${nomAddrs.length} nominators, total bonded: ${total.toFixed(4)} ${this.token}`);
  }

  // ── Oversubscribed ────────────────────────────────────────────────────────────

  async _checkOversubscribed() {
    const now      = Date.now();
    const lastCheck = await this.state.get('oversub_last_check', 0);
    if (now - lastCheck < 30 * 60_000) return;
    await this.state.set('oversub_last_check', now);

    const era      = await this._currentEra();
    const exposure = await this._getExposure(era);
    if (!exposure) return;

    const count  = exposure.others.length;
    const wasOver = await this.state.get('is_oversubscribed', false);
    const isOver  = count > this.oversubLimit;

    if (isOver && !wasOver)  await this.notifier.oversubscribed(this.addr, count, this.oversubLimit);
    if (!isOver && wasOver)  await this.notifier.oversubscribedResolved(this.addr, count, this.oversubLimit);
    await this.state.set('is_oversubscribed', isOver);
  }

  // ── Session keys ──────────────────────────────────────────────────────────────

  async _checkSessionKeys() {
    const now      = Date.now();
    const lastCheck = await this.state.get('keys_last_check', 0);
    if (now - lastCheck < this.keyCheckMs) return;
    await this.state.set('keys_last_check', now);
    if (!this.rcApi) return;
    try {
      const newKeys = await this._fetchSessionKeys();
      if (!newKeys) return;
      const prevKeys = await this.state.get('session_keys', null);
      if (prevKeys === null) { await this.state.set('session_keys', newKeys); return; }
      if (newKeys !== prevKeys) {
        await this.notifier.sessionKeysChanged(this.addr, prevKeys, newKeys);
        await this.state.set('session_keys', newKeys);
      }
    } catch (e) { console.error('[Keys] Error:', e.message); }
  }

  async _handleNewSession(sessionIndex) {
    const now      = Date.now();
    const lastCheck = await this.state.get('keys_last_check', 0);
    if (now - lastCheck < 60 * 60_000) return;
    await this.state.set('keys_last_check', now);
    if (!this.rcApi) return;
    try {
      const newKeys  = await this._fetchSessionKeys();
      if (!newKeys) return;
      const prevKeys = await this.state.get('session_keys', null);
      if (prevKeys === null) { await this.state.set('session_keys', newKeys); return; }
      if (newKeys !== prevKeys) {
        await this.notifier.sessionKeysChanged(this.addr, prevKeys, newKeys);
        await this.state.set('session_keys', newKeys);
      }
    } catch (e) { console.error('[Keys] NewSession error:', e.message); }
  }

  async _fetchSessionKeys() {
    const nextOpt = await this.rcApi.query.session.nextKeys(this.addr).catch(() => null);
    if (nextOpt && nextOpt.isSome) return nextOpt.unwrap().toHex();
    const queued = await this.rcApi.query.session.queuedKeys().catch(() => []);
    const entry  = queued.find(([id]) => id.toString() === this.addr);
    return entry ? entry[1].toHex() : null;
  }

  // ── Payout history ────────────────────────────────────────────────────────────

  async _savePayoutHistory(era, amount) {
    const history = await this.state.get('payout_history', []) || [];
    history.unshift({ era, amount, ts: Date.now() });
    if (history.length > 10) history.splice(10);
    await this.state.set('payout_history', history);
  }

  async _loadRecentPayouts() {
    if (await this.state.get('payouts_bootstrapped', false)) return;
    try {
      const currentEra = await this._currentEra();
      const history    = [];
      for (let e = currentEra - 1; e >= Math.max(0, currentEra - 5); e--) {
        const reward = await this.api.query.staking.erasValidatorReward(e).catch(() => null);
        if (!reward || !reward.isSome) continue;
        const pts   = await this.api.query.staking.erasRewardPoints(e).catch(() => null);
        if (!pts) continue;
        const myPts = pts.individual.get ? pts.individual.get(this.addr) : null;
        if (!myPts || myPts.toNumber() === 0) continue;
        const totalPts = pts.total.toNumber();
        const totalRew = BigInt(reward.unwrap().toString());
        const myRew    = totalPts > 0 ? (totalRew * BigInt(myPts.toNumber())) / BigInt(totalPts) : 0n;
        history.push({ era: e, amount: toToken(myRew.toString(), this.decimals), ts: null });
      }
      if (history.length > 0) {
        await this.state.set('payout_history', history);
        await this.state.set('last_payout_era', history[0].era);
        console.log(`[Payouts] Loaded ${history.length} historical eras`);
      }
    } catch (e) { console.error('[Payouts] History load error:', e.message); }
    await this.state.set('payouts_bootstrapped', true);
  }

  // ── Heartbeat ─────────────────────────────────────────────────────────────────

  async _startHeartbeat() {
    this._stopHeartbeat();
    this._heartbeatTimer = setInterval(async () => {
      const elapsed = Date.now() - this._lastBlock;
      if (elapsed > this.heartbeatMs * 2) {
        this._offlineStrikes++;
        this._onlineStrikes = 0;
        if (this._offlineStrikes >= this.offlineThreshold) await this._handleOffline();
        else console.log(`[Heartbeat] No block for ${Math.round(elapsed / 1000)}s (strike ${this._offlineStrikes}/${this.offlineThreshold})`);
      } else {
        this._offlineStrikes = 0;
      }
    }, this.heartbeatMs);
  }

  _stopHeartbeat() {
    if (this._heartbeatTimer) { clearInterval(this._heartbeatTimer); this._heartbeatTimer = null; }
  }

  // ── Node HTTP health check ────────────────────────────────────────────────────

  _startNodeHealthCheck() {
    if (!this.nodeRpc) {
      console.log('[NodeHealth] NODE_RPC_ENDPOINT not set — healthcheck disabled');
      return;
    }
    console.log(`[NodeHealth] Polling ${this.nodeRpc} every ${this.nodeHealthMs / 1000}s`);
    const check = async () => {
      try {
        const res  = await fetch(this.nodeRpc, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: 1, jsonrpc: '2.0', method: 'system_health', params: [] }),
          signal: AbortSignal.timeout(5_000),
        });
        const { result } = await res.json();
        const healthy = result && result.peers > 0 && !result.shouldHavePeers === false;
        // peers=0 counts as offline; isSyncing does NOT
        const isDown = !result || result.peers === 0;
        if (isDown) {
          this._nodeOnStrikes  = 0;
          this._nodeOffStrikes++;
          if (this._nodeOffStrikes >= this.offlineThreshold && this._nodeOnline !== false) {
            this._nodeOnline = false;
            console.warn('[NodeHealth] Node OFFLINE (peers=0 or unreachable)');
            await this.notifier.nodeOffline?.();
          }
        } else {
          this._nodeOffStrikes = 0;
          this._nodeOnStrikes++;
          if (this._nodeOnStrikes >= this.onlineThreshold && this._nodeOnline !== true) {
            const wasOffline = this._nodeOnline === false;
            this._nodeOnline = true;
            console.log(`[NodeHealth] Node online — peers: ${result.peers}`);
            if (wasOffline) await this.notifier.nodeOnline?.();
          }
          this._nodeOnline = true;
        }
        this._nodeLastPeers = result?.peers ?? null;
      } catch (_) {
        this._nodeOnStrikes  = 0;
        this._nodeOffStrikes++;
        if (this._nodeOffStrikes >= this.offlineThreshold && this._nodeOnline !== false) {
          this._nodeOnline = false;
          console.warn('[NodeHealth] Node unreachable');
          await this.notifier.nodeOffline?.();
        }
      }
    };
    check();
    this._nodeHealthTimer = setInterval(check, this.nodeHealthMs);
  }

  async _notifyOnline() {
    if (this._wasOnline === true) return;
    this._onlineStrikes++;
    if (this._onlineStrikes < this.onlineThreshold) {
      console.log(`[Heartbeat] Block received (${this._onlineStrikes}/${this.onlineThreshold} confirmations)`);
      return;
    }
    this._onlineStrikes  = 0;
    this._offlineStrikes = 0;
    if (this._wasOnline === false) await this.notifier.reconnected(this.rpc);
    await this.notifier.validatorOnline(this.addr, this.network);
    this._wasOnline = true;
  }

  async _handleOffline() {
    if (this._wasOnline !== false) {
      this._wasOnline = false;
      await this.notifier.validatorOffline(this.addr, this.network);
    }
  }

  // ── /status ───────────────────────────────────────────────────────────────────

  async getStatus() {
    if (!this.api) return `⏳ Connecting to chain, please try again in a few seconds…`;
    const Notifier = require('./notifier');

    const [era, header] = await Promise.all([
      this._currentEra(),
      this.api.rpc.chain.getHeader(),
    ]);
    const blockNumber = header.number.toNumber();

    let exposure = null;
    try { exposure = await this._getExposure(era); } catch (_) {}
    const isActive = exposure ? !exposure.total.isZero() : false;

    // Own bonded stake
    let ownStake    = '0';
    let ownStakeNum = 0;
    try {
      let ledger = await this.api.query.staking.ledger(this.addr);
      if (ledger.isNone) {
        const bonded = await this.api.query.staking.bonded(this.addr);
        if (bonded.isSome) ledger = await this.api.query.staking.ledger(bonded.unwrap());
      }
      if (ledger.isSome) {
        ownStake    = toToken(ledger.unwrap().active.toString(), this.decimals);
        ownStakeNum = parseFloat(ownStake);
      }
    } catch (_) {}

    // Active nominators from erasStakers (for display/top list only)
    let activeNoms = [];
    let eraTotal   = ownStake;
    if (exposure && !exposure.total.isZero()) {
      activeNoms = exposure.others.map(n => ({
        addr: n.who.toString(), amount: toToken(n.value.toString(), this.decimals),
      }));
      eraTotal = toToken(exposure.total.toString(), this.decimals);
    }

    const topNominators  = [...activeNoms].sort((a, b) => parseFloat(b.amount) - parseFloat(a.amount)).slice(0, 5);
    const nominatorCount = activeNoms.length;
    const pendingCount   = Object.keys(await this.state.get('nominators_pending', {}) || {}).length;

    // Full pool total (own stake + all nominators' ledger.active)
    const poolMap    = await this.state.get('nominators_pool', {}) || {};
    const activeMap  = await this.state.get('nominators_active', {}) || {};
    const pendingMap = await this.state.get('nominators_pending', {}) || {};
    const mergedMap  = Object.keys(poolMap).length > 0 ? poolMap : { ...activeMap, ...pendingMap };
    const allNomCount = Object.keys(mergedMap).length;

    const poolTotal = allNomCount > 0
      ? (ownStakeNum + Object.values(mergedMap).reduce((s, v) => s + toFloat(v, this.decimals), 0)).toFixed(4)
      : null;

    // Session keys
    let sessionKeys = null, sessionKeysNote = null;
    try {
      if (!this.rcApi) {
        sessionKeysNote = 'no Relay Chain connection';
      } else {
        sessionKeys = await this._fetchSessionKeys();
        if (sessionKeys) {
          const prev = await this.state.get('session_keys', null);
          if (prev !== sessionKeys) {
            if (prev) await this.notifier.sessionKeysChanged(this.addr, prev, sessionKeys);
            await this.state.set('session_keys', sessionKeys);
          }
        } else {
          sessionKeysNote = 'not set';
        }
      }
    } catch (e) { console.error('[Status] Session keys error:', e.message); }

    const payoutHistory = await this.state.get('payout_history', []) || [];
    const lastPayoutEra = await this.state.get('last_payout_era', null);

    const uptimeMs    = Date.now() - this._startTime;
    const uptimeHours = Math.floor(uptimeMs / 3_600_000);
    const uptimeMins  = Math.floor((uptimeMs % 3_600_000) / 60_000);
    const uptimeLabel = uptimeHours > 0 ? `${uptimeHours}h ${uptimeMins}m` : `${uptimeMins}m`;

    const isOver = exposure ? exposure.others.length > this.oversubLimit : false;

    return Notifier.formatStatus({
      network: this.network, address: this.addr,
      online:  this._wasOnline !== false, active: isActive,
      era, blockNumber, token: this.token,
      ownStake, eraTotal, poolTotal,
      nominatorCount, allNomCount, pendingCount,
      topNominators, sessionKeys, sessionKeysNote,
      lastPayoutEra, payoutHistory,
      uptimeLabel, isOversubscribed: isOver,
      oversubLimit: this.oversubLimit,
      nodeRpcConfigured: !!this.nodeRpc,
      nodeOnline: this._nodeOnline,
      nodePeers:  this._nodeLastPeers ?? null,
    });
  }

  // ── Helpers ───────────────────────────────────────────────────────────────────

  async _getExposure(era) {
    if (this.api.query.staking.erasStakersPaged) {
      const overview = await this.api.query.staking.erasStakersOverview(era, this.addr).catch(() => null);
      if (!overview || overview.isNone) return null;
      const ov        = overview.unwrap();
      const pageCount = ov.pageCount.toNumber();
      const pages     = await Promise.all(
        Array.from({ length: pageCount }, (_, i) =>
          this.api.query.staking.erasStakersPaged(era, this.addr, i).catch(() => null)
        )
      );
      const others = [];
      for (const page of pages) {
        if (!page || page.isNone) continue;
        for (const item of page.unwrap().others) others.push(item);
      }
      const totalBn = BigInt(ov.total.toString());
      const ownBn   = BigInt(ov.own.toString());
      return {
        total:  { isZero: () => totalBn === 0n, toString: () => totalBn.toString() },
        own:    { isZero: () => ownBn === 0n,   toString: () => ownBn.toString() },
        others,
      };
    }
    if (this.api.query.staking.erasStakers) {
      const exp     = await this.api.query.staking.erasStakers(era, this.addr);
      const others  = typeof exp.others.toArray === 'function' ? exp.others.toArray() : [...exp.others];
      const totalBn = BigInt(exp.total.toString());
      const ownBn   = BigInt(exp.own.toString());
      return {
        total:  { isZero: () => totalBn === 0n, toString: () => totalBn.toString() },
        own:    { isZero: () => ownBn === 0n,   toString: () => ownBn.toString() },
        others,
      };
    }
    return null;
  }

  async _currentEra() {
    const era = await this.api.query.staking.currentEra();
    return era.isSome ? era.unwrap().toNumber() : 0;
  }
}

module.exports = { ChainWatcher, toToken, toFloat };
