#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# rpc-tunnel.sh — persistent SSH tunnel to the validator node's RPC port
#
# Opens a local port (default: 9933) that forwards to the RPC port on the
# validator server over SSH.  The bot then sets:
#   NODE_RPC_ENDPOINT=http://127.0.0.1:9933
#
# Usage:
#   ./scripts/rpc-tunnel.sh [start|stop|status|restart]
#
# Configuration — edit the variables below or export them before calling:
#   TUNNEL_USER      SSH user on the validator server
#   TUNNEL_HOST      Hostname or IP of the validator server
#   TUNNEL_PORT      SSH port on the validator server (default: 22)
#   TUNNEL_KEY       Path to SSH private key (default: ~/.ssh/id_ed25519)
#   LOCAL_PORT       Local port the bot connects to (default: 9933)
#   REMOTE_PORT      RPC port on the validator server (default: 9933)
#   REMOTE_HOST      Host on the validator server side (default: 127.0.0.1)
# ─────────────────────────────────────────────────────────────────────────────

TUNNEL_USER="${TUNNEL_USER:-ubuntu}"
TUNNEL_HOST="${TUNNEL_HOST:-}"          # REQUIRED — set in env or edit here
TUNNEL_PORT="${TUNNEL_PORT:-22}"
TUNNEL_KEY="${TUNNEL_KEY:-$HOME/.ssh/id_ed25519}"
LOCAL_PORT="${LOCAL_PORT:-9933}"
REMOTE_PORT="${REMOTE_PORT:-9933}"
REMOTE_HOST="${REMOTE_HOST:-127.0.0.1}"

PID_FILE="/tmp/polkamon-rpc-tunnel.pid"
LOG_FILE="$(dirname "$0")/../logs/rpc-tunnel.log"
mkdir -p "$(dirname "$LOG_FILE")"

# ── helpers ──────────────────────────────────────────────────────────────────

die() { echo "ERROR: $*" >&2; exit 1; }

is_running() {
  [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null
}

start_tunnel() {
  [[ -z "$TUNNEL_HOST" ]] && die "TUNNEL_HOST is not set. Edit $0 or export the variable."

  if is_running; then
    echo "Tunnel already running (PID $(cat "$PID_FILE"))"
    return
  fi

  echo "$(date -Iseconds) Starting SSH tunnel ${LOCAL_PORT} -> ${TUNNEL_HOST}:${REMOTE_PORT}" >> "$LOG_FILE"

  ssh \
    -N \
    -o "ExitOnForwardFailure=yes" \
    -o "ServerAliveInterval=30" \
    -o "ServerAliveCountMax=3" \
    -o "StrictHostKeyChecking=accept-new" \
    -o "BatchMode=yes" \
    -i  "$TUNNEL_KEY" \
    -p  "$TUNNEL_PORT" \
    -L  "127.0.0.1:${LOCAL_PORT}:${REMOTE_HOST}:${REMOTE_PORT}" \
    "${TUNNEL_USER}@${TUNNEL_HOST}" \
    >> "$LOG_FILE" 2>&1 &

  echo $! > "$PID_FILE"
  sleep 1

  if is_running; then
    echo "Tunnel started — PID $(cat "$PID_FILE")  local: 127.0.0.1:${LOCAL_PORT}"
  else
    echo "Tunnel failed to start — check $LOG_FILE"
    rm -f "$PID_FILE"
    exit 1
  fi
}

stop_tunnel() {
  if is_running; then
    kill "$(cat "$PID_FILE")" && echo "Tunnel stopped."
    rm -f "$PID_FILE"
  else
    echo "Tunnel is not running."
  fi
}

status_tunnel() {
  if is_running; then
    echo "Tunnel is running — PID $(cat "$PID_FILE")  127.0.0.1:${LOCAL_PORT} -> ${TUNNEL_HOST}:${REMOTE_PORT}"
  else
    echo "Tunnel is NOT running."
  fi
}

# ── main ─────────────────────────────────────────────────────────────────────

case "${1:-start}" in
  start)   start_tunnel  ;;
  stop)    stop_tunnel   ;;
  restart) stop_tunnel; sleep 1; start_tunnel ;;
  status)  status_tunnel ;;
  *)       echo "Usage: $0 {start|stop|restart|status}"; exit 1 ;;
esac
