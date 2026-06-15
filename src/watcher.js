'use strict';

const { ApiPromise, WsProvider } = require('@polkadot/api');

/**
 * Converts a planck value to a human-readable token string.
 * @param {string|BigInt} value   - Raw planck amount
 * @param {number}        decimals - Token decimals (e.g. 10 for DOT)
 * @returns {string} e.g. "1234.5678"
 */
function toToken(value, decimals) {
  const str = value.toString();
  // Already a human-readable token string (contains decimal point) — return as-is
  if (str.includes('.')) return str;
  const n      = BigInt(str);
  const factor = BigInt(10 ** decimals);
  const whole  = n / factor;
  const frac   = n % factor;
  return `${whole}.${frac.toString().padStart(decimals, '0').slice(0, 4)}`;
}

/** Convert any stored value (planck string or token string) to a float. */
function toFloat(value, decimals) {
  const str = value.toString();
  return str.includes('.') ? parseFloat(str) : parseFloat(toToken(str, decimals));
}

/**
 * Normalises a staking exposure object so that total/own always expose
 * isZero() and toString(), regardless of old or new runtime encoding.
 */
function normalizeExposure(exp) {
  const totalBn = BigInt(exp.total.toString());
  const ownBn   = BigInt(exp.own.toString());
  const others  = typeof exp.others.toArray === 'function'
    ? exp.others.toArray() : [...exp.others];
  return {
    total:  { isZero: () => totalBn === 0n, toString: () => totalBn.toString() },
    own:    { isZero: () => ownBn === 0n,   toString: () => ownBn.toString() },
    others,
  };
}

class ChainWatcher {
  /**
   * @param {object} opts
   * @param {string}  opts.rpcEndpoint          - Asset Hub WebSocket RPC URL
   * @param {string}  opts.rcRpcEndpoint         - Relay Chain WebSocket RPC URL (session keys)
   * @param {string}  opts.validatorAddress      - Validator stash address (SS58)
   * @param {object}  opts.state                 - StateManager instance
   * @param {object}  opts.notifier              - Notifier instance
   * @param {string}  opts.network               - Network name for display ('polkadot' | 'kusama' …)
   * @param {number}  opts.heartbeatInterval     - ms between offline checks (default 60 000)
   * @param {number}  opts.nomCheckInterval      - ms between active nominator checks (default 300 000)
   * @param {number}  opts.keyCheckInterval      - ms between session key checks (default 300 000)
   * @param {number}  opts.pendingCheckInterval  - ms between pending nominator scans (default 14 400 000)
   * @param {number}  opts.oversubLimit          - Max nominators before oversubscribed alert (default 512)
   */
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

    this.api     = null;  // Asset Hub API
    this.rcApi   = null;  // Relay Chain API (session keys only)
    this.decimals = 10;
    this.token    = 'DOT';

    this._heartbeatTimer   = null;
    this._lastBlock        = 0;
    this._wasOnline        = null;  // null = unknown, true = online, false = offline
    this._startTime        = Date.now();
    this._unsubs           = [];

    // Debounce counters — state change fires only after N consecutive confirmations
    this._offlineStrikes   = 0;  // consecutive missed heartbeats
    this._onlineStrikes    = 0;  // consecutive received blocks while considered offline
    this.offlineThreshold  = opts.offlineThreshold || 3;  // missed beats before offline alert
    this.onlineThreshold   = opts.onlineThreshold  || 2;  // blocks before online alert
  }

  // ── Connection ────────────────────────────────────────────────────────────────

  async connect() {
    console.log(`[Chain] Connecting to Asset Hub: ${this.rpc}`);
    const provider = new WsProvider(this.rpc, 5_000);

    provider.on('disconnected', () => { console.warn('[Chain] AH disconnected'); this._handleOffline(); });
    provider.on('connected',    () => console.log('[Chain] AH connected'));
    provider.on('error',        (e) => console.error('[Chain] AH error:', e.message));

    this.api = await ApiPromise.create({ provider });

    // Read chain token metadata
    const chainInfo = await this.api.registry.getChainProperties();
    if (chainInfo) {
      const dec     = chainInfo.tokenDecimals.toHuman();
      const sym     = chainInfo.tokenSymbol.toHuman();
      this.decimals = Array.isArray(dec) ? Number(dec[0]) : Number(dec);
      this.token    = Array.isArray(sym) ? sym[0] : sym;
    }
    console.log(`[Chain] Network: ${this.network}, token: ${this.token}, decimals: ${this.decimals}`);

    // Connect to Relay Chain for session key reads
    try {
      const rcProvider = new WsProvider(this.rcRpc, 5_000);
      rcProvider.on('disconnected', () => console.warn('[Chain] RC disconnected — session keys unavailable'));
      rcProvider.on('connected',    () => console.log('[Chain] RC connected'));
      this.rcApi = await ApiPromise.create({ provider: rcProvider });
      console.log(`[Chain] Relay Chain connected: ${this.rcRpc}`);
    } catch (e) {
      console.warn('[Chain] Relay Chain connection failed (session keys unavailable):', e.message);
    }

    await this._notifyOnline();
  }

  async disconnect() {
    this._stopHeartbeat();
    for (const unsub of this._unsubs) { try { unsub(); } catch (_) {} }
    if (this.rcApi) await this.rcApi.disconnect().catch(() => {});
    if (this.api)   await this.api.disconnect();
  }

  // ── Start monitoring ──────────────────────────────────────────────────────────

  async startMonitoring() {
    await this._subscribeNewBlocks();
    await this._subscribeEvents();
    await this._startHeartbeat();
    await this._loadRecentPayouts();
    console.log('[Monitor] All subscriptions active.');
  }

  // ── Block subscription: online/offline + active/inactive ──────────────────────

  async _subscribeNewBlocks() {
    const unsub = await this.api.rpc.chain.subscribeNewHeads(async (header) => {
      this._lastBlock = Date.now();
      const blockNum  = header.number.toNumber();

      if (this._wasOnline === false || this._wasOnline === null) {
        await this._notifyOnline();
      }

      await this._checkActiveSet(blockNum);
      await this._checkNominators();
      await this._checkSessionKeys();
      await this._checkOversubscribed();
    });
    this._unsubs.push(unsub);
  }

  // ── Event subscription: payouts, slashes, chilling, new sessions ───────────────

  async _subscribeEvents() {
    const unsub = await this.api.query.system.events(async (events) => {
      for (const { event } of events) {
        const { section, method, data } = event;

        // Validator reward payout
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

        // Slash event
        if (section === 'staking' && method === 'Slashed') {
          const [stash, amount] = data;
          if (stash.toString() === this.addr) {
            const amtStr = toToken(amount.toString(), this.decimals);
            console.log(`[SLASH] Validator slashed: -${amtStr} ${this.token}`);
            await this.notifier.validatorSlashed(this.addr, amtStr, this.token);
          }
        }

        // Forced chill
        if (section === 'staking' && method === 'Chilled') {
          const [stash] = data;
          if (stash.toString() === this.addr) {
            console.log('[Chill] Validator was forcibly chilled!');
            await this.notifier.validatorChilled(this.addr);
          }
        }

        // New session — check for session key rotation
        if (section === 'session' && method === 'NewSession') {
          const [sessionIndex] = data;
          await this._handleNewSession(sessionIndex.toNumber());
        }
      }
    });
    this._unsubs.push(unsub);
  }

  // ── Active / Inactive check ───────────────────────────────────────────────────

  async _checkActiveSet(blockNum) {
    // Check every ~100 blocks (~10 min on Polkadot) to reduce RPC load
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
      if (isActive && !prevActive) {
        await this.notifier.validatorActive(this.addr, era);
      } else if (!isActive && prevActive) {
        await this.notifier.validatorInactive(this.addr, era);
      }
    }
  }

  // ── Nominator monitoring (two-tier) ───────────────────────────────────────────
  //
  //  Tier 1 — Active (erasStakers):   fast, runs every nomCheckMs (default 5 min)
  //  Tier 2 — Waiting (nominators):   slow full-chain scan, runs every pendingCheckMs (default 4 h)

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

  async _checkActiveNominators() {
    const era = await this._currentEra();
    let exposure;
    try {
      exposure = await this._getExposure(era);
    } catch (e) {
      console.error('[Nominators/Active] Error:', e.message); return;
    }
    if (!exposure) return;

    const currentNoms = {};
    for (const { who, value } of exposure.others) {
      currentNoms[who.toString()] = value.toString();
    }

    const prevNoms        = await this.state.get('nominators_active', {}) || {};
    const activeBootstrap = await this.state.get('active_bootstrapped', false);

    // On first run save baseline without firing alerts
    if (!activeBootstrap) {
      await this.state.set('nominators_active', currentNoms);
      await this.state.set('nominators', currentNoms);
      await this.state.set('active_bootstrapped', true);
      console.log(`[Nominators/Active] Bootstrap: saved ${Object.keys(currentNoms).length} active nominators`);
      return;
    }

    const allAddrs = new Set([...Object.keys(currentNoms), ...Object.keys(prevNoms)]);
    for (const nomAddr of allAddrs) {
      const curr = currentNoms[nomAddr];
      const prev = prevNoms[nomAddr];

      if (curr && !prev) {
        await this.notifier.nominatorAdded(this.addr, nomAddr, toToken(curr, this.decimals), this.token, true);
      } else if (!curr && prev) {
        await this.notifier.nominatorRemoved(this.addr, nomAddr, toToken(prev, this.decimals), this.token, true);
      } else if (curr && prev && curr !== prev) {
        const oldAmt = toFloat(prev, this.decimals);
        const newAmt = toFloat(curr, this.decimals);
        if (Math.abs(newAmt - oldAmt) > 1) {
          await this.notifier.nominatorAmountChanged(
            this.addr, nomAddr, oldAmt.toFixed(4), newAmt.toFixed(4), this.token
          );
        }
      }
    }

    await this.state.set('nominators_active', currentNoms);
    await this.state.set('nominators', currentNoms);
  }

  async _checkPendingNominators() {
    console.log('[Nominators/Pending] Scanning waiting nominators…');
    let allNoms;
    try {
      allNoms = await this.api.query.staking.nominators.entries();
    } catch (e) {
      console.error('[Nominators/Pending] Error:', e.message); return;
    }

    const activeNoms = await this.state.get('nominators_active', {}) || {};
    const activeSet  = new Set(Object.keys(activeNoms));

    // Collect addresses of waiting nominators (not in active set)
    const pendingAddrs = [];
    for (const [key, nomOpt] of allNoms) {
      if (nomOpt.isNone) continue;
      const targets = nomOpt.unwrap().targets.map(t => t.toString());
      if (!targets.includes(this.addr)) continue;
      const nomAddr = key.args[0].toString();
      if (!activeSet.has(nomAddr)) pendingAddrs.push(nomAddr);
    }

    // Fetch ledger balances in parallel batches of 20
    const BATCH = 20;
    const currentPending = {};
    for (let i = 0; i < pendingAddrs.length; i += BATCH) {
      const batch   = pendingAddrs.slice(i, i + BATCH);
      const results = await Promise.all(batch.map(async (nomAddr) => {
        try {
          let nl = await this.api.query.staking.ledger(nomAddr);
          if (nl.isNone) {
            const nb = await this.api.query.staking.bonded(nomAddr);
            if (nb.isSome) nl = await this.api.query.staking.ledger(nb.unwrap());
          }
          return { addr: nomAddr, amount: nl.isSome ? nl.unwrap().active.toString() : '0' };
        } catch (_) {
          return { addr: nomAddr, amount: '0' };
        }
      }));
      for (const { addr, amount } of results) currentPending[addr] = amount;
    }

    await this.state.set('nominators_pending', currentPending);

    // On first run save baseline without firing alerts
    const bootstrapped = await this.state.get('pending_bootstrapped', false);
    if (!bootstrapped) {
      await this.state.set('pending_bootstrapped', true);
      console.log(`[Nominators/Pending] Bootstrap: saved ${pendingAddrs.length} waiting nominators`);
      return;
    }

    const prevPending = await this.state.get('nominators_pending_prev', {}) || {};
    const allAddrs    = new Set([...Object.keys(currentPending), ...Object.keys(prevPending)]);

    let added = 0, removed = 0;
    for (const nomAddr of allAddrs) {
      const curr = currentPending[nomAddr];
      const prev = prevPending[nomAddr];

      if (curr && !prev) {
        added++;
        await this.notifier.nominatorAdded(this.addr, nomAddr, toToken(curr, this.decimals), this.token, false);
      } else if (!curr && prev) {
        removed++;
        await this.notifier.nominatorRemoved(this.addr, nomAddr, toToken(prev, this.decimals), this.token, false);
      } else if (curr && prev && curr !== prev) {
        const oldAmt = parseFloat(toToken(prev, this.decimals));
        const newAmt = parseFloat(toToken(curr, this.decimals));
        if (Math.abs(newAmt - oldAmt) > 1) {
          await this.notifier.nominatorAmountChanged(
            this.addr, nomAddr, oldAmt.toFixed(4), newAmt.toFixed(4), this.token
          );
        }
      }
    }

    await this.state.set('nominators_pending_prev', currentPending);
    console.log(`[Nominators/Pending] Done: +${added} -${removed}, total waiting: ${pendingAddrs.length}`);
  }

  // ── Oversubscribed check ──────────────────────────────────────────────────────

  async _checkOversubscribed() {
    const now      = Date.now();
    const lastCheck = await this.state.get('oversub_last_check', 0);
    if (now - lastCheck < 30 * 60_000) return; // at most once per 30 min
    await this.state.set('oversub_last_check', now);

    const era      = await this._currentEra();
    const exposure = await this._getExposure(era);
    if (!exposure) return;

    const count  = exposure.others.length;
    const wasOver = await this.state.get('is_oversubscribed', false);
    const isOver  = count > this.oversubLimit;

    if (isOver && !wasOver) {
      console.log(`[Oversub] Limit exceeded: ${count}/${this.oversubLimit}`);
      await this.notifier.oversubscribed(this.addr, count, this.oversubLimit);
    } else if (!isOver && wasOver) {
      await this.notifier.oversubscribedResolved(this.addr, count, this.oversubLimit);
    }
    await this.state.set('is_oversubscribed', isOver);
  }

  // ── Session key monitoring ────────────────────────────────────────────────────

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
      if (prevKeys === null) {
        await this.state.set('session_keys', newKeys);
        return;
      }
      if (newKeys !== prevKeys) {
        await this.notifier.sessionKeysChanged(this.addr, prevKeys, newKeys);
        await this.state.set('session_keys', newKeys);
      }
    } catch (e) {
      console.error('[Keys] Error:', e.message);
    }
  }

  async _handleNewSession(sessionIndex) {
    const now      = Date.now();
    const lastCheck = await this.state.get('keys_last_check', 0);
    if (now - lastCheck < 60 * 60_000) return; // at most once per hour
    await this.state.set('keys_last_check', now);
    if (!this.rcApi) return;

    try {
      const newKeys  = await this._fetchSessionKeys();
      if (!newKeys) return;

      const prevKeys = await this.state.get('session_keys', null);
      if (prevKeys === null) {
        await this.state.set('session_keys', newKeys);
        console.log(`[Keys] Saved at session ${sessionIndex}`);
        return;
      }
      if (newKeys !== prevKeys) {
        await this.notifier.sessionKeysChanged(this.addr, prevKeys, newKeys);
        await this.state.set('session_keys', newKeys);
      }
    } catch (e) {
      console.error('[Keys] NewSession error:', e.message);
    }
  }

  async _fetchSessionKeys() {
    // Try nextKeys first (most reliable), fall back to queuedKeys
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

  /** On first start, back-fill payout history from the last 5 eras. */
  async _loadRecentPayouts() {
    const alreadyLoaded = await this.state.get('payouts_bootstrapped', false);
    if (alreadyLoaded) return;

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

        // Approximate share: myPts / totalPts * totalReward
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
    } catch (e) {
      console.error('[Payouts] History load error:', e.message);
    }

    await this.state.set('payouts_bootstrapped', true);
  }

  // ── Heartbeat ─────────────────────────────────────────────────────────────────

  async _startHeartbeat() {
    this._stopHeartbeat();
    this._heartbeatTimer = setInterval(async () => {
      const elapsed = Date.now() - this._lastBlock;
      if (elapsed > this.heartbeatMs * 2) {
        // Count consecutive missed intervals before declaring offline
        this._offlineStrikes++;
        this._onlineStrikes = 0;
        if (this._offlineStrikes >= this.offlineThreshold) {
          await this._handleOffline();
        } else {
          console.log(`[Heartbeat] No block for ${Math.round(elapsed / 1000)}s (strike ${this._offlineStrikes}/${this.offlineThreshold})`);
        }
      } else {
        // Block arrived — reset offline counter
        this._offlineStrikes = 0;
      }
    }, this.heartbeatMs);
  }

  _stopHeartbeat() {
    if (this._heartbeatTimer) { clearInterval(this._heartbeatTimer); this._heartbeatTimer = null; }
  }

  async _notifyOnline() {
    if (this._wasOnline === true) return;

    this._onlineStrikes++;
    if (this._onlineStrikes < this.onlineThreshold) {
      console.log(`[Heartbeat] Block received while offline (${this._onlineStrikes}/${this.onlineThreshold} confirmations)`);
      return;
    }

    // Confirmed online — reset counters and send alert
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
    if (!this.api) throw new Error('API not connected');
    const Notifier = require('./notifier');

    const [era, header, validatorPrefs] = await Promise.all([
      this._currentEra(),
      this.api.rpc.chain.getHeader(),
      this.api.query.staking.validators(this.addr).catch(() => null),
    ]);
    const blockNumber = header.number.toNumber();

    // Staking exposure (active set data)
    let exposure = null;
    try { exposure = await this._getExposure(era); } catch (_) {}
    const isActive = exposure ? !exposure.total.isZero() : false;

    // Own bonded stake via staking.ledger
    let ownStake = '0';
    try {
      let ledger = await this.api.query.staking.ledger(this.addr);
      if (ledger.isNone) {
        const bonded = await this.api.query.staking.bonded(this.addr);
        if (bonded.isSome) ledger = await this.api.query.staking.ledger(bonded.unwrap());
      }
      if (ledger.isSome) ownStake = toToken(ledger.unwrap().active.toString(), this.decimals);
    } catch (_) {}

    // Active nominators — fast, from erasStakers only
    // Waiting nominators — served from state cache (updated by background cycle or /nominators command)
    let activeNoms = [];
    let totalStake = ownStake;

    if (exposure && !exposure.total.isZero()) {
      activeNoms = exposure.others.map(n => ({
        addr: n.who.toString(), amount: toToken(n.value.toString(), this.decimals),
      }));
      totalStake = toToken(exposure.total.toString(), this.decimals);
    }

    const topNominators  = [...activeNoms]
      .sort((a, b) => parseFloat(b.amount) - parseFloat(a.amount))
      .slice(0, 5);
    const nominatorCount = activeNoms.length;

    // Pending nominators from state cache.
    // Values may be raw planck strings (from background cycle) or token strings with a decimal
    // point (saved by the /nominators command) — handle both formats.
    const pendingMap   = await this.state.get('nominators_pending', {}) || {};
    const pendingCount = Object.keys(pendingMap).length;
    const pendingTotal = Object.values(pendingMap)
      .reduce((sum, v) => {
        const str = String(v);
        const num = str.includes('.') ? parseFloat(str) : parseFloat(toToken(str, this.decimals));
        return sum + (isNaN(num) ? 0 : num);
      }, 0)
      .toFixed(4);

    // Session keys (from Relay Chain)
    let sessionKeys     = null;
    let sessionKeysNote = null;
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

    // Commission (Perbill → percentage)
    let commission = '?';
    if (validatorPrefs) {
      commission = (validatorPrefs.commission.toNumber() / 10_000_000).toFixed(1) + '%';
    }

    // Payout history from state
    const payoutHistory = await this.state.get('payout_history', []) || [];
    const lastPayoutEra = await this.state.get('last_payout_era', null);

    // Monitor uptime
    const uptimeMs    = Date.now() - this._startTime;
    const uptimeHours = Math.floor(uptimeMs / 3_600_000);
    const uptimeMins  = Math.floor((uptimeMs % 3_600_000) / 60_000);
    const uptimeLabel = uptimeHours > 0 ? `${uptimeHours}h ${uptimeMins}m` : `${uptimeMins}m`;

    const isOver = exposure ? exposure.others.length > this.oversubLimit : false;

    return Notifier.formatStatus({
      network: this.network, address: this.addr,
      online:  this._wasOnline !== false, active: isActive,
      era, blockNumber, token: this.token,
      ownStake, totalStake,
      nominatorCount, pendingCount, pendingTotal,
      topNominators, sessionKeys, sessionKeysNote,
      commission, lastPayoutEra, payoutHistory,
      uptimeLabel, isOversubscribed: isOver,
      oversubLimit: this.oversubLimit,
    });
  }

  // ── Helpers ───────────────────────────────────────────────────────────────────

  /**
   * Returns a normalised exposure object compatible with both old and new Polkadot runtime.
   * New runtime (>= 9420) uses erasStakersOverview + erasStakersPaged (paged storage).
   * Old runtime uses erasStakers (single storage entry).
   */
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