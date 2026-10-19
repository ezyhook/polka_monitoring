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
  const factor = 10n ** BigInt(decimals);
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

const { Lock } = require('./lock');

const PERBILL = 1_000_000_000n;

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
    this._blockBusy       = false;
    this.offlineThreshold = opts.offlineThreshold || 3;
    this.onlineThreshold  = opts.onlineThreshold  || 2;

    // Full nominator scan — shared by the periodic check and /update, /nominators
    this.poolLock = new Lock('Nominator scan');

    // Node HTTP health check (optional — disabled if nodeRpcEndpoint is empty)
    this.nodeRpc              = opts.nodeRpcEndpoint || '';
    this.nodeHealthMs         = opts.nodeHealthInterval   || 60_000;
    this.nodeOfflineThreshold = opts.nodeOfflineThreshold || this.offlineThreshold;
    this.nodeOnlineThreshold  = opts.nodeOnlineThreshold  || this.onlineThreshold;
    this.nodeSyncThreshold    = opts.nodeSyncThreshold    || 5;
    this._nodeState       = null;   // null (unknown) | 'online' | 'syncing' | 'offline'
    this._nodeCandidate   = null;   // state being confirmed by consecutive checks
    this._nodeStrikes     = 0;
    this._nodeLastPeers   = null;
    this._nodeHealthTimer = null;
  }

  // ── Connection ────────────────────────────────────────────────────────────────

  async connect() {
    console.log(`[Chain] Connecting to Asset Hub: ${this.rpc}`);
    const provider = new WsProvider(this.rpc, 5_000);
    // Disconnects are handled by the heartbeat (strike-based), not here —
    // WsProvider reconnects on its own and a short blip shouldn't alert.
    provider.on('disconnected', () => console.warn('[Chain] AH disconnected'));
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

    // Relay Chain — a single ApiPromise; WsProvider reconnects it automatically,
    // so we only check rcApi.isConnected before use instead of recreating it.
    const rcProvider = new WsProvider(this.rcRpc, 5_000);
    rcProvider.on('disconnected', () => console.warn('[Chain] RC disconnected — session keys unavailable until reconnected'));
    rcProvider.on('connected',    () => console.log('[Chain] RC connected'));
    rcProvider.on('error',        (e) => console.error('[Chain] RC error:', e.message));
    const rcReady = ApiPromise.create({ provider: rcProvider }).then((api) => {
      this.rcApi = api;
      console.log(`[Chain] Relay Chain ready: ${this.rcRpc}`);
      return api;
    });
    rcReady.catch((e) => console.warn(`[Chain] Relay Chain init failed (${e.message}) — session keys unavailable`));
    await Promise.race([
      rcReady,
      new Promise((_, rej) => setTimeout(() => rej(new Error('RC connect timeout — will keep trying in background')), 15_000)),
    ]).catch((e) => console.warn(`[Chain] ${e.message}`));

    await this._notifyOnline();
  }

  _rcAvailable() {
    return !!(this.rcApi && this.rcApi.isConnected);
  }

  async disconnect() {
    this._stopHeartbeat();
    if (this._nodeHealthTimer) { clearInterval(this._nodeHealthTimer); this._nodeHealthTimer = null; }
    for (const unsub of this._unsubs) { try { unsub(); } catch (_) {} }
    if (this.rcApi) await this.rcApi.disconnect().catch(() => {});
    if (this.api)   await this.api.disconnect().catch(() => {});
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
    // polkadot.js does not await subscription callbacks — every async handler
    // must catch its own errors, otherwise a transient RPC error becomes an
    // unhandled rejection and kills the process.
    const unsub = await this.api.rpc.chain.subscribeNewHeads((header) => {
      this._lastBlock = Date.now();
      this._onNewBlock(header.number.toNumber())
        .catch(e => console.error('[Block] Handler error:', e.message));
    });
    this._unsubs.push(unsub);
  }

  async _onNewBlock(blockNum) {
    if (this._wasOnline !== true) await this._notifyOnline();
    if (this._blockBusy) return;   // previous block's checks still running — skip
    this._blockBusy = true;
    try {
      await this._safe('ActiveSet',  () => this._checkActiveSet(blockNum));
      await this._safe('Nominators', () => this._checkNominators());
      await this._safe('Keys',       () => this._checkSessionKeys());
    } finally {
      this._blockBusy = false;
    }
  }

  async _safe(name, fn) {
    try { await fn(); }
    catch (e) { console.error(`[${name}] Error:`, e.message); }
  }

  // ── Event subscription ────────────────────────────────────────────────────────

  async _subscribeEvents() {
    const unsub = await this.api.query.system.events((events) => {
      this._onEvents(events).catch(e => console.error('[Events] Handler error:', e.message));
    });
    this._unsubs.push(unsub);
  }

  async _onEvents(events) {
    // Rewarded carries no era — take it from the PayoutStarted that precedes it
    // in the same block (one PayoutStarted per payout_stakers page).
    let payoutEra = null;

    for (const { event } of events) {
      const { section, method, data } = event;
      try {
        if (section === 'staking' && method === 'PayoutStarted') {
          // (era_index, validator_stash, page, next)
          payoutEra = data[1].toString() === this.addr ? data[0].toNumber() : null;
        }

        if (section === 'staking' && method === 'Rewarded') {
          const [stash, , amount] = data;
          if (stash.toString() === this.addr) {
            let era = payoutEra;
            if (era == null) {
              era = (await this._activeEra()) - 1;
              console.warn(`[Payouts] Rewarded without PayoutStarted — assuming era ${era}`);
            }
            const amtStr  = toToken(amount.toString(), this.decimals);
            const eraTotal = await this._recordPayout(era, amtStr);
            await this.notifier.payoutReceived(this.addr, era, amtStr, eraTotal, this.token);
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
          await this._handleNewSession();
        }
      } catch (e) {
        console.error(`[Events] ${section}.${method} error:`, e.message);
      }
    }
  }

  // ── Active / Inactive ─────────────────────────────────────────────────────────

  async _checkActiveSet(blockNum) {
    if (blockNum % 100 !== 0 && blockNum % 100 !== 1) return;
    const era      = await this._activeEra();
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
    if (now - lastPending >= this.pendingCheckMs && !this.poolLock.busy) {
      await this.state.set('pending_noms_last_check', now);
      // Detached: the scan takes ~1 min and must not hold up block handling
      this.scanPool().catch(e => console.error('[Nominators] Scan error:', e.message));
    }
  }

  /** Updates the active nominator display cache from erasStakers. No alerts fired here. */
  async _checkActiveNominators() {
    const era      = await this._activeEra();
    const exposure = await this._getExposure(era);
    if (!exposure) return;

    const currentNoms = {};
    for (const { who, value } of exposure.others) currentNoms[who.toString()] = value.toString();
    await this.state.set('nominators_active', currentNoms);
  }

  /** ledger.active for a stash (or its controller) as a token string; throws on RPC error. */
  async _ledgerActive(addr) {
    let ledger = await this.api.query.staking.ledger(addr);
    if (ledger.isNone) {
      const bonded = await this.api.query.staking.bonded(addr);
      if (bonded.isSome) ledger = await this.api.query.staking.ledger(bonded.unwrap());
    }
    return ledger.isSome ? toToken(ledger.unwrap().active.toString(), this.decimals) : '0';
  }

  /** Own self-bond as a float, 0 if it can't be read. */
  async _ownStake() {
    try { return parseFloat(await this._ledgerActive(this.addr)); }
    catch (e) { console.error('[Stake] Own ledger error:', e.message); return 0; }
  }

  /**
   * Full pool scan — finds every nominator targeting this validator, reads
   * ledger.active for each and diffs against the alert baseline.
   * Throws BusyError if a scan is already running; onStart is called once the lock is held.
   *
   * @returns {{ activeNoms, pendingNoms, grandTotal, failed }}
   */
  scanPool(onStart) {
    return this.poolLock.run(async () => {
      if (onStart) await onStart();
      return this._scanPool();
    });
  }

  async _scanPool() {
    console.log('[Nominators] Running full pool scan…');

    const era       = await this._activeEra();
    const exposure  = await this._getExposure(era);
    const activeSet = new Set(exposure ? exposure.others.map(n => n.who.toString()) : []);
    const ownStake  = await this._ownStake();

    // If this throws, the scan is aborted and saved state stays untouched —
    // writing an empty pool would make the next scan report everyone as "new".
    const allNomEntries = await this.api.query.staking.nominators.entries();
    const nomAddrs = [];
    for (const [key, nomOpt] of allNomEntries) {
      if (nomOpt.isNone) continue;
      if (nomOpt.unwrap().targets.some(t => t.toString() === this.addr)) nomAddrs.push(key.args[0].toString());
    }

    const prevPool = await this.state.get('nominators_pool', {}) || {};

    // Fetch ledger.active in batches. A failed query must not be read as "0" —
    // that produced false "stake dropped to 0" alerts. Carry the previous value instead.
    const BATCH = 20;
    const currentPool = {};
    const failed = [];
    for (let i = 0; i < nomAddrs.length; i += BATCH) {
      const batch = nomAddrs.slice(i, i + BATCH);
      await Promise.all(batch.map(async (addr) => {
        try { currentPool[addr] = await this._ledgerActive(addr); }
        catch (_) { failed.push(addr); }
      }));
    }
    const maxFailed = Math.max(5, Math.ceil(nomAddrs.length * 0.1));
    if (failed.length > maxFailed) {
      throw new Error(`Nominator scan aborted: ${failed.length}/${nomAddrs.length} ledger queries failed`);
    }
    if (failed.length > 0) console.warn(`[Nominators] ${failed.length} ledger queries failed — keeping previous values`);
    for (const addr of failed) {
      if (prevPool[addr] !== undefined) currentPool[addr] = prevPool[addr];
    }

    const sum       = (pool) => Object.values(pool).reduce((s, v) => s + toFloat(v, this.decimals), 0);
    const poolTotal = (ownStake + sum(currentPool)).toFixed(4);

    const waiting = {};
    for (const [addr, amt] of Object.entries(currentPool)) if (!activeSet.has(addr)) waiting[addr] = amt;
    await this.state.set('nominators_current', currentPool);
    await this.state.set('nominators_pending', waiting);

    const bootstrapped = await this.state.get('pool_bootstrapped', false);
    if (!bootstrapped) {
      // First run — save baseline silently
      await this.state.set('nominators_pool', currentPool);
      await this.state.set('pool_bootstrapped', true);
      console.log(`[Nominators] Bootstrap: ${nomAddrs.length} nominators, own stake: ${ownStake.toFixed(4)} ${this.token}`);
    } else {
      // Alert baseline is updated per nominator only when an alert fires, so
      // small changes accumulate until they cross minStakeChange.
      const baseline = { ...prevPool };
      const alerts   = [];
      for (const addr of new Set([...Object.keys(currentPool), ...Object.keys(prevPool)])) {
        const curr = currentPool[addr];
        const prev = prevPool[addr];

        if (curr !== undefined && prev === undefined) {
          const stake = toFloat(curr, this.decimals);
          if (stake < this.minStakeChange) continue;   // tracked once it grows past the threshold
          baseline[addr] = curr;
          alerts.push(() => this.notifier.nominatorJoined(addr, stake.toFixed(4), poolTotal, this.token));

        } else if (curr === undefined && prev !== undefined) {
          delete baseline[addr];
          const stake = toFloat(prev, this.decimals);
          if (stake < this.minStakeChange) continue;
          alerts.push(() => this.notifier.nominatorLeft(addr, stake.toFixed(4), poolTotal, this.token));

        } else {
          const oldAmt = toFloat(prev, this.decimals);
          const newAmt = toFloat(curr, this.decimals);
          if (Math.abs(newAmt - oldAmt) < this.minStakeChange) continue;
          baseline[addr] = curr;
          alerts.push(() => this.notifier.nominatorStakeChanged(addr, oldAmt.toFixed(4), newAmt.toFixed(4), poolTotal, this.token));
        }
      }
      // Persist before sending, so a crash mid-way can't re-send the same alerts
      await this.state.set('nominators_pool', baseline);
      for (const send of alerts) await send();
    }

    const toList = (addrs) => addrs.map(addr => ({ addr, amount: currentPool[addr] }));
    const activeAddrs = Object.keys(currentPool).filter(a => activeSet.has(a));
    console.log(`[Nominators] Done: ${nomAddrs.length} nominators (${activeAddrs.length} active), total bonded: ${poolTotal} ${this.token}`);
    return {
      activeNoms:  toList(activeAddrs),
      pendingNoms: toList(Object.keys(waiting)),
      grandTotal:  poolTotal,
      failed:      failed.length,
    };
  }

  // ── Session keys ──────────────────────────────────────────────────────────────

  async _checkSessionKeys() {
    const now      = Date.now();
    const lastCheck = await this.state.get('keys_last_check', 0);
    if (now - lastCheck < this.keyCheckMs) return;
    await this.state.set('keys_last_check', now);
    await this._refreshSessionKeys();
  }

  async _handleNewSession() {
    const now      = Date.now();
    const lastCheck = await this.state.get('keys_last_check', 0);
    if (now - lastCheck < 60 * 60_000) return;
    await this.state.set('keys_last_check', now);
    await this._refreshSessionKeys();
  }

  /** Fetch keys from the Relay Chain, alert on change. Returns the keys (or null). */
  async _refreshSessionKeys() {
    if (!this._rcAvailable()) return null;
    const newKeys = await this._fetchSessionKeys();
    if (!newKeys) return null;
    const prevKeys = await this.state.get('session_keys', null);
    if (newKeys !== prevKeys) {
      await this.state.set('session_keys', newKeys);
      if (prevKeys !== null) await this.notifier.sessionKeysChanged(this.addr, prevKeys, newKeys);
    }
    return newKeys;
  }

  async _fetchSessionKeys() {
    const nextOpt = await this.rcApi.query.session.nextKeys(this.addr).catch(() => null);
    if (nextOpt && nextOpt.isSome) return nextOpt.unwrap().toHex();
    const queued = await this.rcApi.query.session.queuedKeys().catch(() => []);
    const entry  = queued.find(([id]) => id.toString() === this.addr);
    return entry ? entry[1].toHex() : null;
  }

  // ── Payout history ────────────────────────────────────────────────────────────
  //
  // History holds the validator's own reward per era (commission + own-stake
  // share) — the same amount Rewarded reports. Paged payouts emit one
  // Rewarded per page, so amounts for the same era are summed.

  /** Add a payout to history, returns the era total so far. */
  async _recordPayout(era, amount) {
    const history = await this.state.get('payout_history', []) || [];
    let entry = history.find(h => h.era === era);
    if (entry) {
      entry.amount = (parseFloat(entry.amount) + parseFloat(amount)).toFixed(4);
      entry.ts     = Date.now();
    } else {
      entry = { era, amount, ts: Date.now() };
      history.push(entry);
    }
    history.sort((a, b) => b.era - a.era);
    history.splice(10);
    await this.state.set('payout_history', history);
    await this.state.set('last_payout_era', history[0].era);
    return entry.amount;
  }

  /**
   * Rebuild history from chain for the last 10 fully-claimed eras.
   * v2: earlier versions stored the validator's whole era share (incl. nominators)
   * and labelled live payouts with currentEra — both wrong, so history is rebuilt once.
   */
  async _loadRecentPayouts() {
    if (await this.state.get('payouts_bootstrapped_v2', false)) return;
    try {
      const activeEra = await this._activeEra();
      const old       = await this.state.get('payout_history', []) || [];
      const history   = [];
      for (let e = activeEra - 1; e >= Math.max(0, activeEra - 10); e--) {
        const amount = await this._eraValidatorPayout(e);
        if (amount == null) continue;
        const amtStr = toToken(amount.toString(), this.decimals);
        // Old entries had the right amount under the wrong era — reuse their timestamp
        const match  = old.find(h => h.amount === amtStr && h.ts);
        history.push({ era: e, amount: amtStr, ts: match ? match.ts : null });
      }
      if (history.length === 0) {
        console.warn('[Payouts] Nothing found on chain — keeping existing history');
      } else {
        await this.state.set('payout_history', history);
        await this.state.set('last_payout_era', history[0].era);
        console.log(`[Payouts] Rebuilt history: ${history.length} eras`);
      }
      await this.state.set('payouts_bootstrapped_v2', true);
    } catch (e) { console.error('[Payouts] History load error:', e.message); }
  }

  /**
   * Validator's own payout for a fully claimed era, in planck:
   *   payout     = eraReward × myPoints / totalPoints
   *   commission = payout × commission%
   *   ownShare   = (payout − commission) × own / total
   * Returns null if the era is not (fully) claimed or we earned nothing.
   */
  async _eraValidatorPayout(era) {
    const q = this.api.query.staking;
    const [reward, pts, ovOpt, claimed, prefs] = await Promise.all([
      q.erasValidatorReward(era),
      q.erasRewardPoints(era),
      q.erasStakersOverview(era, this.addr),
      q.claimedRewards(era, this.addr),
      q.erasValidatorPrefs(era, this.addr),
    ]);
    if (reward.isNone || ovOpt.isNone) return null;
    const ov = ovOpt.unwrap();
    if (claimed.length < ov.pageCount.toNumber()) return null;   // not (fully) paid out

    // individual is a BTreeMap keyed by AccountId objects — Map.get(string) misses
    let myPts = 0n;
    for (const [who, p] of pts.individual) {
      if (who.toString() === this.addr) { myPts = BigInt(p.toString()); break; }
    }
    const totalPts = BigInt(pts.total.toString());
    if (myPts === 0n || totalPts === 0n) return null;

    const payout     = BigInt(reward.unwrap().toString()) * myPts / totalPts;
    const commission = payout * BigInt(prefs.commission.unwrap().toString()) / PERBILL;
    const total      = BigInt(ov.total.toString());
    const own        = BigInt(ov.own.toString());
    const ownShare   = total > 0n ? (payout - commission) * own / total : 0n;
    return commission + ownShare;
  }

  // ── Heartbeat ─────────────────────────────────────────────────────────────────

  async _startHeartbeat() {
    this._stopHeartbeat();
    this._heartbeatTimer = setInterval(() => {
      const elapsed = Date.now() - this._lastBlock;
      if (elapsed > this.heartbeatMs * 2) {
        this._offlineStrikes++;
        this._onlineStrikes = 0;
        if (this._offlineStrikes >= this.offlineThreshold) {
          this._handleOffline(Math.round(elapsed / 1000)).catch(e => console.error('[Heartbeat] Error:', e.message));
        } else {
          console.log(`[Heartbeat] No block for ${Math.round(elapsed / 1000)}s (strike ${this._offlineStrikes}/${this.offlineThreshold})`);
        }
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
    let running = false;
    const check = async () => {
      if (running) return;
      running = true;
      try { await this._checkNodeHealth(); }
      catch (e) { console.error('[NodeHealth] Error:', e.message); }
      finally { running = false; }
    };
    check();
    this._nodeHealthTimer = setInterval(check, this.nodeHealthMs);
  }

  /**
   * One system_health poll. The node state only changes after N consecutive
   * observations of the new state (separate thresholds for offline/syncing/online).
   */
  async _checkNodeHealth() {
    let observed, reason = null, peers = null;
    try {
      const res = await fetch(this.nodeRpc, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 1, jsonrpc: '2.0', method: 'system_health', params: [] }),
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const { result, error } = await res.json();
      if (!result) throw new Error(error?.message || 'empty system_health response');
      peers = result.peers;
      if (result.peers === 0)    { observed = 'offline'; reason = 'no peers'; }
      else if (result.isSyncing) { observed = 'syncing'; }
      else                       { observed = 'online'; }
    } catch (e) {
      observed = 'offline';
      reason   = `unreachable (${e.message})`;
    }
    this._nodeLastPeers = peers;

    if (observed === this._nodeState) { this._nodeCandidate = null; this._nodeStrikes = 0; return; }
    if (observed !== this._nodeCandidate) { this._nodeCandidate = observed; this._nodeStrikes = 0; }
    this._nodeStrikes++;

    const need = observed === 'offline' ? this.nodeOfflineThreshold
               : observed === 'syncing' ? this.nodeSyncThreshold
               : this.nodeOnlineThreshold;
    if (this._nodeStrikes < need) {
      console.log(`[NodeHealth] ${observed}${reason ? ` (${reason})` : ''} — ${this._nodeStrikes}/${need}`);
      return;
    }

    const prev = this._nodeState;
    this._nodeState     = observed;
    this._nodeCandidate = null;
    this._nodeStrikes   = 0;
    console.warn(`[NodeHealth] ${prev ?? 'unknown'} → ${observed}${reason ? ` (${reason})` : ''}`);

    if (observed === 'offline')      await this.notifier.nodeOffline(this.nodeRpc, reason);
    else if (observed === 'syncing') await this.notifier.nodeSyncing(this.nodeRpc, peers);
    else if (prev !== null)          await this.notifier.nodeOnline(this.nodeRpc, peers);
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
    const recovered = this._wasOnline === false;
    this._wasOnline = true;   // set before awaiting so concurrent blocks don't double-send
    console.log(`[Heartbeat] Chain ${recovered ? 'connection restored' : 'online'}`);
    if (recovered) await this.notifier.chainOnline(this.rpc, this.network, true);
  }

  async _handleOffline(silentSec) {
    if (this._wasOnline === false) return;
    this._wasOnline = false;
    await this.notifier.chainOffline(this.rpc, this.network, silentSec);
  }

  // ── /status ───────────────────────────────────────────────────────────────────

  async getStatus() {
    if (!this.api) return `⏳ Connecting to chain, please try again in a few seconds…`;
    const Notifier = require('./notifier');

    const [era, header] = await Promise.all([
      this._activeEra(),
      this.api.rpc.chain.getHeader(),
    ]);
    const blockNumber = header.number.toNumber();

    let exposure = null;
    try { exposure = await this._getExposure(era); } catch (_) {}
    const isActive = exposure ? !exposure.total.isZero() : false;

    // Own bonded stake
    let ownStake = '0';
    try { ownStake = await this._ledgerActive(this.addr); } catch (_) {}
    const ownStakeNum = parseFloat(ownStake);

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

    // Full pool (own stake + all nominators' ledger.active) from the last full scan
    const current  = await this.state.get('nominators_current', null);
    const poolMap  = current || await this.state.get('nominators_pool', {}) || {};
    const allNomCount  = Object.keys(poolMap).length;
    const pendingCount = current ? Object.keys(await this.state.get('nominators_pending', {}) || {}).length : null;
    const poolTotal = allNomCount > 0
      ? (ownStakeNum + Object.values(poolMap).reduce((s, v) => s + toFloat(v, this.decimals), 0)).toFixed(4)
      : null;

    // Session keys
    let sessionKeys = null, sessionKeysNote = null;
    if (!this._rcAvailable()) {
      sessionKeysNote = 'no Relay Chain connection';
    } else {
      try {
        sessionKeys = await this._refreshSessionKeys();
        if (!sessionKeys) sessionKeysNote = 'not set';
      } catch (e) { console.error('[Status] Session keys error:', e.message); }
    }

    const payoutHistory = await this.state.get('payout_history', []) || [];
    const lastPayoutEra = await this.state.get('last_payout_era', null);

    const uptimeMs    = Date.now() - this._startTime;
    const uptimeHours = Math.floor(uptimeMs / 3_600_000);
    const uptimeMins  = Math.floor((uptimeMs % 3_600_000) / 60_000);
    const uptimeLabel = uptimeHours > 0 ? `${uptimeHours}h ${uptimeMins}m` : `${uptimeMins}m`;

    return Notifier.formatStatus({
      network: this.network, address: this.addr,
      online:  this._wasOnline !== false, active: isActive,
      era, blockNumber, token: this.token,
      ownStake, eraTotal, poolTotal,
      nominatorCount, allNomCount, pendingCount,
      topNominators, sessionKeys, sessionKeysNote,
      lastPayoutEra, payoutHistory,
      uptimeLabel,
      exposurePages: exposure ? exposure.pageCount : 0,
      nodeRpcConfigured: !!this.nodeRpc,
      nodeState: this._nodeState,
      nodePeers: this._nodeLastPeers,
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
        pageCount,
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
        pageCount: 1,
      };
    }
    return null;
  }

  /** Era currently being validated. currentEra is the *planned* era and runs ahead after elections. */
  async _activeEra() {
    const ae = await this.api.query.staking.activeEra();
    if (ae.isSome) return ae.unwrap().index.toNumber();
    const era = await this.api.query.staking.currentEra();
    return era.isSome ? era.unwrap().toNumber() : 0;
  }
}

module.exports = { ChainWatcher, toToken, toFloat };
