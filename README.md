# Polkadot Validator Monitor

A self-hosted monitoring bot for a Polkadot (or Kusama) validator, with real-time alerts and on-demand status reports delivered via Telegram.

No external infrastructure required — runs as a single Node.js process connecting to public RPC endpoints.

## What it monitors

| # | Event | How it's detected |
|---|-------|--------------------|
| 1 | Node online / offline | Heartbeat — alert fires after several consecutive missed block intervals |
| 2 | Validator active / waiting | `staking.erasStakers` (or paged equivalent), checked periodically |
| 3 | Nominator added / removed / stake changed | Two-tier check: active nominators (`erasStakers`, fast) and waiting nominators (`staking.nominators`, full scan) |
| 4 | Reward payout received | `staking.Rewarded` event, real-time |
| 5 | Session key rotation | `session.nextKeys` / `queuedKeys` on the Relay Chain |
| 6 | Slash | `staking.Slashed` event — sent immediately, no cooldown |
| 7 | Forced chill | `staking.Chilled` event |
| 8 | Oversubscription | Nominator count vs. configurable limit (default 512) |

## Architecture

After the Asset Hub Migration (AHM, November 2025), staking state (exposure, nominators, payouts, rewards) lives on **Asset Hub**, while **session keys** remain on the **Relay Chain**. This monitor connects to both:

- `RPC_ENDPOINT` — Asset Hub (staking, nominators, payouts, rewards)
- `RC_RPC_ENDPOINT` — Relay Chain (session keys only)

## Quick start

### 1. Install dependencies
```bash
npm install
```

### 2. Configure
```bash
cp .env.example .env
nano .env
```

At minimum, set these three values:
```env
VALIDATOR_ADDRESS=1xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TELEGRAM_BOT_TOKEN=123456789:AAH...
TELEGRAM_CHAT_ID=-1001234567890
```

#### Getting a Telegram bot token
1. Message [@BotFather](https://t.me/BotFather) → `/newbot`
2. Copy the issued token into `TELEGRAM_BOT_TOKEN`

#### Getting your chat ID
- For a private chat: message [@userinfobot](https://t.me/userinfobot)
- For a group/channel: add the bot as an administrator, send any message, then open:
  `https://api.telegram.org/bot<TOKEN>/getUpdates`

### 3. Run
```bash
npm start
```

On successful startup, the bot sends a confirmation message to the configured chat.

## Bot commands

| Command | Description |
|---------|-------------|
| `/status` | Current validator status: online state, active/waiting, stake, top nominators, session keys, recent payouts, uptime |
| `/nominators` | Full nominator list, split into **active** (currently earning rewards) and **waiting** (nominated but not in the active set) — may take 30–60s for validators with hundreds of nominators |
| `/history` | Last 10 reward payouts |
| `/help` | List of available commands |

## Configuration reference (`.env`)

| Variable | Default | Description |
|----------|---------|-------------|
| `VALIDATOR_ADDRESS` | — | Validator stash address (SS58) **(required)** |
| `TELEGRAM_BOT_TOKEN` | — | Telegram bot token **(required)** |
| `TELEGRAM_CHAT_ID` | — | Target chat/channel ID **(required)** |
| `RPC_ENDPOINT` | `wss://polkadot-asset-hub-rpc.polkadot.io` | Asset Hub WebSocket RPC |
| `RC_RPC_ENDPOINT` | `wss://rpc.polkadot.io` | Relay Chain WebSocket RPC (session keys) |
| `NETWORK` | `polkadot` | Network name shown in alerts |
| `DB_PATH` | `./data/state.db` | LevelDB state directory |
| `HEARTBEAT_INTERVAL` | `60000` | Heartbeat check interval (ms) |
| `NOTIFICATION_COOLDOWN` | `300000` | Minimum pause between same-type alerts (ms) |
| `NOM_CHECK_INTERVAL` | `300000` | Active nominator check interval (ms) |
| `KEY_CHECK_INTERVAL` | `300000` | Session key check interval (ms) |
| `PENDING_CHECK_INTERVAL` | `14400000` | Waiting nominator full-scan interval (ms), default 4h |
| `OVERSUB_LIMIT` | `512` | Nominator count above which an oversubscription alert fires |
| `OFFLINE_THRESHOLD` | `3` | Consecutive missed heartbeats before an offline alert fires |
| `ONLINE_THRESHOLD` | `2` | Consecutive blocks received before an online/recovery alert fires |

### Public RPC endpoints

| Network | Asset Hub (staking) | Relay Chain (session keys) |
|---------|----------------------|------------------------------|
| Polkadot | `wss://polkadot-asset-hub-rpc.polkadot.io` | `wss://rpc.polkadot.io` |
| Kusama | `wss://kusama-asset-hub-rpc.polkadot.io` | `wss://kusama-rpc.polkadot.io` |
| Westend (testnet) | `wss://westend-asset-hub-rpc.polkadot.io` | `wss://westend-rpc.polkadot.io` |

## Project structure

```
polkadot-validator-monitor/
├── index.js          # entry point, configuration, command wiring, graceful shutdown
├── src/
│   ├── watcher.js     # chain subscriptions, all monitoring logic, /status data
│   ├── notifier.js    # Telegram bot, alert templates, command handlers, cooldown
│   └── state.js        # persistent key-value store (LevelDB)
├── data/              # created automatically — LevelDB files
├── .env               # your configuration (do not commit)
├── .env.example       # configuration template
└── package.json
```

## Running as a systemd service (Linux)

Create `/etc/systemd/system/validator-monitor.service`:

```ini
[Unit]
Description=Polkadot Validator Monitor
After=network.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/opt/validator-monitor
ExecStart=/usr/bin/node index.js
Restart=always
RestartSec=15
EnvironmentFile=/opt/validator-monitor/.env

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable validator-monitor
sudo systemctl start validator-monitor
sudo journalctl -fu validator-monitor
```

## Running with Docker

`Dockerfile`:
```dockerfile
FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
VOLUME ["/app/data"]
CMD ["node", "index.js"]
```

Run:
```bash
docker build -t validator-monitor .
docker run -d \
  --name validator-monitor \
  --restart unless-stopped \
  -v $(pwd)/data:/app/data \
  --env-file .env \
  validator-monitor
```

## Notes & caveats

- **State persistence**: do not delete the `data/` directory — it holds the baseline used to detect changes (nominators, session keys, active/inactive status, payout history). Deleting it causes the monitor to treat the next check as a fresh bootstrap (no false alerts, but history is reset).
- **First run**: nominator and session-key baselines are captured silently on the first check — no alerts are fired for pre-existing state.
- **Active vs. waiting nominators**: "active" nominators are part of the current era's exposure and earn rewards; "waiting" nominators have nominated the validator but are not currently in the active set (e.g. validator not elected, or nominator outside the top-N by stake).
- **Dust filtering**: nominator stake changes below 1 token are ignored to avoid noise from rounding/fees.
- **Slashes and chills** are sent immediately, bypassing the cooldown — these are critical events.
- **Session keys**: read from the Relay Chain (`session.nextKeys` / `queuedKeys`). If the Relay Chain RPC is unreachable, `/status` will show "no Relay Chain connection" but all Asset Hub-based monitoring continues normally.
- **Offline/online debounce**: a single missed or received block does not trigger an alert — see `OFFLINE_THRESHOLD` / `ONLINE_THRESHOLD`.
