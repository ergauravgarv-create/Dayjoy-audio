#!/usr/bin/env bash
#
# Dayjoy training audio - pull the latest code and restart.
#
#   sudo bash /opt/dayjoy-audio/deploy/update.sh
#
# Restarting ends any live session and finalises its recording, so this refuses
# to run while a training is in progress unless you pass --force.

set -euo pipefail

APP_DIR="/opt/dayjoy-audio"
APP_USER="dayjoy"
FORCE="${1:-}"

green() { printf '\033[32m%s\033[0m\n' "$1"; }
warn()  { printf '\033[33m%s\033[0m\n' "$1"; }
die()   { printf '\033[31m%s\033[0m\n' "$1" >&2; exit 1; }

SUDO=""
[ "$(id -u)" -eq 0 ] || SUDO="sudo"

# Never interrupt a training mid-sentence.
if [ "$FORCE" != "--force" ]; then
  live="$(curl -fsS --max-time 5 http://127.0.0.1:8080/api/status 2>/dev/null | grep -o '"live":true' || true)"
  [ -z "$live" ] || die "A training is live right now. Wait for it to end, or re-run with --force."
fi

before="$($SUDO -u "$APP_USER" git -C "$APP_DIR" rev-parse --short HEAD)"

$SUDO -u "$APP_USER" git -C "$APP_DIR" fetch --quiet origin
$SUDO -u "$APP_USER" git -C "$APP_DIR" reset --hard --quiet origin/main
$SUDO -u "$APP_USER" npm --prefix "$APP_DIR" ci --omit=dev --no-audit --no-fund

after="$($SUDO -u "$APP_USER" git -C "$APP_DIR" rev-parse --short HEAD)"

if [ "$before" = "$after" ]; then
  green "Already at $after - nothing to deploy."
else
  green "$before -> $after"
  $SUDO -u "$APP_USER" git -C "$APP_DIR" log --oneline "${before}..${after}" | sed 's/^/  /'
fi

# The unit file itself may have changed.
$SUDO cp "$APP_DIR/deploy/dayjoy-audio.service" /etc/systemd/system/
$SUDO systemctl daemon-reload
$SUDO systemctl restart dayjoy-audio
sleep 2

$SUDO systemctl is-active --quiet dayjoy-audio \
  && green "dayjoy-audio restarted and running" \
  || die "Service failed to start. Rolling back is: git -C $APP_DIR reset --hard $before && systemctl restart dayjoy-audio"

warn "Run preflight before the next training: sudo -u $APP_USER npm --prefix $APP_DIR run preflight"
