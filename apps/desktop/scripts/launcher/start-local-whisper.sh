#!/usr/bin/env bash
set -euo pipefail

APP_DIR="/Users/james/local-whisper/apps/desktop"
LOG_DIR="$APP_DIR/.pi/tmp"
LOG_FILE="$LOG_DIR/tauri-dev.log"
LAUNCHER_LOG="$LOG_DIR/launcher.log"
PID_FILE="$LOG_DIR/tauri-dev.pid"

# Dock/LaunchServices apps run with a minimal PATH.
export PATH="$HOME/.cargo/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

mkdir -p "$LOG_DIR"

log() {
  printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >>"$LAUNCHER_LOG"
}

is_launcher_pid_running() {
  local pid="$1"
  if [[ -z "$pid" ]]; then
    return 1
  fi
  local cmd
  cmd="$(ps -p "$pid" -o command= 2>/dev/null || true)"
  [[ -n "$cmd" ]] && [[ "$cmd" == *"pnpm tauri dev"* ]]
}

PNPM_BIN=""
for candidate in /usr/local/bin/pnpm /opt/homebrew/bin/pnpm "$(command -v pnpm 2>/dev/null || true)"; do
  if [[ -n "$candidate" && -x "$candidate" ]]; then
    PNPM_BIN="$candidate"
    break
  fi
done

if [[ -z "$PNPM_BIN" ]]; then
  log "ERROR: pnpm not found (PATH=$PATH)"
  exit 1
fi

stop_existing_processes() {
  local stopped=0

  if [[ -f "$PID_FILE" ]]; then
    local existing_pid
    existing_pid="$(cat "$PID_FILE" 2>/dev/null || true)"
    if is_launcher_pid_running "$existing_pid"; then
      log "Restart requested; stopping existing launcher pid=$existing_pid"
      kill "$existing_pid" >/dev/null 2>&1 || true
      stopped=1
    fi
    rm -f "$PID_FILE"
  fi

  local patterns=(
    "$APP_DIR/node_modules/.*/tauri.js dev"
    "$APP_DIR/node_modules/.*/vite/bin/vite.js"
    "/Users/james/local-whisper/target/debug/local-whisper"
  )

  for pattern in "${patterns[@]}"; do
    if pgrep -f "$pattern" >/dev/null 2>&1; then
      pkill -f "$pattern" >/dev/null 2>&1 || true
      stopped=1
    fi
  done

  if [[ "$stopped" -eq 1 ]]; then
    for _ in {1..24}; do
      if ! pgrep -f "/Users/james/local-whisper/target/debug/local-whisper" >/dev/null 2>&1 \
        && ! pgrep -f "$APP_DIR/node_modules/.*/tauri.js dev" >/dev/null 2>&1 \
        && ! pgrep -f "$APP_DIR/node_modules/.*/vite/bin/vite.js" >/dev/null 2>&1; then
        break
      fi
      sleep 0.25
    done
  fi
}

stop_existing_processes

cd "$APP_DIR"
nohup "$PNPM_BIN" tauri dev >"$LOG_FILE" 2>&1 < /dev/null &
LAUNCH_PID=$!
printf '%s\n' "$LAUNCH_PID" > "$PID_FILE"
log "Started launcher process pid=$LAUNCH_PID using $PNPM_BIN (PATH=$PATH)"
