'use strict';

/**
 * Slot position CLI — same analysis as the bot's /rank (src/phragmen.js):
 * on-chain result if the next era is already elected, otherwise
 * Seq-Phragmén + balancing on the election snapshot or the current state.
 *
 * Usage:
 *   node slot-position.js                 # VALIDATOR_ADDRESS from .env
 *   node slot-position.js 1xxx…           # any validator
 *   node slot-position.js 1xxx… --fresh   # ignore the voter cache
 */

require('dotenv').config();
const { ApiPromise, WsProvider } = require('@polkadot/api');
const { analyzeSlotPosition }    = require('./src/phragmen');
const Notifier                   = require('./src/notifier');

const RPC_ENDPOINT      = process.env.RPC_ENDPOINT || 'wss://polkadot-asset-hub-rpc.polkadot.io';
const args              = process.argv.slice(2);
const VALIDATOR_ADDRESS = args.find(a => !a.startsWith('--')) || process.env.VALIDATOR_ADDRESS || '';
const FRESH             = args.includes('--fresh');

if (!VALIDATOR_ADDRESS) {
  console.error('Usage: node slot-position.js <validator-address> [--fresh]');
  console.error('       or set VALIDATOR_ADDRESS in .env');
  process.exit(1);
}

const plain = (html) => html
  .replace(/<a href="([^"]+)">([^<]*)<\/a>/g, '$2')
  .replace(/<[^>]+>/g, '')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

(async () => {
  const api = await ApiPromise.create({ provider: new WsProvider(RPC_ENDPOINT), noInitWarn: true });
  try {
    const result = await analyzeSlotPosition(api, VALIDATOR_ADDRESS, FRESH);
    const msgs   = Notifier.formatRank(result, VALIDATOR_ADDRESS, 'DOT', { topN: 10, links: true });
    console.log('\n' + msgs.map(plain).join('\n\n'));
  } finally {
    await api.disconnect();
  }
  process.exit(0);
})().catch((e) => { console.error('Error:', e.message); process.exit(1); });
