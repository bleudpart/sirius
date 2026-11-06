#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "$0")/../.." && pwd)"
SCRIPT="$ROOT/deploy/hetzner/cleanup-releases.sh"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf -- "$TMP_DIR"' EXIT

RELEASES_DIR="$TMP_DIR/releases"
mkdir -p "$RELEASES_DIR"

for index in 1 2 3 4 5 6 7; do
  release="$RELEASES_DIR/$(printf '%040d' "$index")-ABC123"
  mkdir "$release"
  touch -d "2026-01-01 +$index days" "$release"
done

CURRENT_RELEASE="$RELEASES_DIR/$(printf '%040d' 1)-ABC123"
bash "$SCRIPT" "$RELEASES_DIR" "$CURRENT_RELEASE" 5

[[ -d "$RELEASES_DIR/$(printf '%040d' 1)-ABC123" ]]
for index in 3 4 5 6 7; do
  [[ -d "$RELEASES_DIR/$(printf '%040d' "$index")-ABC123" ]]
done
[[ ! -e "$RELEASES_DIR/$(printf '%040d' 2)-ABC123" ]]
[[ "$(find "$RELEASES_DIR" -mindepth 1 -maxdepth 1 -type d | wc -l)" -eq 6 ]]

echo "cleanup-releases: OK"
