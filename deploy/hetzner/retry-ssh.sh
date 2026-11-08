#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -eq 0 ]]; then
  echo "::error::No SSH operation was provided." >&2
  exit 2
fi

if "$@"; then
  exit 0
fi
echo "::warning::SSH operation failed; retrying once after 30 seconds." >&2
sleep 30
"$@"
