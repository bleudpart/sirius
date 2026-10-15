#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${SIRIUS_APP_DIR:-/opt/sirius}"
BACKEND_DIR="$APP_DIR/backend"
VENV_DIR="$APP_DIR/.venv"
PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-$APP_DIR/.cache/ms-playwright}"

if [[ "${EUID}" -ne 0 ]]; then
  exec sudo "$0" "$@"
fi

if [[ ! -d "$APP_DIR/.git" ]]; then
  echo "$APP_DIR n'est pas un dépôt Git." >&2
  exit 1
fi

cd "$APP_DIR"
BEFORE_REQUIREMENTS=""
if [[ -f "$BACKEND_DIR/requirements.txt" ]]; then
  BEFORE_REQUIREMENTS="$(sha256sum "$BACKEND_DIR/requirements.txt" | awk '{print $1}')"
fi

echo "==> Mise à jour du dépôt"
sudo -u sirius git fetch --prune origin master
sudo -u sirius git reset --hard origin/master
chown -R sirius:sirius "$APP_DIR"

if [[ ! -x "$VENV_DIR/bin/python" ]]; then
  echo "==> Création du venv"
  sudo -u sirius python3.12 -m venv "$VENV_DIR"
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