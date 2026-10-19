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
  history:   '📜',
  uptime:    '⏱',
};

const TG_LIMIT = 4000;   // Telegram hard limit is 4096; keep headroom

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** Escape text for Telegram HTML parse mode. */
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Strip tags for the plain-text fallback when Telegram rejects our HTML. */
function stripHtml(s) {
  return String(s)
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/**
 * Split a message at line boundaries so no chunk exceeds TG_LIMIT.
 * All our tags open and close on the same line, so this never cuts a tag.
 */
function splitMessage(text, limit = TG_LIMIT) {
  if (text.length <= limit) return [text];
  const chunks = [];
  let chunk = '';
  for (const line of text.split('\n')) {
    if (line.length > limit) {
      if (chunk) { chunks.push(chunk); chunk = ''; }
      for (let i = 0; i < line.length; i += limit) chunks.push(line.slice(i, i + limit));
      continue;
    }
    if (chunk && chunk.length + 1 + line.length > limit) { chunks.push(chunk); chunk = ''; }
    chunk = chunk ? chunk + '\n' + line : line;
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}

const subscanUrl = (addr) => `https://assethub-polkadot.subscan.io/account/${addr}`;

class Notifier {
  /**
   * @param {string}       token      - Telegram bot token
   * @param {string|number} chatId    - Target chat / channel id
   * @param {number}       cooldownMs - Minimum ms between same-type non-critical alerts
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

    // Exact command match: "/rank" or "/rank@botname", not "/ranking"
    const command = (name, handler) => {
      this.bot.onText(new RegExp(`^/${name}(?:@\\w+)?(?:\\s|$)`), async (msg) => {
        if (!guard(msg)) return;
        console.log(`[Bot] Command: /${name}`);
        try {
          await handler(msg.chat.id);
        } catch (e) {
          if (e.name !== 'BusyError') console.error(`[Bot] /${name} error:`, e);
          const icon = e.name === 'BusyError' ? EMOJI.clock : EMOJI.error;
          await this._reply(msg.chat.id, `${icon} <code>${escapeHtml(e instanceof Error ? e.message : e)}</code>`);
        }
      });
    };

    const replyAll = async (chatId, result) => {
      for (const m of (Array.isArray(result) ? result : [result])) await this._reply(chatId, m);
    };

    command('status', async (chatId) => {
      if (!this._statusProvider) {
        return this._reply(chatId, `${EMOJI.warn} Monitor is still initialising, please try again shortly.`);
      }
      await this._reply(chatId, await this._statusProvider());
    });

    command('nominators', async (chatId) => {
      if (!this._nominatorsProvider) return this._reply(chatId, `${EMOJI.warn} No nominator data available.`);
      // Providers call onStart once they hold the lock, so a busy reply isn't preceded by "loading…"
      const onStart = () => this._reply(chatId, `${EMOJI.clock} Loading nominators, please wait…`);
      await replyAll(chatId, await this._nominatorsProvider(onStart));
    });

    command('update', async (chatId) => {
      if (!this._updateProvider) return this._reply(chatId, `${EMOJI.warn} Not available.`);
      const onStart = () => this._reply(chatId, `${EMOJI.clock} Scanning nominators and updating database…`);
      await this._reply(chatId, await this._updateProvider(onStart));
    });

    command('rank', async (chatId) => {
      if (!this._rankProvider) return this._reply(chatId, `${EMOJI.warn} Rank analysis is not available.`);
      const onStart = () => this._reply(chatId, `⏳ Running Phragmén simulation, this may take 1-2 minutes…`);
      await replyAll(chatId, await this._rankProvider(onStart));
    });

    command('history', async (chatId) => {
      if (!this._historyProvider) return this._reply(chatId, `${EMOJI.warn} Payout history is empty.`);
      await this._reply(chatId, await this._historyProvider());
    });

    command('help', async (chatId) => {
      await this._reply(chatId,
        `<b>Available commands:</b>\n\n` +
        `/status — current validator status\n` +
        `/nominators — full nominator list (active &amp; waiting)\n` +
        `/rank — slot position &amp; Phragmén prediction\n` +
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

  // ── Sending ───────────────────────────────────────────────────────────────────

  /**
   * Send one chunk with retries: honours 429 retry_after, retries 5xx/network
   * errors with backoff, and falls back to plain text if Telegram rejects the HTML.
   */
  async _sendChunk(chatId, text) {
    let opts = { parse_mode: 'HTML', disable_web_page_preview: true };
    const MAX_ATTEMPTS = 4;
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.bot.sendMessage(chatId, text, opts);
      } catch (e) {
        const status = e.response?.statusCode;
        const desc   = e.response?.body?.description || e.message;
        if (attempt >= MAX_ATTEMPTS) throw e;
        if (status === 429) {
          const retryAfter = e.response?.body?.parameters?.retry_after ?? 5;
          console.warn(`[Telegram] 429 — retrying in ${retryAfter}s`);
          await sleep(retryAfter * 1000 + 500);
        } else if (status === 400 && opts.parse_mode && /parse entities/i.test(desc)) {
          console.warn('[Telegram] HTML rejected, resending as plain text:', desc);
          text = stripHtml(text);
          opts = { disable_web_page_preview: true };
        } else if ((status && status >= 500) || e.code === 'EFATAL') {
          console.warn(`[Telegram] ${desc} — retry ${attempt}/${MAX_ATTEMPTS - 1}`);
          await sleep(2_000 * attempt);
        } else {
          throw e;
        }
      }
    }
  }

  /** Send a message to the given chat id (used for command replies). */
  async _reply(chatId, text) {
    try {
      for (const chunk of splitMessage(text)) await this._sendChunk(chatId, chunk);
    } catch (e) {
      console.error('[Telegram] Reply error:', e.message);
    }
  }

  /** Send to the configured chat, bypassing cooldown. */
  async send(text) {
    try {
      for (const chunk of splitMessage(text)) await this._sendChunk(this.chatId, chunk);
    } catch (e) {
      console.error('[Telegram] Send error:', e.message);
    }
  }

  /** Send with per-type cooldown — only for non-critical, potentially noisy alerts. */
  async notify(type, text) {
    const now  = Date.now();
    const last = this.lastSent[type] || 0;
    if (now - last < this.cooldownMs) return;
    this.lastSent[type] = now;
    await this.send(text);
  }

  // ── Alert templates ───────────────────────────────────────────────────────────
  //
  // State-change alerts (chain/node up/down, active/waiting) are edge-triggered by
  // the watcher, so they bypass the cooldown — otherwise a quick flap would
  // swallow the second "down" alert forever.

  chainOnline(rpc, network, recovered) {
    return this.send(recovered
      ? `${EMOJI.online} <b>RPC connection restored</b> — blocks are arriving again\n` +
        `Network: <b>${network}</b>\n<code>${escapeHtml(rpc)}</code>`
      : `${EMOJI.online} <b>Connected to chain</b>\n` +
        `Network: <b>${network}</b>\n<code>${escapeHtml(rpc)}</code>`);
  }

  chainOffline(rpc, network, silentSec) {
    return this.send(
      `${EMOJI.offline} <b>RPC connection lost</b> — no new blocks` +
      (silentSec != null ? ` for ${silentSec}s` : '') + `\n` +
      `Network: <b>${network}</b>\n<code>${escapeHtml(rpc)}</code>\n` +
      `<i>This is the monitor's RPC, not your validator node.</i>`);
  }

  nodeOffline(endpoint, reason) {
    return this.send(
      `${EMOJI.offline} <b>Validator node OFFLINE!</b>\n` +
      `Reason: ${escapeHtml(reason)}\n<code>${escapeHtml(endpoint)}</code>`);
  }

  nodeSyncing(endpoint, peers) {
    return this.send(
      `${EMOJI.warn} <b>Validator node is syncing</b> (not producing at tip)\n` +
      `Peers: <b>${peers}</b>\n<code>${escapeHtml(endpoint)}</code>`);
  }

  nodeOnline(endpoint, peers) {
    return this.send(
      `${EMOJI.online} <b>Validator node healthy</b>\n` +
      `Peers: <b>${peers}</b>\n<code>${escapeHtml(endpoint)}</code>`);
  }

  validatorActive(addr, era) {
    return this.send(
      `${EMOJI.active} <b>Validator is ACTIVE</b>\n` +
      `Era: <b>${era}</b>\n<code>${addr}</code>`);
  }

  validatorInactive(addr, era) {
    return this.send(
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

  nominatorJoined(addr, stake, poolTotal, token) {
    return this.send(
      `${EMOJI.nominator} <b>New nominator</b>\n` +
      `<code>${addr}</code>\n` +
      `<a href="${subscanUrl(addr)}">Subscan ↗</a>\n` +
      `Stake: <b>+${stake} ${token}</b>\n` +
      `Pool total: <b>${poolTotal} ${token}</b>`);
  }

  nominatorLeft(addr, stake, poolTotal, token) {
    return this.send(
      `${EMOJI.nominator} <b>Nominator left</b>\n` +
      `<code>${addr}</code>\n` +
      `<a href="${subscanUrl(addr)}">Subscan ↗</a>\n` +
      `Removed stake: <b>-${stake} ${token}</b>\n` +
      `Pool total: <b>${poolTotal} ${token}</b>`);
  }

  nominatorStakeChanged(addr, oldStake, newStake, poolTotal, token) {
    const nomDelta = (parseFloat(newStake) - parseFloat(oldStake)).toFixed(4);
    const nomSign  = parseFloat(nomDelta) >= 0 ? '+' : '';
    const emoji    = parseFloat(nomDelta) >= 0 ? '📈' : '📉';
    return this.send(
      `${emoji} <b>Nominator stake changed</b>\n` +
      `<code>${addr}</code>\n` +
      `<a href="${subscanUrl(addr)}">Subscan ↗</a>\n` +
      `${oldStake} → <b>${newStake} ${token}</b>  (<b>${nomSign}${nomDelta}</b>)\n` +
      `Pool total: <b>${poolTotal} ${token}</b>`);
  }

  payoutReceived(validatorAddr, era, amount, eraTotal, token) {
    const totalStr = eraTotal && eraTotal !== amount ? `\nEra total so far: <b>${eraTotal} ${token}</b>` : '';
    return this.send(
      `${EMOJI.money} <b>Payout for era ${era}</b>\n` +
      `<code>${short(validatorAddr)}</code>\n` +
      `Amount: <b>${amount} ${token}</b>` + totalStr);
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
      `<code>${escapeHtml(rpc)}</code>\n${escapeHtml(err)}`);
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
    } else {
      const peersStr = s.nodePeers != null ? ` — peers: ${s.nodePeers}` : '';
      nodeStr = s.nodeState === 'online'  ? `${EMOJI.online} online${peersStr}`
              : s.nodeState === 'syncing' ? `${EMOJI.warn} syncing${peersStr}`
              : s.nodeState === 'offline' ? `${EMOJI.offline} offline`
              : `⏳ checking…`;
    }
    const rpcStr = s.online ? `${EMOJI.online} receiving blocks` : `${EMOJI.offline} no new blocks`;

    const activeStr = s.active ? `${EMOJI.active} active`  : `${EMOJI.inactive} waiting`;
    const keysStr   = s.sessionKeys ? trimKey(s.sessionKeys) : (s.sessionKeysNote || 'not set');
    const pagesStr  = s.exposurePages > 1 ? ` (${s.exposurePages} exposure pages)` : '';

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
      `RPC:         ${rpcStr}\n` +
      `Node:        ${nodeStr}\n` +
      `Status:      ${activeStr}\n` +
      `━━━━━━━━━━━━━━━━━━━━━\n` +
      `${EMOJI.money} Stake:\n` +
      `  Own:         <b>${s.ownStake} ${s.token}</b>\n` +
      `  Era active:  <b>${s.eraTotal} ${s.token}</b>\n` +
      `  All bonded:  <b>${s.poolTotal ? s.poolTotal + ' ' + s.token : '— run /nominators to load'}</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━━\n` +
      `${EMOJI.nominator} Nominators:${pagesStr}\n` +
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
    const esc = escapeHtml;

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
   * @param {object} [opts]
   * @param {number} [opts.topN=5]      - How many anchors to show (5 = scheduled, 10 = /rank)
   * @param {boolean} [opts.links=false] - Include Subscan links (true for /rank, false for scheduled)
   * @returns {string[]}          - Array of Telegram HTML messages
   */
  static formatRank(r, validatorAddr, token, { topN = 5, links = false } = {}) {
    const fmt = (v) => (typeof v === 'number' ? v.toLocaleString('en', { maximumFractionDigits: 2 }) : '—') + ' ' + token;

    const header =
      `${EMOJI.chart} <b>Slot Position Analysis</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━━\n` +
      `Era: <b>${r.era}</b>  Session: <b>${r.sessionIdx}</b>\n` +
      `Candidates: <b>${r.candidates}</b>  Slots: <b>${r.maxSlots}</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━━\n`;

    const clusterNote = (n) => (n > 0 ? `  <i>${n} validators within ±0.1% of this stake — rank is volatile, watch the buffer</i>\n` : '');

    // Current era status (real on-chain data)
    let eraLine = '';
    if (r.isActive) {
      eraLine =
        `${EMOJI.active} <b>Era ${r.era} (now): ACTIVE</b>\n` +
        `  Rank:    <b>#${r.eraRank}</b>\n` +
        `  Total:   <b>${fmt(r.eraTotal)}</b>\n` +
        (r.eraBuffer != null ? `  Buffer:  <b>+${fmt(r.eraBuffer)}</b> over last\n` : '') +
        `━━━━━━━━━━━━━━━━━━━━━\n`;
    } else {
      eraLine =
        `${EMOJI.inactive} <b>Era ${r.era} (now): WAITING</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━━\n`;
    }

    const SOURCE = {
      chain:      'elected — on-chain result',
      snapshot:   'election running — simulated on the official snapshot',
      simulation: 'simulated on current state',
    };

    // One block per projection (next era / forecast)
    const projectionBlock = (p, title) => {
      if (!p) return '';
      const head = `📐 <b>${title} — era ${p.era}</b>\n  <i>${SOURCE[p.source] || p.source}</i>\n`;
      if (p.rank != null) {
        // Ejection risk is about stake, not rank: buffer as % of the last elected stake
        const pct    = p.marginal > 0 && p.buffer != null ? p.buffer / p.marginal * 100 : null;
        const danger = pct == null ? '' : pct < 5 ? ' ⚠️ DANGER ZONE' : pct < 15 ? ' ⚡ CAUTION' : ' ✅ Comfortable';
        return head +
          `  Rank:    <b>#${p.rank}/${p.total}</b>${danger}\n` +
          `  Stake:   <b>${fmt(p.stake)}</b>\n` +
          (p.buffer != null ? `  Buffer:  <b>+${fmt(p.buffer)}</b>${pct != null ? ` (${pct.toFixed(1)}% above last)` : ''}\n` : '') +
          clusterNote(p.cluster) +
          `━━━━━━━━━━━━━━━━━━━━━\n`;
      }
      const needed = p.marginal - (p.stake || 0);
      return head +
        `  ${EMOJI.inactive} <b>NOT ELECTED</b>` + (p.waitRank != null ? ` — waiting #${p.waitRank} by approval stake` : '') + `\n` +
        `  Approval stake: <b>${fmt(p.stake)}</b>\n` +
        `  Last elected:   <b>${fmt(p.marginal)}</b>\n` +
        `  Short by:       <b>≈${fmt(needed > 0 ? needed : 0)}</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━━\n`;
    };

    const predLine = r.next
      ? projectionBlock(r.next, 'Next era') + projectionBlock(r.forecast, 'Forecast')
      : `❓ <b>No prediction available</b>\n━━━━━━━━━━━━━━━━━━━━━\n`;

    const sim = r.forecast || (r.next && r.next.source !== 'chain' ? r.next : null);
    const stats = sim && sim.nominators != null
      ? `Nominators: ${sim.nominators}  Avg targets: ${sim.avgTargets?.toFixed(1) ?? '—'}  `
      : '';
    const footer =
      `━━━━━━━━━━━━━━━━━━━━━\n` +
      `<i>${stats}Time: ${r.elapsed}s</i>\n` +
      (r.forecast ? `<i>Forecast: changes before the next election snapshot are not included.</i>` : '');

    // Message 1: summary (always fits)
    const msg1 = header + eraLine + predLine + footer;

    const messages = [msg1];

    // Anchor block — inline for scheduled (topN=5), separate message for /rank (topN=10)
    if (r.myAnchors && r.myAnchors.length > 0) {
      const top      = r.myAnchors.slice(0, topN);
      const excCount = r.exclusiveCount ?? 0;
      const excTotal = r.exclusiveTotal ?? 0;
      const mark = (n) => (n.exclusive ? ' 🔒' : '');
      // "7/16" when some nominations point at non-validators
      const targetsStr = (n) => (n.targets == null ? '?'
        : n.nominated != null && n.nominated !== n.targets ? `${n.targets}/${n.nominated}` : `${n.targets}`);

      if (links) {
        // /rank: detailed second message with Subscan links
        let anchor =
          `🎯 <b>Anchor Nominator Analysis</b>\n` +
          `<code>${validatorAddr}</code>\n` +
          `━━━━━━━━━━━━━━━━━━━━━\n` +
          `🔒 Exclusive (you are their only validator): <b>${excCount}</b> — <b>${fmt(excTotal)}</b>\n` +
          (r.backerCount != null ? `Backers total: <b>${r.backerCount}</b>\n` : '') +
          `━━━━━━━━━━━━━━━━━━━━━\n` +
          `Top ${top.length} by stake given to you:\n`;

        for (let i = 0; i < top.length; i++) {
          const n         = top[i];
          const addr      = n.addr || n.nomAddr || '';
          const shortAddr = addr ? addr.slice(0, 8) + '…' + addr.slice(-6) : '?';
          const url       = addr ? `https://assethub-polkadot.subscan.io/account/${addr}` : null;
          const nameStr   = url ? `<a href="${url}">${shortAddr}</a>` : `<code>${shortAddr}</code>`;
          const budgetStr = n.budget    != null ? n.budget.toLocaleString('en',    { maximumFractionDigits: 0 }) : '—';
          const effStr    = n.effective != null ? n.effective.toLocaleString('en', { maximumFractionDigits: 0 }) : '—';

          anchor +=
            `${i + 1}. ${nameStr}${mark(n)}\n` +
            `   budget: <b>${budgetStr} ${token}</b>  targets: ${targetsStr(n)}  to you: <b>${effStr} ${token}</b>\n`;
        }
        anchor += `<i>targets: valid validators / all nominations</i>`;

        messages.push(anchor);
      } else {
        // Scheduled: compact top-5 inline in the first message (insert before footer)
        let anchorBlock =
          `${EMOJI.nominator} <b>Top anchors</b>  (🔒 ${excCount} → ${fmt(excTotal)})\n`;
        for (let i = 0; i < top.length; i++) {
          const n      = top[i];
          const addr   = n.addr || n.nomAddr || '';
          const short  = addr ? addr.slice(0, 8) + '…' : '?…';
          const effStr = n.effective != null ? n.effective.toLocaleString('en', { maximumFractionDigits: 1 }) : '—';
          anchorBlock += `  ${i + 1}. <code>${short}</code>  eff: ${effStr} ${token}  [${targetsStr(n)}t]${mark(n)}\n`;
        }
        // Rebuild msg1 with anchor inserted before footer
        messages[0] = header + eraLine + predLine + anchorBlock + footer;
      }
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
module.exports.escapeHtml = escapeHtml;
