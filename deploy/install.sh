#!/usr/bin/env bash
#
# Dayjoy training audio - first-time server setup.
#
# Run ON a fresh Ubuntu 22.04 or 24.04 server, as a user with sudo:
#
#   curl -fsSL https://raw.githubusercontent.com/ergauravgarv-create/Dayjoy-audio/main/deploy/install.sh | bash -s -- listen.dayjoy.in
#
# or, if you have already cloned the repo:
#
#   sudo bash deploy/install.sh listen.dayjoy.in
#
# Safe to re-run. It will not overwrite an existing .env, and it refuses to ask
# for a certificate until DNS actually points here - a failed certbot run counts
# against Let's Encrypt rate limits, so it is worth checking first.

set -euo pipefail

DOMAIN="${1:-}"
REPO="${DAYJOY_REPO:-https://github.com/ergauravgarv-create/Dayjoy-audio.git}"
APP_DIR="/opt/dayjoy-audio"
APP_USER="dayjoy"
NODE_MAJOR=22

green() { printf '\033[32m%s\033[0m\n' "$1"; }
warn()  { printf '\033[33m%s\033[0m\n' "$1"; }
die()   { printf '\033[31m%s\033[0m\n' "$1" >&2; exit 1; }
step()  { printf '\n\033[1m==> %s\033[0m\n' "$1"; }

[ -n "$DOMAIN" ] || die "Usage: bash deploy/install.sh <domain>   e.g. listen.dayjoy.in"

SUDO=""
if [ "$(id -u)" -ne 0 ]; then
  command -v sudo >/dev/null || die "Run as root, or install sudo."
  SUDO="sudo"
fi

# ---------------------------------------------------------------- packages
step "Installing system packages"
$SUDO apt-get update -qq
$SUDO apt-get install -y -qq nginx git curl ca-certificates ufw

if ! command -v node >/dev/null || [ "$(node -v | cut -c2- | cut -d. -f1)" -lt 20 ]; then
  step "Installing Node.js ${NODE_MAJOR}"
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | $SUDO -E bash - >/dev/null
  $SUDO apt-get install -y -qq nodejs
fi
green "node $(node -v), npm $(npm -v)"

# ------------------------------------------------------------------- user
step "Preparing service account and directory"
id -u "$APP_USER" >/dev/null 2>&1 || \
  $SUDO useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin "$APP_USER"

$SUDO mkdir -p "$APP_DIR"
$SUDO chown "$APP_USER:$APP_USER" "$APP_DIR"

# ------------------------------------------------------------------- code
if [ -d "$APP_DIR/.git" ]; then
  step "Updating existing checkout"
  $SUDO -u "$APP_USER" git -C "$APP_DIR" fetch --quiet origin
  $SUDO -u "$APP_USER" git -C "$APP_DIR" reset --hard --quiet origin/main
else
  step "Cloning $REPO"
  $SUDO -u "$APP_USER" git clone --quiet "$REPO" "$APP_DIR"
fi

step "Installing dependencies"
$SUDO -u "$APP_USER" npm --prefix "$APP_DIR" ci --omit=dev --no-audit --no-fund
$SUDO -u "$APP_USER" mkdir -p "$APP_DIR/data/recordings"

# ------------------------------------------------------------------- .env
if [ -f "$APP_DIR/.env" ]; then
  green "Keeping the existing .env"
else
  step "Creating .env with generated console keys"
  $SUDO -u "$APP_USER" cp "$APP_DIR/.env.example" "$APP_DIR/.env"
  for key in TRAINER_KEY ADMIN_KEY REVIEW_KEY COMPLIANCE_KEY; do
    secret="$(openssl rand -hex 24)"
    $SUDO -u "$APP_USER" sed -i "s|^${key}=.*|${key}=${secret}|" "$APP_DIR/.env"
  done
  $SUDO -u "$APP_USER" sed -i "s|^# PUBLIC_URL=.*|PUBLIC_URL=https://${DOMAIN}|" "$APP_DIR/.env"
  grep -q '^PUBLIC_URL=' "$APP_DIR/.env" || \
    echo "PUBLIC_URL=https://${DOMAIN}" | $SUDO -u "$APP_USER" tee -a "$APP_DIR/.env" >/dev/null
fi
$SUDO chmod 600 "$APP_DIR/.env"
$SUDO chown "$APP_USER:$APP_USER" "$APP_DIR/.env"

# ---------------------------------------------------------------- systemd
step "Installing the service"
$SUDO cp "$APP_DIR/deploy/dayjoy-audio.service" /etc/systemd/system/
$SUDO systemctl daemon-reload
$SUDO systemctl enable --now dayjoy-audio
sleep 2
$SUDO systemctl is-active --quiet dayjoy-audio \
  && green "dayjoy-audio is running" \
  || die "Service failed to start. Check: journalctl -u dayjoy-audio -n 50"

# ------------------------------------------------------------------ nginx
step "Configuring nginx for $DOMAIN"
$SUDO sed "s/listen\.dayjoy\.in/${DOMAIN}/g" "$APP_DIR/deploy/nginx.conf" \
  | $SUDO tee "/etc/nginx/sites-available/${DOMAIN}" >/dev/null
$SUDO ln -sf "/etc/nginx/sites-available/${DOMAIN}" "/etc/nginx/sites-enabled/${DOMAIN}"
$SUDO rm -f /etc/nginx/sites-enabled/default
$SUDO nginx -t
$SUDO systemctl reload nginx

step "Opening the firewall"
$SUDO ufw allow OpenSSH >/dev/null
$SUDO ufw allow 'Nginx Full' >/dev/null
$SUDO ufw --force enable >/dev/null
green "ports 22, 80, 443 open"

# -------------------------------------------------------------------- TLS
step "Checking DNS before requesting a certificate"
SERVER_IP="$(curl -fsS --max-time 10 https://api.ipify.org || echo '')"
DNS_IP="$(getent hosts "$DOMAIN" | awk '{print $1}' | head -1 || echo '')"

if [ -z "$DNS_IP" ]; then
  warn "$DOMAIN does not resolve yet. Skipping the certificate."
  warn "Point an A record at ${SERVER_IP:-this server}, then run:"
  warn "  sudo certbot --nginx -d $DOMAIN"
elif [ -n "$SERVER_IP" ] && [ "$DNS_IP" != "$SERVER_IP" ]; then
  warn "$DOMAIN resolves to $DNS_IP but this server is $SERVER_IP."
  warn "Skipping the certificate so a failed attempt does not burn a rate limit."
  warn "Fix the A record, wait for it to propagate, then run:"
  warn "  sudo certbot --nginx -d $DOMAIN"
else
  green "$DOMAIN -> $DNS_IP, matches this server"
  $SUDO apt-get install -y -qq certbot python3-certbot-nginx
  # TLS is not optional: browsers refuse microphone access on anything but
  # localhost over plain HTTP, so the trainer page cannot work without it.
  $SUDO certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos \
    --register-unsafely-without-email --redirect \
    && green "certificate installed" \
    || warn "certbot failed. Run it manually: sudo certbot --nginx -d $DOMAIN"
fi

# ------------------------------------------------------------------- done
step "Done"
echo
echo "  Listeners   https://${DOMAIN}/"
echo "  Trainer     https://${DOMAIN}/trainer?key=$(grep '^TRAINER_KEY=' "$APP_DIR/.env" | cut -d= -f2)"
echo "  Admin       https://${DOMAIN}/admin?key=$(grep '^ADMIN_KEY=' "$APP_DIR/.env" | cut -d= -f2)"
echo "  Review      https://${DOMAIN}/review?key=$(grep '^REVIEW_KEY=' "$APP_DIR/.env" | cut -d= -f2)"
echo "  Compliance  https://${DOMAIN}/compliance?key=$(grep '^COMPLIANCE_KEY=' "$APP_DIR/.env" | cut -d= -f2)"
echo
warn "It is running on MOCK providers - the voice is a warble, not speech."
echo
echo "  To go live:"
echo "    1. sudo -u $APP_USER nano $APP_DIR/.env      # add Azure + Anthropic keys,"
echo "                                                 # set ASR/MT/TTS_PROVIDER"
echo "    2. sudo systemctl restart dayjoy-audio"
echo "    3. sudo -u $APP_USER npm --prefix $APP_DIR run preflight"
echo
echo "  Preflight will refuse to pass until the glossary is reviewed and the"
echo "  claims are signed off. That is the gate, and it is deliberate."
echo
echo "  Logs:  sudo journalctl -u dayjoy-audio -f"
echo
