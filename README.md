# Polkadot Validator Monitor

Self-hosted Telegram bot for monitoring a Polkadot validator. Built for the post-AHM world (November 2025) where staking data lives on Asset Hub while session keys remain on the Relay Chain.

## Features

- **Node health** — polls `system_health` on your validator's HTTP RPC every 60s; alerts on offline/online transitions; disabled automatically if `NODE_RPC_ENDPOINT` is empty
- **Active/inactive** — tracks era status via `erasStakersOverview`
- **Nominator changes** — two-tier scan: active nominators every 5 min, waiting (all `staking.nominators`) every 4h; alerts when stake change exceeds `MIN_STAKE_CHANGE` DOT
- **Payouts** — catches `staking.Rewarded` events; fallback scan via `erasRewardPoints` every ~100 blocks
- **Session keys** — monitors `session.nextKeys` on Relay Chain every 5 min
- **Slash / Chill** — instant alerts on `staking.Slashed` and `staking.Chilled` events
- **Oversubscription** — checks nominator count vs `OVERSUB_LIMIT` every 30 min
- **Slot position** — Phragmén simulation predicting your rank for the next era; runs on a schedule and on demand via `/rank`

## Bot Commands

| Command | Description |
|---|---|
| `/status` | Current era, rank, stake, session keys, recent payouts |
| `/nominators` | Full nominator list — active and waiting |
| `/update` | Refresh nominator database without displaying |
| `/rank` | Phragmén slot position prediction (~1–2 min) |
| `/history` | Last 10 reward payouts |
| `/help` | Command list |

## Requirements

- Node.js 18+
- A running Polkadot validator (or any SS58 address to monitor)
- A Telegram bot token from [@BotFather](https://t.me/BotFather)

## Installation

```bash
git clone https://github.com/youruser/polkadot-validator-monitor.git
cd polkadot-validator-monitor
npm install
cp .env.example .env
# Edit .env with your values
node index.js
```

### Running with PM2

```bash
npm install -g pm2
pm2 start index.js --name polkamon
pm2 save
pm2 startup
```

## Configuration

Copy `.env.example` to `.env` and fill in the required values:

```env
VALIDATOR_ADDRESS=14PkBX3B...            # your validator stash address
TELEGRAM_BOT_TOKEN=123456:ABC...         # from @BotFather
TELEGRAM_CHAT_ID=-100123456789           # your chat or channel ID
NODE_RPC_ENDPOINT=http://127.0.0.1:9933  # leave empty to disable node healthcheck
```

See `.env.example` for all options with descriptions.

## Standalone Scripts

### Era Buffer (`era-buffer.js`)

Shows your validator's real position in the current era — authoritative on-chain data, no simulation.

```bash
node era-buffer.js                         # uses VALIDATOR_ADDRESS from .env
node era-buffer.js 15MUBwP6dyVw5...        # any validator address
```

**Active:** rank, era stake, buffer over last (#600), surrounding ±5 validators.  
**Waiting:** ledger.active vs threshold, deficit, waiting queue rank.

### Slot Position (`slot-position.js`)

Full Phragmén simulation predicting next-era rank.

```bash
node slot-position.js                      # uses VALIDATOR_ADDRESS from .env
node slot-position.js 15MUBwP6dyVw5...     # any validator address
```

Caches nominator structure, ledger balances, and self-stakes for 1h in `.nominators-*.json` files.

## Architecture

```
index.js              — entry point, config, command wiring, Phragmén scheduler
src/
  watcher.js          — chain subscriptions, monitoring logic, /status data
  notifier.js         — Telegram bot, alert templates, command handlers
  state.js            — LevelDB persistent store
  phragmen.js         — Phragmén simulation module (slot position)
slot-position.js      — standalone Phragmén script
era-buffer.js         — standalone era position script
```

### Post-AHM API notes

After the Asset Hub Migration (AHM, November 2025):

- **Staking data** lives on **Asset Hub** (`RPC_ENDPOINT` = `wss://polkadot-asset-hub-rpc.polkadot.io`)
- **Session keys** remain on **Relay Chain** (`RC_RPC_ENDPOINT` = `wss://rpc.polkadot.io`)
- `erasStakers` is replaced by `erasStakersOverview` + `erasStakersPaged`
- `staking.Rewarded` event layout: `data[0]=stash`, `data[2]||data[1]=amount`

## Phragmén Simulation Accuracy

The simulation predicts rank reliably (~±50 positions). Absolute stake values are estimates — the real Phragmén algorithm redistributes large multi-target nominations in ways that are hard to reproduce without exact rational arithmetic.

Use the **era buffer from `/rank`** (sourced directly from `erasStakers`) as the authoritative risk measure, not the simulated buffer.

## License

MIT
