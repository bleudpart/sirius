#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${SIRIUS_APP_DIR:-/opt/sirius}"
BACKEND_DIR="$APP_DIR/backend"
VENV_DIR="$APP_DIR/.venv"
PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-$APP_DIR/.cache/ms-playwright}"
FRONTEND_ARCHIVE="${1:-}"
EXPECTED_SHA="${2:-}"
WEB_DIR="/var/www/sirius"

if [[ "${EUID}" -ne 0 ]]; then
  exec sudo "$0" "$@"
fi

if [[ ! -d "$APP_DIR/.git" ]]; then
  echo "$APP_DIR n'est pas un dépôt Git." >&2
  exit 1
fi

cd "$APP_DIR"
if [[ -n "$FRONTEND_ARCHIVE" ]]; then
  if [[ ! "$EXPECTED_SHA" =~ ^[a-f0-9]{40}$ || "$FRONTEND_ARCHIVE" != "/tmp/sirius-frontend-$EXPECTED_SHA/frontend-web.tar.gz" || ! -f "$FRONTEND_ARCHIVE" ]]; then
    echo "Archive frontend ou revision invalide." >&2
    exit 1
  fi
fi
BEFORE_REQUIREMENTS=""
if [[ -f "$BACKEND_DIR/requirements.txt" ]]; then
  BEFORE_REQUIREMENTS="$(sha256sum "$BACKEND_DIR/requirements.txt" | awk '{print $1}')"
fi

echo "==> Mise à jour du dépôt"
sudo -u sirius git fetch --prune origin master
if [[ -n "$EXPECTED_SHA" && "$(sudo -u sirius git rev-parse origin/master)" != "$EXPECTED_SHA" ]]; then
  echo "Le commit a ete remplace sur master ; ce deploiement est abandonne." >&2
  exit 1
fi
sudo -u sirius git reset --hard origin/master
chown -R sirius:sirius "$APP_DIR"

if [[ ! -x "$VENV_DIR/bin/python" ]]; then
  echo "==> Création du venv"
  sudo -u sirius "$(UV_PYTHON_INSTALL_DIR=/opt/python uv python find 3.12)" -m venv "$VENV_DIR"
fi

AFTER_REQUIREMENTS="$(sha256sum "$BACKEND_DIR/requirements.txt" | awk '{print $1}')"
if [[ "$BEFORE_REQUIREMENTS" != "$AFTER_REQUIREMENTS" || ! -f "$VENV_DIR/.sirius-requirements-$AFTER_REQUIREMENTS" ]]; then
  echo "==> Installation des dépendances Python"
  sudo -u sirius "$VENV_DIR/bin/python" -m pip install --upgrade pip wheel setuptools
  sudo -u sirius "$VENV_DIR/bin/python" -m pip install -r "$BACKEND_DIR/requirements.txt"
  rm -f "$VENV_DIR"/.sirius-requirements-*
  touch "$VENV_DIR/.sirius-requirements-$AFTER_REQUIREMENTS"
  chown sirius:sirius "$VENV_DIR/.sirius-requirements-$AFTER_REQUIREMENTS"
fi

if grep -Eq '^playwright([<=>=~! ]|$)' "$BACKEND_DIR/requirements.txt"; then
  install -d -o sirius -g sirius -m 0755 "$PLAYWRIGHT_BROWSERS_PATH"
  sudo -u sirius env PLAYWRIGHT_BROWSERS_PATH="$PLAYWRIGHT_BROWSERS_PATH" "$VENV_DIR/bin/python" -m playwright install chromium
fi

if [[ -n "$FRONTEND_ARCHIVE" ]]; then
  echo "==> Publication du site statique"
  install -d -m 0755 "$WEB_DIR/releases" "$WEB_DIR/assets/static"
  STAGING_DIR="$(mktemp -d "$WEB_DIR/releases/.incoming.XXXXXX")"
  tar --no-same-owner --no-same-permissions -xzf "$FRONTEND_ARCHIVE" -C "$STAGING_DIR"
  if [[ ! -s "$STAGING_DIR/index.html" || ! -d "$STAGING_DIR/static" || "$(cat "$STAGING_DIR/deploy-sha.txt")" != "$EXPECTED_SHA" ]]; then
    echo "Le build frontend ne correspond pas au commit attendu." >&2
    exit 1
  fi
  chmod -R a+rX "$STAGING_DIR"
  cp -a "$STAGING_DIR/static/." "$WEB_DIR/assets/static/"
  RELEASE_DIR="$WEB_DIR/releases/$EXPECTED_SHA-${STAGING_DIR##*.}"
  mv "$STAGING_DIR" "$RELEASE_DIR"
  caddy validate --config "$APP_DIR/deploy/hetzner/Caddyfile" --adapter caddyfile
  ln -sfn "$RELEASE_DIR" "$WEB_DIR/current.next"
  mv -Tf "$WEB_DIR/current.next" "$WEB_DIR/current"
  install -m 0644 "$APP_DIR/deploy/hetzner/Caddyfile" /etc/caddy/Caddyfile
  systemctl reload caddy
  if [[ "$(curl -fsS --max-time 10 -H 'Host: sirius-assistant.fr' http://127.0.0.1:8080/deploy-sha.txt)" != "$EXPECTED_SHA" ]]; then
    echo "Echec de verification du site publie." >&2
    exit 1
  fi
  rm -f -- "$FRONTEND_ARCHIVE"
  rmdir -- "$(dirname "$FRONTEND_ARCHIVE")"
fi

echo "==> Redémarrage du service"
systemctl restart sirius.service

for attempt in $(seq 1 30); do
  if curl -fsS --max-time 5 http://127.0.0.1:8001/api/health >/dev/null; then
    echo "Déploiement terminé: /api/health OK"
    exit 0
  fi
  echo "Attente santé SIRIUS ($attempt/30)..."
  sleep 2
done

echo "Échec du health check. Derniers journaux:" >&2
journalctl -u sirius.service -n 120 --no-pager >&2 || true
exit 1