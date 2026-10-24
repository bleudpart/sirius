#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${SIRIUS_APP_DIR:-/opt/sirius}"
DATA_DIR="${SIRIUS_DATA_DIR:-/var/lib/sirius}"
CONFIG_DIR="${SIRIUS_CONFIG_DIR:-/etc/sirius}"
MODEL_SHA="e9848563da86f263117134dfd7ad63c92355b37de492b55e325400c9d9c39012"
MODEL_NAME="wespeaker_en_voxceleb_resnet34_LM.onnx"
MODE="${1:-}"
SOURCE="${2:-}"

if [[ ( "$MODE" != "--check" && "$MODE" != "--prepare" ) || -z "$SOURCE" || $# != 2 ]]; then
  echo "Usage : bash prepare-voice-identity.sh --check|--prepare /chemin/absolu/$MODEL_NAME" >&2
  echo "--check vérifie les prérequis sans écrire ; --prepare installe sans activer ni redémarrer." >&2
  exit 2
fi
if [[ "$SOURCE" != /* || ! -f "$SOURCE" || -L "$SOURCE" ]]; then
  echo "Modèle absent, chemin relatif ou lien symbolique refusé." >&2
  exit 1
fi
if [[ ! -x "$APP_DIR/.venv/bin/python" || ! -f "$APP_DIR/backend/voice_identity_worker.py"
  || ! -s "$APP_DIR/backend/requirements-voice-identity.txt" ]]; then
  echo "Backend de vérification vocale ou venv absent : déployer le code avant la préparation." >&2
  exit 1
fi
if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "ffmpeg absent. Installer explicitement : sudo apt-get install ffmpeg" >&2
  exit 1
fi
ACTUAL_SHA="$(sha256sum "$SOURCE" | awk '{print $1}')"
if [[ "$ACTUAL_SHA" != "$MODEL_SHA" ]]; then
  echo "Empreinte du modèle incorrecte. Aucune installation ni activation effectuée." >&2
  exit 1
fi
if [[ "$MODE" == "--check" ]]; then
  echo "Prérequis de préparation présents et empreinte officielle vérifiée."
  echo "Ce contrôle ne valide ni le chargement du moteur, ni un seuil, ni la précision anti-TV."
  exit 0
fi
if [[ "$(id -u)" != 0 ]]; then
  echo "La préparation nécessite sudo ; aucun changement effectué." >&2
  exit 1
fi
if [[ "$APP_DIR" != /* || "$DATA_DIR" != /* || "$CONFIG_DIR" != /* ]]; then
  echo "Les répertoires de préparation doivent être absolus." >&2
  exit 1
fi

MODEL_DIR="$DATA_DIR/models/voice-identity"
DESTINATION="$MODEL_DIR/$MODEL_NAME"
if [[ -e "$DESTINATION" || -L "$DESTINATION" ]]; then
  if [[ -L "$DESTINATION" || ! -f "$DESTINATION"
    || "$(sha256sum "$DESTINATION" | awk '{print $1}')" != "$MODEL_SHA" ]]; then
    echo "Le modèle installé diffère ; remplacement refusé. Intervention opérateur nécessaire." >&2
    exit 1
  fi
fi

bash "$APP_DIR/deploy/hetzner/install-voice-identity-runtime.sh"
install -d -o root -g sirius -m 0750 "$MODEL_DIR"
STAGING="$(mktemp "$MODEL_DIR/.model.XXXXXX")"
trap 'rm -f -- "$STAGING"' EXIT
install -o root -g sirius -m 0640 "$SOURCE" "$STAGING"
if [[ "$(sha256sum "$STAGING" | awk '{print $1}')" != "$MODEL_SHA" ]]; then
  echo "Empreinte de la copie incorrecte : publication refusée." >&2
  exit 1
fi
mv -f -- "$STAGING" "$DESTINATION"

FFMPEG="$(command -v ffmpeg)"
# Le worker vérifie le hash et charge réellement le modèle, sans audio utilisateur.
sudo -u sirius "$APP_DIR/.venv/bin/python" - \
  "$APP_DIR/backend/voice_identity_worker.py" "$DESTINATION" "$MODEL_SHA" "$FFMPEG" <<'PY'
import json
import subprocess
import sys

worker, model, digest, ffmpeg = sys.argv[1:]
payload = {"model_path": model, "sha256": digest, "ffmpeg": ffmpeg, "audio": []}
result = subprocess.run(
    [sys.executable, worker], input=json.dumps(payload), capture_output=True,
    text=True, timeout=30, check=True,
)
response = json.loads(result.stdout)
if response.get("error") or response.get("dimension") != 256 or response.get("embeddings") != []:
    raise SystemExit("Chargement du modèle invalide : préparation non approuvée.")
print("Modèle chargé : 256 dimensions ; aucun audio utilisateur envoyé.")
PY

install -d -o root -g root -m 0750 "$CONFIG_DIR"
# Marqueur d'installation optionnelle seulement, jamais lu comme configuration applicative.
install -o root -g root -m 0600 /dev/null "$CONFIG_DIR/voice-identity.prepared"
echo "Préparation terminée. Aucun fichier de configuration du service n'a été modifié."
echo "Aucun seuil choisi ; protection non activée par ce script ; aucun redémarrage."
echo "Modèle : $DESTINATION"
echo "SHA256 : $MODEL_SHA"
