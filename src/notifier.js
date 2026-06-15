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
    this._historyProvider    = null;

    this._registerCommands();
  }

  setStatusProvider(fn)     { this._statusProvider     = fn; }
  setNominatorsProvider(fn) { this._nominatorsProvider = fn; }
  setHistoryProvider(fn)    { this._historyProvider    = fn; }

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
        `/help — this help message`
      );
    });

    this.bot.on('polling_error', (e) => console.error('[Bot] Polling error:', e.message));
    console.log('[Bot] Commands registered, polling started');
  }

  /** Send a message to the given chat id (used for command replies). */
  async _reply(chatId, text) {
    try {
      if (text.length > 4096) text = text.slice(0, 4090) + '\n…';
      await this.bot.sendMessage(chatId, text, { parse_mode: 'HTML' });
    } catch (e) {
      console.error('[Telegram] Reply error:', e.message);
    }
  }

  // ── Push alerts ───────────────────────────────────────────────────────────────

  /** Send to the configured chat, bypassing cooldown. */
  async send(text) {
    try {
      await this.bot.sendMessage(this.chatId, text, { parse_mode: 'HTML' });
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

  nominatorAdded(validatorAddr, nominatorAddr, amount, token, isActive = true) {
    const tag    = isActive ? `${EMOJI.active} active` : `${EMOJI.inactive} waiting`;
    const amtStr = amount && amount !== '?' ? `\nStake: <b>${amount} ${token}</b>` : '';
    return this.notify(`nom_add_${nominatorAddr}`,
      `${EMOJI.nominator} <b>New nominator</b> (${tag})\n` +
      `Nominator: <code>${nominatorAddr}</code>${amtStr}`);
  }

  nominatorRemoved(validatorAddr, nominatorAddr, amount, token, isActive = true) {
    const tag    = isActive ? `${EMOJI.active} active` : `${EMOJI.inactive} waiting`;
    const amtStr = amount && amount !== '?' ? `\nWas staked: <b>${amount} ${token}</b>` : '';
    return this.notify(`nom_rm_${nominatorAddr}`,
      `${EMOJI.nominator} <b>Nominator left</b> (${tag})\n` +
      `Nominator: <code>${nominatorAddr}</code>${amtStr}`);
  }

  nominatorAmountChanged(validatorAddr, nominatorAddr, oldAmount, newAmount, token) {
    const delta = parseFloat(newAmount) - parseFloat(oldAmount);
    const sign  = delta > 0 ? '+' : '';
    const emoji = delta > 0 ? '📈' : '📉';
    return this.notify(`nom_chg_${nominatorAddr}`,
      `${emoji} <b>Nominator stake changed</b>\n` +
      `Nominator: <code>${nominatorAddr}</code>\n` +
      `${oldAmount} → <b>${newAmount} ${token}</b> (${sign}${delta.toFixed(4)})`);
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
    const onlineStr = s.online ? `${EMOJI.online} online`  : `${EMOJI.offline} offline`;
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

    // Pending nominators line
    const pendingLine = s.pendingCount != null
      ? `\n  ${EMOJI.inactive} Waiting:  <b>${s.pendingCount}</b>${s.pendingTotal ? ` — <b>${s.pendingTotal} ${s.token}</b>` : ''}  <i>/nominators</i>`
      : '';

    return (
      `${EMOJI.chart} <b>Validator Status</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━━\n` +
      `Network:     <b>${s.network}</b>\n` +
      `${EMOJI.block} Block:      <b>${s.blockNumber}</b>  Era: <b>${s.era}</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━━\n` +
      `Node:        ${onlineStr}\n` +
      `Status:      ${activeStr}\n` +
      `Commission:  <b>${s.commission}</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━━\n` +
      `${EMOJI.money} Stake:\n` +
      `  Own:       <b>${s.ownStake} ${s.token}</b>\n` +
      `  Total:     <b>${s.totalStake} ${s.token}</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━━\n` +
      `${EMOJI.nominator} Nominators:${overStr}\n` +
      `  ${EMOJI.active} Active:   <b>${s.nominatorCount}</b> — <b>${s.totalStake} ${s.token}</b>` +
      pendingLine +
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
