#!/usr/bin/env bash
# Sauvegarde quotidienne chiffrée (restic) de /var/lib/sirius vers une Hetzner Storage Box.
set -euo pipefail

APP_DIR="${SIRIUS_APP_DIR:-/opt/sirius}"
DATA_DIR="${SIRIUS_DATA_DIR:-/var/lib/sirius}"
BACKUP_ENV="/etc/sirius/backup.env"
PYTHON="$APP_DIR/.venv/bin/python"

if [[ "$(id -u)" != 0 ]]; then
  echo "Exécuter en root." >&2
  exit 1
fi
if [[ ! -f "$BACKUP_ENV" ]]; then
  echo "$BACKUP_ENV absent : lancer d'abord prepare-backup.sh." >&2
  exit 1
fi
set -a
# shellcheck source=/dev/null
source "$BACKUP_ENV"
set +a

# Chemin fixe : restic retrouve ainsi la sauvegarde précédente d'un jour à l'autre.
SNAPSHOT_DIR="/var/tmp/sirius-sqlite-snapshot"
rm -rf -- "$SNAPSHOT_DIR"
install -d -m 0700 "$SNAPSHOT_DIR"
trap 'rm -rf -- "$SNAPSHOT_DIR"' EXIT

# Copie cohérente des bases SQLite pendant que le service tourne (API de sauvegarde SQLite).
"$PYTHON" - "$DATA_DIR" "$SNAPSHOT_DIR" <<'PY'
import sqlite3
import sys
from pathlib import Path

source_root, target_root = Path(sys.argv[1]), Path(sys.argv[2])
for path in source_root.rglob("*"):
    if not path.is_file() or path.suffix not in {".sqlite3", ".sqlite", ".db"}:
        continue
    with path.open("rb") as handle:
        if handle.read(16) != b"SQLite format 3\x00":
            continue
    target = target_root / path.relative_to(source_root)
    target.parent.mkdir(parents=True, exist_ok=True)
    source = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=30)
    destination = sqlite3.connect(target)
    try:
        source.backup(destination)
        if destination.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
            raise SystemExit(f"Copie SQLite corrompue : {path}")
    finally:
        destination.close()
        source.close()
    print(f"SQLite copiée : {path.relative_to(source_root)}")
PY

cd /
restic backup --host sirius-hetzner --tag sirius \
  --exclude "$DATA_DIR/**/*.sqlite3" --exclude "$DATA_DIR/**/*.sqlite3-wal" --exclude "$DATA_DIR/**/*.sqlite3-shm" \
  --exclude "$DATA_DIR/**/*.sqlite" --exclude "$DATA_DIR/**/*.sqlite-wal" --exclude "$DATA_DIR/**/*.sqlite-shm" \
  --exclude "$DATA_DIR/**/*.db" --exclude "$DATA_DIR/**/*.db-wal" --exclude "$DATA_DIR/**/*.db-shm" \
  --exclude "$DATA_DIR/embeddings" --exclude "$DATA_DIR/.cache" \
  "$DATA_DIR" "$SNAPSHOT_DIR"

restic forget --host sirius-hetzner --tag sirius --keep-daily 30 --keep-weekly 12 --keep-monthly 24 --prune
restic check --read-data-subset=5%
echo "Sauvegarde ΣIRIUS terminée : $(date -Is)"
