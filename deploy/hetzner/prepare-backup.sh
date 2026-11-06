#!/usr/bin/env bash
# Préparation unique de la sauvegarde hors serveur.
# Usage : sudo bash /opt/sirius/deploy/hetzner/prepare-backup.sh u123456
set -euo pipefail

BOX_USER="${1:-}"
APP_DIR="${SIRIUS_APP_DIR:-/opt/sirius}"
ENV_DIR="/etc/sirius"
BACKUP_ENV="$ENV_DIR/backup.env"
PASSWORD_FILE="$ENV_DIR/backup-password"
SSH_KEY="/root/.ssh/sirius_backup"
SSH_CONFIG="/root/.ssh/config"

if [[ "$(id -u)" != 0 ]]; then
  echo "Exécuter avec sudo." >&2
  exit 1
fi
if [[ ! "$BOX_USER" =~ ^u[0-9]+(-sub[0-9]+)?$ ]]; then
  echo "Indiquez l'identifiant de la Storage Box, par exemple : u123456" >&2
  exit 1
fi
BOX_HOST="${BOX_USER%%-sub*}.your-storagebox.de"

if ! command -v restic >/dev/null 2>&1; then
  apt-get update
  apt-get install -y restic
fi

install -d -m 0700 /root/.ssh
if [[ ! -f "$SSH_KEY" ]]; then
  ssh-keygen -q -t ed25519 -N "" -C "sirius-backup" -f "$SSH_KEY"
fi
if ! grep -q '^Host sirius-backup$' "$SSH_CONFIG" 2>/dev/null; then
  cat >>"$SSH_CONFIG" <<SSHCONFIG

Host sirius-backup
  HostName $BOX_HOST
  User $BOX_USER
  Port 23
  IdentityFile $SSH_KEY
  IdentitiesOnly yes
  ServerAliveInterval 60
SSHCONFIG
  chmod 0600 "$SSH_CONFIG"
fi
if ! ssh-keygen -F "[$BOX_HOST]:23" >/dev/null 2>&1; then
  ssh-keyscan -p 23 -t ed25519 "$BOX_HOST" >>/root/.ssh/known_hosts
fi

if ! ssh -o BatchMode=yes sirius-backup ls >/dev/null 2>&1; then
  echo "==> Saisissez le mot de passe de la Storage Box (une seule fois) :"
  ssh -o IdentitiesOnly=no -o PubkeyAuthentication=no sirius-backup install-ssh-key <"$SSH_KEY.pub"
fi
ssh -o BatchMode=yes sirius-backup ls >/dev/null

install -d -o root -g root -m 0750 "$ENV_DIR"
NEW_PASSWORD=0
if [[ ! -s "$PASSWORD_FILE" ]]; then
  install -o root -g root -m 0600 /dev/null "$PASSWORD_FILE"
  head -c 32 /dev/urandom | base64 | tr -d '\n=' >"$PASSWORD_FILE"
  NEW_PASSWORD=1
fi
cat >"$BACKUP_ENV" <<ENVFILE
RESTIC_REPOSITORY=sftp:sirius-backup:sirius-restic
RESTIC_PASSWORD_FILE=$PASSWORD_FILE
ENVFILE
chmod 0600 "$BACKUP_ENV"

if [[ "$NEW_PASSWORD" == 1 ]]; then
  echo
  echo "IMPORTANT : notez ce mot de passe de chiffrement dans un endroit sûr, hors du serveur."
  echo "Sans lui, la sauvegarde est illisible si le serveur est perdu :"
  cat "$PASSWORD_FILE"
  echo
fi

set -a
# shellcheck source=/dev/null
source "$BACKUP_ENV"
set +a
if ! restic cat config >/dev/null 2>&1; then
  restic init
fi

install -o root -g root -m 0644 "$APP_DIR/deploy/hetzner/sirius-backup.service" /etc/systemd/system/sirius-backup.service
install -o root -g root -m 0644 "$APP_DIR/deploy/hetzner/sirius-backup.timer" /etc/systemd/system/sirius-backup.timer
systemctl daemon-reload
systemctl enable --now sirius-backup.timer

echo "==> Première sauvegarde"
systemctl start sirius-backup.service
restic snapshots --host sirius-hetzner

echo "Sauvegarde quotidienne active (vers 3 h 30, heure de Paris)."
