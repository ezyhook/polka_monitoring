## Polkadot Validator Monitor 🔍
Telegram bot for monitoring a Polkadot/Kusama validator.
## Features

| # | Event | Type |
|---|---|---|
| 1 | Validator online / offline | Polling |
| 2 | Active (in the era set) / Waiting | Polling |
| 3 | Nominator join/leave, stake changes | Polling |
| 4 | Rewards payout to nominators | Event subscription |
| 5 | Session keys change | Polling |

## Quick Start## 1. Clone and Install Dependencies

npm install

## 2. Create a Telegram Bot

   1. Send /newbot to [@BotFather](https://t.me/BotFather)
   2. Get your BOT_TOKEN
   3. Send /start to your new bot
   4. Get your CHAT_ID — open https://api.telegram.org/bot<BOT_TOKEN>/getUpdates and find "id" inside the "chat" object

## 3. Configure .env

cp .env.example .env# Edit .env

TELEGRAM_BOT_TOKEN=123456789:ABCdef...
TELEGRAM_CHAT_ID=123456789

# Polkadot mainnet
RPC_ENDPOINT=wss://rpc.polkadot.io

# Kusama
# RPC_ENDPOINT=wss://kusama-rpc.polkadot.io

# Your validator address (SS58)
VALIDATOR_ADDRESS=1FRMM8PEiWXYax7rpS6X4XZX1aAAxSWx1CrKTyrVYhV2ngU

# Polling interval in seconds
POLL_INTERVAL_SEC=60

# Database path
DB_PATH=./data/state.db

## 4. Run

npm start

## Public RPC Endpoints

| Network | WSS |
|---|---|
| Polkadot | wss://rpc.polkadot.io |
| Polkadot (IBP) | wss://rpc.ibp.network/polkadot |
| Kusama | wss://kusama-rpc.polkadot.io |
| Kusama (IBP) | wss://rpc.ibp.network/kusama |

Public RPCs may have rate limits. For production reliability, run your own node or use OnFinality/Dwellir (they offer a free tier).

## Run as a systemd Service (Linux)

# /etc/systemd/system/validator-monitor.service
[Unit]
Description=Polkadot Validator Monitor
After=network.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/opt/validator-monitor
ExecStart=/usr/bin/node src/index.js
Restart=always
RestartSec=10
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target

sudo systemctl enable validator-monitor
sudo systemctl start validator-monitor
sudo journalctl -u validator-monitor -f

## Run via Docker

FROM node:22-alpineWORKDIR /appCOPY package*.json ./RUN npm ci --omit=devCOPY . .RUN mkdir -p dataCMD ["node", "src/index.js"]

docker build -t validator-monitor .
docker run -d \
  --name validator-monitor \
  --restart unless-stopped \
  -v $(pwd)/.env:/app/.env \
  -v $(pwd)/data:/app/data \
  validator-monitor

## Project Structure

.
├── src/
│   ├── index.js       # Entry point, main loop
│   ├── monitor.js     # All 5 monitoring checks
│   ├── telegram.js    # Notification delivery
│   └── db.js          # LevelDB state management
├── data/              # Database folder (created automatically)
├── .env               # Configuration (do not commit!)
├── .env.example       # Example configuration file
└── package.json

## Notification Examples

🟢 Validator Status
ONLINE
Session: 12345
Address: 1FRMM8P…YhV2ngU

✅ Validator Set Status
ACTIVE (in current era validator set)
Era: 1456
Total stake: 150234.5000 DOT

➕ New Nominator
1ABC123…XYZ789
Stake: 500.0000 DOT

💰 Payout Received
👤 Nominator 1ABC123…XYZ789
Amount: 1.2345 DOT

🔄 Session Keys CHANGED!
1FRMM8P…YhV2ngU
Old: 0x1a2b3c4d…
New: 0x9f8e7d6c…

------------------------------
Would you like help creating the JavaScript source code files (e.g., monitor.js or index.js) using @polkadot/api to implement these checks?

