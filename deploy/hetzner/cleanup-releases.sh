#!/usr/bin/env bash
set -euo pipefail

RELEASES_DIR="${1:?Le dossier des versions est requis.}"
CURRENT_LINK="${2:?Le lien vers la version active est requis.}"
KEEP_COUNT="${3:-5}"

if [[ ! "$KEEP_COUNT" =~ ^[1-9][0-9]*$ ]]; then
  echo "Le nombre de versions a conserver doit etre un entier positif." >&2
  exit 1
fi

RELEASES_DIR="$(readlink -f -- "$RELEASES_DIR")"
CURRENT_RELEASE="$(readlink -f -- "$CURRENT_LINK")"

if [[ ! -d "$RELEASES_DIR" || ! -d "$CURRENT_RELEASE" || "$CURRENT_RELEASE" != "$RELEASES_DIR/"* ]]; then
  echo "La version active ne se trouve pas dans le dossier des versions." >&2
  exit 1
fi

declare -A RETAINED=()
RETAINED["$CURRENT_RELEASE"]=1

mapfile -t RELEASES < <(
  find "$RELEASES_DIR" -mindepth 1 -maxdepth 1 -type d \
    -regextype posix-extended \
    -regex '.*/[a-f0-9]{40}-[A-Za-z0-9]{6}' \
    -printf '%T@ %p\n' |
    LC_ALL=C sort -rn
)

index=0
for entry in "${RELEASES[@]}"; do
  release="${entry#* }"
  index=$((index + 1))
  if (( index <= KEEP_COUNT )); then
    RETAINED["$release"]=1
  fi
done

for entry in "${RELEASES[@]}"; do
  release="${entry#* }"
  if [[ -z "${RETAINED[$release]+x}" ]]; then
    echo "Suppression de l'ancienne version : $(basename -- "$release")"
    rm -rf -- "$release"
  fi
done
