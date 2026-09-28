'use strict';

const TelegramBot = require('node-telegram-bot-api');

const EMOJI = {
  ok:        '✅',
  warn:      '⚠️',
  error:     '🔴',
  info:      'ℹ️',
  money:     '💰',
  nominator: '👥',
  key:       '🔑',
  active:    '🟢',
  inactive:  '🟡',
  offline:   '⛔',
  online:    '✅',
  clock:     '🕐',
  block:     '📦',
  chart:     '📊',
  slash:     '⚡',
  chill:     '❄️',
  oversub:   '🔶',
  history:   '📜',
  uptime:    '⏱',
};

class Notifier {
  /**
   * @param {string}       token      - Telegram bot token
   * @param {string|number} chatId    - Target chat / channel id
   * @param {number}       cooldownMs - Minimum ms between same-type alerts
   */
  constructor(token, chatId, cooldownMs = 300_000) {
    this.bot         = new TelegramBot(token, { polling: true });
    this.chatId      = String(chatId);
    this.cooldownMs  = cooldownMs;
    this.lastSent    = {};

    this._statusProvider     = null;
    this._nominatorsProvider = null;
    this._updateProvider     = null;
    this._historyProvider    = null;
    this._rankProvider       = null;

    this._registerCommands();
  }

  setStatusProvider(fn)     { this._statusProvider     = fn; }
  setNominatorsProvider(fn) { this._nominatorsProvider = fn; }
  setUpdateProvider(fn)     { this._updateProvider     = fn; }
  setHistoryProvider(fn)    { this._historyProvider    = fn; }
  setRankProvider(fn)       { this._rankProvider       = fn; }

  stopPolling() { return this.bot.stopPolling(); }

  // ── Bot commands ──────────────────────────────────────────────────────────────

  _registerCommands() {
    // Only respond to the configured chat
    const guard = (msg) => String(msg.chat.id) === this.chatId;

    this.bot.onText(/\/status/, async (msg) => {
      if (!guard(msg)) return;
      console.log('[Bot] Command: /status');
      if (!this._statusProvider) {
        return this._reply(msg.chat.id, `${EMOJI.warn} Monitor is still initialising, please try again shortly.`);
      }
      try {
        const result = await this._statusProvider();
        await this._reply(msg.chat.id, result);
      } catch (e) {
        console.error('[Bot] /status error:', e);
        const text = e instanceof Error ? e.message : String(e);
        await this._reply(msg.chat.id, `${EMOJI.error} Error: <code>${text}</code>`);
      }
    });

    this.bot.onText(/\/nominators/, async (msg) => {
      if (!guard(msg)) return;
      console.log('[Bot] Command: /nominators');
      if (!this._nominatorsProvider) {
        return this._reply(msg.chat.id, `${EMOJI.warn} No nominator data available.`);
      }
      try {
        await this._reply(msg.chat.id, `${EMOJI.clock} Loading nominators, please wait…`);
        const result   = await this._nominatorsProvider();
        // formatNominators returns an array of messages to stay within Telegram limits
        const messages = Array.isArray(result) ? result : [result];
        for (const m of messages) {
          await this._reply(msg.chat.id, m);
        }
      } catch (e) {
        console.error('[Bot] /nominators error:', e);
        await this._reply(msg.chat.id, `${EMOJI.error} Error: <code>${String(e.message || e)}</code>`);
      }
    });

    this.bot.onText(/\/update/, async (msg) => {
      if (!guard(msg)) return;
      console.log('[Bot] Command: /update');
      if (!this._updateProvider) return this._reply(msg.chat.id, `${EMOJI.warn} Not available.`);
      try {
        await this._reply(msg.chat.id, `${EMOJI.clock} Scanning nominators and updating database…`);
        await this._reply(msg.chat.id, await this._updateProvider());
      } catch (e) {
        console.error('[Bot] /update error:', e);
        await this._reply(msg.chat.id, `${EMOJI.error} Error: <code>${String(e.message || e)}</code>`);
      }
    });

    this.bot.onText(/\/rank/, async (msg) => {
      if (!guard(msg)) return;
      console.log('[Bot] Command: /rank');
      if (!this._rankProvider) {
        return this._reply(msg.chat.id, `${EMOJI.warn} Rank analysis is not available.`);
      }
      const loadingMsg = await this._reply(msg.chat.id, `⏳ Running Phragmén simulation, this may take 1-2 minutes…`);
      try {
        const msgs = await this._rankProvider();
        if (Array.isArray(msgs)) {
          for (const m of msgs) await this._reply(msg.chat.id, m);
        } else {
          await this._reply(msg.chat.id, msgs);
        }
      } catch (e) {
        console.error('[Bot] /rank error:', e);
        await this._reply(msg.chat.id, `${EMOJI.error} Rank error: <code>${e.message}</code>`);
      }
    });

    this.bot.onText(/\/history/, async (msg) => {
      if (!guard(msg)) return;
      console.log('[Bot] Command: /history');
      if (!this._historyProvider) {
        return this._reply(msg.chat.id, `${EMOJI.warn} Payout history is empty.`);
      }
      try {
        await this._reply(msg.chat.id, await this._historyProvider());
      } catch (e) {
        await this._reply(msg.chat.id, `${EMOJI.error} Error: <code>${e.message}</code>`);
      }
    });

    this.bot.onText(/\/help/, async (msg) => {
      if (!guard(msg)) return;
      await this._reply(msg.chat.id,
        `<b>Available commands:</b>\n\n` +
        `/status — current validator status\n` +
        `/nominators — full nominator list (active &amp; waiting)\n` +
        `/history — last 10 payouts\n` +
        `/update — refresh nominator database (no display)\n` +
        `/help — this help message`
      );
    });

    this.bot.on('polling_error', (e) => console.error('[Bot] Polling error:', e.message));

    // Register commands in Telegram menu (hamburger button)
    this.bot.setMyCommands([
      { command: 'status',     description: 'Current validator status' },
      { command: 'nominators', description: 'Full nominator list (active & waiting)' },
      { command: 'update',     description: 'Refresh nominator database' },
      { command: 'rank',       description: 'Slot position & Phragmén prediction' },
      { command: 'history',    description: 'Last 10 reward payouts' },
      { command: 'help',       description: 'List of commands' },
    ]).catch(e => console.error('[Bot] setMyCommands error:', e.message));

    console.log('[Bot] Commands registered, polling started');
  }

  /** Send a message to the given chat id (used for command replies). */
  async _reply(chatId, text, opts = {}) {
    try {
      if (text.length > 4096) text = text.slice(0, 4090) + '\n…';
      await this.bot.sendMessage(chatId, text, {
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        ...opts,
      });
    } catch (e) {
      console.error('[Telegram] Reply error:', e.message);
    }
  }

  // ── Push alerts ───────────────────────────────────────────────────────────────

  /** Send to the configured chat, bypassing cooldown. */
  async send(text) {
    try {
      await this.bot.sendMessage(this.chatId, text, {
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      });
    } catch (e) {
      console.error('[Telegram] Send error:', e.message);
    }
  }

  /** Send with per-type cooldown to prevent alert flooding. */
  async notify(type, text) {
    const now  = Date.now();
    const last = this.lastSent[type] || 0;
    if (now - last < this.cooldownMs) return;
    this.lastSent[type] = now;
    await this.send(text);
  }

  // ── Alert templates ───────────────────────────────────────────────────────────

  validatorOnline(addr, network) {
    return this.notify('online',
      `${EMOJI.online} <b>Validator online</b>\n` +
      `Network: <b>${network}</b>\n<code>${addr}</code>`);
  }

  validatorOffline(addr, network) {
    return this.notify('offline',
      `${EMOJI.offline} <b>Validator OFFLINE!</b>\n` +
      `Network: <b>${network}</b>\n<code>${addr}</code>`);
  }

  validatorActive(addr, era) {
    return this.notify('active',
      `${EMOJI.active} <b>Validator is ACTIVE</b>\n` +
      `Era: <b>${era}</b>\n<code>${addr}</code>`);
  }

  validatorInactive(addr, era) {
    return this.notify('inactive',
      `${EMOJI.inactive} <b>Validator is WAITING</b>\n` +
      `Era: <b>${era}</b>\n<code>${addr}</code>`);
  }

  /** Slash is critical — always sent, no cooldown. */
  validatorSlashed(addr, amount, token) {
    return this.send(
      `${EMOJI.slash} <b>⚠️ SLASH! Validator was slashed</b>\n` +
      `Amount: <b>-${amount} ${token}</b>\n<code>${addr}</code>`);
  }

  validatorChilled(addr) {
    return this.send(
      `${EMOJI.chill} <b>Validator forcibly chilled!</b>\n` +
      `Manual re-activation required via <code>staking.validate</code>\n` +
      `<code>${addr}</code>`);
  }

  oversubscribed(addr, count, limit) {
    return this.notify('oversub',
      `${EMOJI.oversub} <b>Validator oversubscribed</b>\n` +
      `Nominators: <b>${count}</b> (limit: ${limit})\n` +
      `Nominators beyond the limit receive no rewards!\n` +
      `<code>${addr}</code>`);
  }

  oversubscribedResolved(addr, count, limit) {
    return this.notify('oversub_resolved',
      `${EMOJI.ok} Nominator count back to normal: <b>${count}/${limit}</b>\n<code>${addr}</code>`);
  }

  nominatorJoined(addr, stake, newTotal, delta, token) {
    const sign = parseFloat(delta) >= 0 ? '+' : '';
    return this.notify(`nom_join_${addr}`,
      `${EMOJI.nominator} <b>New nominator</b>\n` +
      `<code>${addr}</code>\n` +
      `Stake: <b>${stake} ${token}</b>\n` +
      `Total: <b>${newTotal} ${token}</b>  (${sign}${delta} ${token})`);
  }

  nominatorLeft(addr, stake, newTotal, delta, token) {
    const sign = parseFloat(delta) >= 0 ? '+' : '';
    return this.notify(`nom_left_${addr}`,
      `${EMOJI.nominator} <b>Nominator left</b>\n` +
      `<code>${addr}</code>\n` +
      `Removed stake: <b>${stake} ${token}</b>\n` +
      `Total: <b>${newTotal} ${token}</b>  (${sign}${delta} ${token})`);
  }

  nominatorStakeChanged(addr, oldStake, newStake, newTotal, delta, token) {
    const nomDelta = (parseFloat(newStake) - parseFloat(oldStake)).toFixed(4);
    const nomSign  = parseFloat(nomDelta) >= 0 ? '+' : '';
    const totSign  = parseFloat(delta) >= 0 ? '+' : '';
    const emoji    = parseFloat(nomDelta) >= 0 ? '📈' : '📉';
    return this.notify(`nom_chg_${addr}`,
      `${emoji} <b>Nominator stake changed</b>\n` +
      `<code>${addr}</code>\n` +
      `${oldStake} → <b>${newStake} ${token}</b>  (${nomSign}${nomDelta})\n` +
      `Total: <b>${newTotal} ${token}</b>  (${totSign}${delta} ${token})`);
  }

  payoutReceived(validatorAddr, era, amount, token) {
    return this.notify(`payout_${era}`,
      `${EMOJI.money} <b>Payout for era ${era}</b>\n` +
      `<code>${short(validatorAddr)}</code>\n` +
      `Amount: <b>${amount} ${token}</b>`);
  }

  /** Session key change is always sent, no cooldown. */
  sessionKeysChanged(validatorAddr, oldKeys, newKeys) {
    return this.send(
      `${EMOJI.key} <b>Session keys changed!</b>\n` +
      `<code>${short(validatorAddr)}</code>\n\n` +
      `Old: <code>${trimKey(oldKeys)}</code>\n` +
      `New: <code>${trimKey(newKeys)}</code>`);
  }

  connectionError(rpc, err) {
    return this.notify('conn_error',
      `${EMOJI.error} <b>RPC connection error</b>\n` +
      `<code>${rpc}</code>\n${err}`);
  }

  reconnected(rpc) {
    return this.notify('reconnected',
      `${EMOJI.ok} RPC connection restored\n<code>${rpc}</code>`);
  }

  // ── /status formatter ─────────────────────────────────────────────────────────

  /**
   * Formats the full validator status report.
   * @param {object} s - Status data object (see getStatus() in watcher.js)
   */
  static formatStatus(s) {
    // Node health check line
    let nodeStr;
    if (!s.nodeRpcConfigured) {
      nodeStr = `ℹ️ healthcheck disabled`;
    } else if (s.nodeOnline === null) {
      nodeStr = `⏳ checking…`;
    } else if (s.nodeOnline) {
      const peersStr = s.nodePeers != null ? ` — peers: ${s.nodePeers}` : '';
      nodeStr = `${EMOJI.online} online${peersStr}`;
    } else {
      nodeStr = `${EMOJI.offline} offline`;
    }

    const activeStr = s.active ? `${EMOJI.active} active`  : `${EMOJI.inactive} waiting`;
    const keysStr   = s.sessionKeys ? trimKey(s.sessionKeys) : (s.sessionKeysNote || 'not set');
    const overStr   = s.isOversubscribed ? ` ${EMOJI.oversub} oversubscribed!` : '';

    // Top nominators block
    let nominatorLines = '';
    if (s.topNominators && s.topNominators.length > 0) {
      nominatorLines = '\n<b>Top nominators:</b>\n' +
        s.topNominators.map((n, i) =>
          `  ${i + 1}. <code>${short(n.addr)}</code>  ${n.amount} ${s.token}`
        ).join('\n');
    }

    // Payout history block (last 3)
    let payoutLines = '';
    if (s.payoutHistory && s.payoutHistory.length > 0) {
      payoutLines = '\n<b>Recent payouts:</b>\n' +
        s.payoutHistory.slice(0, 3).map(p =>
          `  era ${p.era}: <b>${p.amount} ${s.token}</b>`
        ).join('\n');
    } else if (s.lastPayoutEra) {
      payoutLines = `\nLast payout: era <b>${s.lastPayoutEra}</b>`;
    }



    return (
      `${EMOJI.chart} <b>Validator Status</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━━\n` +
      `Network:     <b>${s.network}</b>\n` +
      `${EMOJI.block} Block:      <b>${s.blockNumber}</b>  Era: <b>${s.era}</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━━\n` +
      `Node:        ${nodeStr}\n` +
      `Status:      ${activeStr}\n` +
      `━━━━━━━━━━━━━━━━━━━━━\n` +
      `${EMOJI.money} Stake:\n` +
      `  Own:         <b>${s.ownStake} ${s.token}</b>\n` +
      `  Era active:  <b>${s.eraTotal} ${s.token}</b>\n` +
      `  All bonded:  <b>${s.poolTotal ? s.poolTotal + ' ' + s.token : '— run /nominators to load'}</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━━\n` +
      `${EMOJI.nominator} Nominators:${overStr}\n` +
      `  ${EMOJI.active} Active:   <b>${s.nominatorCount}</b>\n` +
      `  ${EMOJI.inactive} Waiting:  <b>${s.pendingCount != null ? s.pendingCount : '—'}</b>  <i>/nominators</i>\n` +
      `  Total:    <b>${s.allNomCount + 1}</b> (incl. self)` +
      nominatorLines + '\n' +
      `━━━━━━━━━━━━━━━━━━━━━\n` +
      `${EMOJI.key} Session Keys:\n  <code>${keysStr}</code>\n` +
      `━━━━━━━━━━━━━━━━━━━━━\n` +
      `${EMOJI.history} Payouts:${payoutLines || ' no data'}\n` +
      `${EMOJI.uptime} Uptime: <b>${s.uptimeLabel}</b>\n` +
      `${EMOJI.clock} ${new Date().toUTCString()}\n` +
      `━━━━━━━━━━━━━━━━━━━━━\n` +
      `<code>${s.address}</code>`
    );
  }

  // ── /nominators formatter ─────────────────────────────────────────────────────

  /**
   * Formats the full nominator list split into active and waiting sections.
   * Returns an array of messages to handle Telegram's 4096-char limit.
   */
  static formatNominators(activeNoms, pendingNoms, token, validatorAddr) {
    const esc = (s) => String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');

    const activeSorted  = [...activeNoms].sort((a, b) => parseFloat(b.amount) - parseFloat(a.amount));
    const pendingSorted = [...pendingNoms].sort((a, b) => parseFloat(b.amount) - parseFloat(a.amount));
    const activeTotal   = activeSorted.reduce((s, n) => s + parseFloat(n.amount), 0).toFixed(4);
    const pendingTotal  = pendingSorted.reduce((s, n) => s + parseFloat(n.amount), 0).toFixed(4);

    const messages = [];

    // Active section
    let chunk =
      `${EMOJI.nominator} <b>Nominators</b>\n` +
      `<code>${esc(short(validatorAddr))}</code>\n` +
      `━━━━━━━━━━━━━━━━━━━━━\n`;

    if (activeSorted.length > 0) {
      chunk += `${EMOJI.active} <b>Active (${activeSorted.length}) — ${activeTotal} ${token}</b>\n`;
      for (let i = 0; i < activeSorted.length; i++) {
        const line = `${i + 1}. <code>${esc(activeSorted[i].addr)}</code>  <b>${esc(activeSorted[i].amount)} ${token}</b>\n`;
        if ((chunk + line).length > 3800) { messages.push(chunk.trimEnd()); chunk = ''; }
        chunk += line;
      }
    } else {
      chunk += `${EMOJI.active} <b>No active nominators</b>\n`;
    }
    if (chunk.trim()) { messages.push(chunk.trimEnd()); chunk = ''; }

    // Waiting section
    if (pendingSorted.length > 0) {
      chunk = `━━━━━━━━━━━━━━━━━━━━━\n${EMOJI.inactive} <b>Waiting (${pendingSorted.length}) — ${pendingTotal} ${token}</b>\n`;
      for (let i = 0; i < pendingSorted.length; i++) {
        const line = `${activeSorted.length + i + 1}. <code>${esc(pendingSorted[i].addr)}</code>  <b>${esc(pendingSorted[i].amount)} ${token}</b>\n`;
        if ((chunk + line).length > 3800) { messages.push(chunk.trimEnd()); chunk = ''; }
        chunk += line;
      }
      if (chunk.trim()) messages.push(chunk.trimEnd());
    }

    return messages;
  }

  // ── /rank formatter ───────────────────────────────────────────────────────────

  /**
   * Formats Phragmén slot-position analysis result for Telegram.
   * @param {object} r            - Result object from analyzeSlotPosition()
   * @param {string} validatorAddr
   * @param {string} token        - e.g. 'DOT'
   * @returns {string[]}          - Array of Telegram HTML messages
   */
  static formatRank(r, validatorAddr, token) {
    const fmt = (v) => (typeof v === 'number' ? v.toLocaleString('en', { maximumFractionDigits: 2 }) : '—') + ' ' + token;

    const header =
      `${EMOJI.chart} <b>Slot Position Analysis</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━━\n` +
      `Era: <b>${r.era}</b>  Session: <b>${r.sessionIdx}</b>\n` +
      `Candidates: <b>${r.candidates}</b>  Slots: <b>${r.maxSlots}</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━━\n`;

    // Current era status (real on-chain data)
    let eraLine = '';
    if (r.isActive) {
      eraLine =
        `${EMOJI.active} <b>Era status: ACTIVE</b>\n` +
        `  Rank:    <b>#${r.eraRank}</b>\n` +
        `  Total:   <b>${fmt(r.eraTotal)}</b>\n` +
        (r.eraBuffer != null ? `  Buffer:  <b>+${fmt(r.eraBuffer)}</b> over last\n` : '') +
        `━━━━━━━━━━━━━━━━━━━━━\n`;
    } else {
      eraLine =
        `${EMOJI.inactive} <b>Era status: WAITING</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━━\n`;
    }

    // Prediction section
    let predLine = '';
    if (r.predRank != null) {
      const safetyPct = r.totalActive > 0
        ? ((r.totalActive - r.predRank) / r.totalActive * 100).toFixed(1)
        : null;
      const danger = r.predRank > r.totalActive * 0.9  ? ` ⚠️ DANGER ZONE`
                   : r.predRank > r.totalActive * 0.75 ? ` ⚡ CAUTION`
                   : ` ✅ Comfortable`;
      predLine =
        `📐 <b>Prediction (next era)</b>\n` +
        `  Rank:    <b>#${r.predRank}/${r.totalActive}</b>${danger}\n` +
        `  Stake:   <b>${fmt(r.predStake)}</b>\n` +
        (r.predBuffer != null ? `  Buffer:  <b>+${fmt(r.predBuffer)}</b> predicted\n` : '') +
        `  Safety:  <b>${safetyPct != null ? safetyPct + '%' : '—'}</b> above ejection\n` +
        `━━━━━━━━━━━━━━━━━━━━━\n`;
    } else if (r.waitRank != null) {
      const needed = r.marginalStake - (r.predStake || 0);
      predLine =
        `📐 <b>Prediction: WAITING</b>\n` +
        `  Waiting rank: <b>#${r.waitRank}</b>\n` +
        `  Predicted stake: <b>${fmt(r.predStake)}</b>\n` +
        `  Need to enter:   <b>+${fmt(needed > 0 ? needed : 0)}</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━━\n`;
    } else {
      predLine = `❓ <b>Validator not found in simulation</b>\n━━━━━━━━━━━━━━━━━━━━━\n`;
    }

    const footer =
      `━━━━━━━━━━━━━━━━━━━━━\n` +
      `<i>Nominators: ${r.nominators}  Avg targets: ${r.avgTargets?.toFixed(1) ?? '—'}  Time: ${r.elapsed}s</i>\n` +
      `<i>Rank ±50. Buffer from era data is authoritative.</i>`;

    // Message 1: summary (always fits)
    const msg1 = header + eraLine + predLine + footer;

    // Message 2: full anchor top-10 with Subscan links
    const messages = [msg1];
    if (r.myAnchors && r.myAnchors.length > 0) {
      const top = r.myAnchors.slice(0, 10);
      const excCount = r.exclusiveCount ?? top.filter(n => n.exclusive || n.targets === 1).length;
      const excTotal = r.exclusiveTotal ?? top.filter(n => n.exclusive || n.targets === 1).reduce((s,n) => s + (n.budget||0), 0);

      let anchor =
        `🎯 <b>Anchor Nominator Analysis</b>\n` +
        `<code>${validatorAddr}</code>\n` +
        `━━━━━━━━━━━━━━━━━━━━━\n` +
        `🔒 Exclusive (100% to you): <b>${excCount}</b> nominators — <b>${fmt(excTotal)}</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━━\n` +
        `Top ${top.length} by effective stake:\n`;

      for (let i = 0; i < top.length; i++) {
        const n       = top[i];
        const addr    = n.addr || n.nomAddr || '';
        const short   = addr ? addr.slice(0, 8) + '…' + addr.slice(-6) : '?';
        const url     = addr ? `https://assethub-polkadot.subscan.io/account/${addr}` : null;
        const nameStr = url ? `<a href="${url}">${short}</a>` : `<code>${short}</code>`;
        const budgetStr  = n.budget   != null ? n.budget.toLocaleString('en', { maximumFractionDigits: 0 })   : '—';
        const effectStr  = n.effective != null ? n.effective.toLocaleString('en', { maximumFractionDigits: 0 }) : '—';
        const exclMark   = (n.exclusive || n.targets === 1) ? ' 🔒' : '';

        anchor +=
          `${i + 1}. ${nameStr}${exclMark}\n` +
          `   budget: <b>${budgetStr} ${token}</b>  targets: ${n.targets ?? '?'}  effective: <b>${effectStr} ${token}</b>\n`;
      }

      messages.push(anchor);
    }

    return messages;
  }

  // ── /history formatter ────────────────────────────────────────────────────────

  static formatHistory(history, token) {
    if (!history || history.length === 0) {
      return `${EMOJI.history} <b>Payout history is empty</b>`;
    }
    const lines = history.map(p => {
      const date = p.ts ? new Date(p.ts).toISOString().slice(0, 10) : '—';
      return `  era <b>${p.era}</b>: ${p.amount} ${token}  <i>${date}</i>`;
    }).join('\n');

    return `${EMOJI.history} <b>Recent payouts</b>\n━━━━━━━━━━━━━━━━━━━━━\n${lines}`;
  }
}

function short(addr) {
  if (!addr || addr.length < 12) return addr;
  return addr.slice(0, 6) + '…' + addr.slice(-6);
}

function trimKey(key) {
  if (!key) return 'none';
  return key.slice(0, 9) + '…' + key.slice(-6);
}

module.exports = Notifier;
