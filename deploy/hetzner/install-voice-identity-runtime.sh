#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${SIRIUS_APP_DIR:-/opt/sirius}"
PYTHON="$APP_DIR/.venv/bin/python"
REQUIREMENTS="$APP_DIR/backend/requirements-voice-identity.txt"

if [[ "$(id -u)" != 0 ]]; then
  echo "Exécuter avec sudo ; aucune installation automatique avec privilèges implicites." >&2
  exit 1
fi
if [[ ! -x "$PYTHON" || ! -s "$REQUIREMENTS" ]]; then
  echo "Venv ou requirements-voice-identity.txt absent. Déployer le backend avant la préparation." >&2
  exit 1
fi
if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "ffmpeg absent. Installer explicitement : sudo apt-get install ffmpeg" >&2
  exit 1
fi

DIGEST="$(sha256sum "$REQUIREMENTS" | awk '{print $1}')"
MARKER="$APP_DIR/.venv/.sirius-voice-identity-requirements-$DIGEST"
if [[ ! -f "$MARKER" ]]; then
  sudo -u sirius "$PYTHON" -m pip install -r "$REQUIREMENTS"
fi
# Un marqueur seul ne suffit pas si le venv a été réparé ou modifié manuellement.
if ! sudo -u sirius "$PYTHON" -m pip show sherpa-onnx >/dev/null; then
  echo "Moteur sherpa-onnx absent du venv malgré le marqueur : préparation à relancer." >&2
  exit 1
fi
install -o sirius -g sirius -m 0640 /dev/null "$MARKER"
