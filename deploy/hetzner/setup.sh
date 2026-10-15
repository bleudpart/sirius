#!/usr/bin/env bash
set -euo pipefail

DOMAIN="${1:-${SIRIUS_DOMAIN:-api.sirius-assistant.fr}}"
ACME_EMAIL="${2:-${ACME_EMAIL:-}}"
REPO_URL="${SIRIUS_REPO_URL:-https://github.com/bleudpart/sirius.git}"
APP_DIR="${SIRIUS_APP_DIR:-/opt/sirius}"
BACKEND_DIR="$APP_DIR/backend"
VENV_DIR="$APP_DIR/.venv"
DATA_DIR="${SIRIUS_DATA_DIR:-/var/lib/sirius}"
ENV_DIR="/etc/sirius"
ENV_FILE="$ENV_DIR/sirius.env"
PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-$APP_DIR/.cache/ms-playwright}"
DEFAULT_DOMAIN="api.sirius-assistant.fr"

if [[ "${EUID}" -ne 0 ]]; then
  echo "Ce script doit être exécuté en root (ou via sudo)." >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive

echo "==> Mise à jour du système"
apt-get update
apt-get -y upgrade
apt-get install -y \
  apt-transport-https \
  ca-certificates \
  curl \
  debian-archive-keyring \
  debian-keyring \
  fail2ban \
  git \
  gnupg \
  lsb-release \
  python3.12 \
  python3.12-venv \
  python3-pip \
  ufw \
  unattended-upgrades

cat >/etc/apt/apt.conf.d/20auto-upgrades <<'AUTOUPGRADES'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
AUTOUPGRADES
systemctl enable --now unattended-upgrades

echo "==> Pare-feu et protection SSH"
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable
systemctl enable --now fail2ban

echo "==> Utilisateurs système"
if ! id -u sirius >/dev/null 2>&1; then
  useradd --system --create-home --home-dir "$DATA_DIR" --shell /bin/bash sirius
fi
if ! id -u deploy >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash deploy
fi
install -d -o sirius -g sirius -m 0750 "$DATA_DIR"
install -d -o sirius -g sirius -m 0755 "$APP_DIR"

cat >/etc/sudoers.d/sirius-deploy <<SUDOERS
# Autorise l'utilisateur deploy à relancer uniquement le déploiement SIRIUS.
deploy ALL=(root) NOPASSWD: $APP_DIR/deploy/hetzner/deploy.sh
SUDOERS
chmod 0440 /etc/sudoers.d/sirius-deploy
visudo -cf /etc/sudoers.d/sirius-deploy >/dev/null

echo "==> Installation de Caddy depuis le dépôt officiel"
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
apt-get update
apt-get install -y caddy

echo "==> Code applicatif"
if [[ -d "$APP_DIR/.git" ]]; then
  chown -R sirius:sirius "$APP_DIR"
  sudo -u sirius git -C "$APP_DIR" fetch --prune origin master
  sudo -u sirius git -C "$APP_DIR" reset --hard origin/master
elif [[ -z "$(find "$APP_DIR" -mindepth 1 -maxdepth 1 -print -quit)" ]]; then
  sudo -u sirius git clone "$REPO_URL" "$APP_DIR"
else
  echo "$APP_DIR existe mais n'est pas un dépôt Git vide." >&2
  exit 1
fi

if [[ ! -f "$BACKEND_DIR/requirements.txt" ]]; then
  echo "requirements.txt introuvable dans $BACKEND_DIR" >&2
  exit 1
fi

echo "==> Environnement Python"
sudo -u sirius python3.12 -m venv "$VENV_DIR"
sudo -u sirius "$VENV_DIR/bin/python" -m pip install --upgrade pip wheel setuptools
sudo -u sirius "$VENV_DIR/bin/python" -m pip install -r "$BACKEND_DIR/requirements.txt"

if grep -Eq '^playwright([<=>=~! ]|$)' "$BACKEND_DIR/requirements.txt"; then
  echo "==> Navigateurs Playwright (Chromium)"
  install -d -o sirius -g sirius -m 0755 "$PLAYWRIGHT_BROWSERS_PATH"
  PLAYWRIGHT_BROWSERS_PATH="$PLAYWRIGHT_BROWSERS_PATH" "$VENV_DIR/bin/python" -m playwright install --with-deps chromium
  chown -R sirius:sirius "$PLAYWRIGHT_BROWSERS_PATH"
fi

echo "==> Variables d'environnement"
install -d -o root -g root -m 0750 "$ENV_DIR"
if [[ ! -f "$ENV_FILE" ]]; then
  if [[ -f "$BACKEND_DIR/.env.example" ]]; then
    install -o root -g root -m 0600 "$BACKEND_DIR/.env.example" "$ENV_FILE"
  else
    install -o root -g root -m 0600 /dev/null "$ENV_FILE"
  fi
fi
chmod 0600 "$ENV_FILE"
chown root:root "$ENV_FILE"
grep -q '^SIRIUS_DATA_DIR=' "$ENV_FILE" || echo "SIRIUS_DATA_DIR=$DATA_DIR" >> "$ENV_FILE"
grep -q '^PLAYWRIGHT_BROWSERS_PATH=' "$ENV_FILE" || echo "PLAYWRIGHT_BROWSERS_PATH=$PLAYWRIGHT_BROWSERS_PATH" >> "$ENV_FILE"

echo "==> Service systemd"
install -o root -g root -m 0644 "$APP_DIR/deploy/hetzner/sirius.service" /etc/systemd/system/sirius.service
systemctl daemon-reload
systemctl enable sirius.service

echo "==> Configuration Caddy"
if [[ -n "$ACME_EMAIL" ]]; then
  {
    printf '{\n\temail %s\n}\n\n' "$ACME_EMAIL"
    sed "s/$DEFAULT_DOMAIN/$DOMAIN/g" "$APP_DIR/deploy/hetzner/Caddyfile"
  } > /etc/caddy/Caddyfile
else
  sed "s/$DEFAULT_DOMAIN/$DOMAIN/g" "$APP_DIR/deploy/hetzner/Caddyfile" > /etc/caddy/Caddyfile
fi
chown root:root /etc/caddy/Caddyfile
chmod 0644 /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile
systemctl enable caddy.service

echo "==> Démarrage"
systemctl restart sirius.service
systemctl restart caddy.service

for attempt in $(seq 1 30); do
  if curl -fsS --max-time 5 http://127.0.0.1:8001/api/health >/dev/null; then
    echo "SIRIUS est prêt sur http://127.0.0.1:8001/api/health"
    exit 0
  fi
  sleep 2
done

echo "La sonde de santé ne répond pas. Voir: journalctl -u sirius -n 100 --no-pager" >&2
exit 1