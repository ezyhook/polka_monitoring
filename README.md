# Polkadot Validator Monitor

Self-hosted Telegram bot for monitoring a Polkadot validator. Built for the post-AHM world (November 2025) where staking data lives on Asset Hub while session keys remain on the Relay Chain.

## Features

- **Node health** — polls `system_health` on your validator's HTTP RPC every 60s; alerts on offline/syncing/online transitions (`NODE_*_THRESHOLD`); disabled automatically if `NODE_RPC_ENDPOINT` is empty
- **Active/inactive** — tracks status in the active era via `erasStakersOverview`
- **Nominator changes** — two-tier scan: active nominators every 5 min, waiting (all `staking.nominators`) every 4h; alerts when stake change exceeds `MIN_STAKE_CHANGE` DOT
- **Payouts** — catches `staking.Rewarded` events (era taken from `PayoutStarted`, pages summed); history bootstrapped from chain (commission + own-stake share)
- **Session keys** — monitors `session.nextKeys` on Relay Chain every 5 min
- **Slash / Chill** — instant alerts on `staking.Slashed` and `staking.Chilled` events
- **RPC connectivity** — alerts if the monitor's Asset Hub RPC stops delivering blocks
- **Slot position** — next era from the on-chain election result (or Seq-Phragmén + balancing on the official snapshot while the election runs), plus a forecast of the following election; scheduled and on demand via `/rank`

## Bot Commands

| Command | Description |
|---|---|
| `/status` | Current era, rank, stake, session keys, recent payouts |
| `/nominators` | Full nominator list — active and waiting |
| `/update` | Refresh nominator database without displaying |
| `/rank` | Next era position + forecast (~5 s cached, ~2 min cold) |
| `/history` | Last 10 reward payouts |
| `/help` | Command list |

## Requirements

- Node.js 18+
- A running Polkadot validator (or any SS58 address to monitor)
- A Telegram bot token from [@BotFather](https://t.me/BotFather)

## Installation

```bash
git clone https://github.com/ezyhook/polka_monitoring.git
cd polka_monitoring
npm install
cp .env.example .env
# Edit .env with your values
node index.js
```

### Running with PM2

```bash
npm install -g pm2
pm2 start ecosystem.config.js
pm2 save
pm2 startup
```

## Configuration

Copy `.env.example` to `.env` and fill in the required values. The bot always takes values from `.env`, even if the same variable is already set in the environment (e.g. inherited from a parent process):

```env
VALIDATOR_ADDRESS=14PkBX3B...            # your validator stash address
TELEGRAM_BOT_TOKEN=123456:ABC...         # from @BotFather
TELEGRAM_CHAT_ID=-100123456789           # your chat or channel ID
NODE_RPC_ENDPOINT=http://127.0.0.1:9933  # leave empty to disable node healthcheck
```

See `.env.example` for all options with descriptions.

## Node RPC via SSH Tunnel

If the bot runs on a separate machine from the validator, expose the node's RPC port securely over SSH instead of opening it to the internet.

### Quick start (script)

```bash
# Edit TUNNEL_HOST (and optionally other variables) in scripts/rpc-tunnel.sh
TUNNEL_HOST=1.2.3.4 TUNNEL_USER=ubuntu ./scripts/rpc-tunnel.sh start
./scripts/rpc-tunnel.sh status
./scripts/rpc-tunnel.sh stop
```

The script opens `127.0.0.1:9933` locally and forwards it to port `9933` on the validator server. Then set in `.env`:

```env
NODE_RPC_ENDPOINT=http://127.0.0.1:9933
```

### Persistent tunnel with systemd

```bash
# 1. Copy the unit file
sudo cp scripts/rpc-tunnel.service /etc/systemd/system/polkamon-rpc-tunnel.service

# 2. Edit the unit — set User, TUNNEL_HOST, TUNNEL_USER, TUNNEL_KEY
sudo nano /etc/systemd/system/polkamon-rpc-tunnel.service

# 3. Enable and start
sudo systemctl daemon-reload
sudo systemctl enable --now polkamon-rpc-tunnel

# Check
systemctl status polkamon-rpc-tunnel
journalctl -u polkamon-rpc-tunnel -f
```

The tunnel restarts automatically if SSH drops (`Restart=always`, 10 s delay).

**Pre-requisite:** the bot's SSH key must be authorised on the validator server:
```bash
ssh-copy-id -i ~/.ssh/id_ed25519.pub ubuntu@<validator-ip>
```

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

Same analysis as `/rank`, printed to the console.

```bash
node slot-position.js                      # uses VALIDATOR_ADDRESS from .env
node slot-position.js 15MUBwP6dyVw5...     # any validator address
node slot-position.js 15MUB... --fresh     # ignore the voter cache
```

Caches the voter list (bags-list order, stakes, targets) for 1h in `.npos-voters.json`.

## Architecture

```
index.js              — entry point, config, command wiring, Phragmén scheduler
src/
  watcher.js          — chain subscriptions, monitoring logic, /status data
  notifier.js         — Telegram bot, alert templates, command handlers
  state.js            — LevelDB persistent store
  phragmen.js         — slot position analysis (chain result / snapshot / simulation)
  npos.js             — Seq-Phragmén + balancing (port of sp-npos-elections)
  phragmen-runner.js  — runs the analysis in a short-lived child process
  lock.js             — non-blocking mutex for heavy jobs
test/                 — unit tests (npm test)
slot-position.js      — standalone Phragmén script
era-buffer.js         — standalone era position script
```

### Post-AHM API notes

After the Asset Hub Migration (AHM, November 2025):

- **Staking data** lives on **Asset Hub** (`RPC_ENDPOINT` = `wss://polkadot-asset-hub-rpc.polkadot.io`)
- **Session keys** remain on **Relay Chain** (`RC_RPC_ENDPOINT` = `wss://rpc.polkadot.io`)
- `erasStakers` is replaced by `erasStakersOverview` + `erasStakersPaged`
- `staking.Rewarded` event layout: `stash, dest, amount`; the era comes from the preceding `PayoutStarted`
- `currentEra` is the *planned* era: the election for era N+1 starts as soon as era N is active. Use `activeEra` for "now".

## Slot Position Accuracy

On Asset Hub the election for era N+1 runs right after era N starts, so `/rank` shows:

1. **Next era** — the exported on-chain result (exact). During the ~1h election window: Seq-Phragmén + balancing on the official `multiBlockElection` snapshot.
2. **Forecast** — the election after that, simulated on current state: voters walked in bags-list order and capped at the snapshot size (32 × 704), exactly like staking builds the snapshot.

Validated on era 2329: on the official snapshot the simulation elected the same 600 validators with a median stake error of 0.00% (p90 0.02%); on current state 0.01% (p90 0.04%).

**Watch the buffer, not the rank.** Balancing pulls supports together — ~190 validators sit within ±0.1% of each other, so a few hundred DOT moves the rank by dozens of places while the buffer barely changes. Danger levels use buffer as % of the last elected stake (<5% danger, <15% caution).

Per-nominator splits ("to you") from a simulation are one of many equivalent balanced solutions; on-chain values are exact.

## License

MIT
