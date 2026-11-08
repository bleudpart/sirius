#!/usr/bin/env bash
set -euo pipefail

for name in HETZNER_HOST HETZNER_USER HETZNER_SSH_KEY HETZNER_HOST_FINGERPRINT; do
  if [[ -z "${!name:-}" ]]; then
    echo "::error::$name is empty; refusing an unverified SSH connection."
    exit 1
  fi
done

if [[ ! "$HETZNER_HOST" =~ ^[A-Za-z0-9][A-Za-z0-9.-]*$ ]]; then
  echo "::error::HETZNER_HOST must be a hostname or IPv4 address."
  exit 1
fi
if [[ ! "$HETZNER_USER" =~ ^[A-Za-z0-9._-]+$ ]]; then
  echo "::error::HETZNER_USER contains unsupported characters."
  exit 1
fi
if [[ ! "$HETZNER_HOST_FINGERPRINT" =~ ^SHA256:[A-Za-z0-9+/]+={0,2}$ ]]; then
  echo "::error::HETZNER_HOST_FINGERPRINT must be a verified SHA256 SSH fingerprint."
  exit 1
fi
if [[ -z "${RUNNER_TEMP:-}" || -z "${GITHUB_ENV:-}" ]]; then
  echo "::error::GitHub Actions runner paths are unavailable."
  exit 1
fi

ssh_dir="$RUNNER_TEMP/sirius-hetzner-ssh"
identity_file="$ssh_dir/id_hetzner"
scan_file="$ssh_dir/host-keys"
known_hosts_file="$ssh_dir/known_hosts"
mkdir -p "$ssh_dir"
chmod 700 "$ssh_dir"
umask 077
printf '%s\n' "$HETZNER_SSH_KEY" > "$identity_file"

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
if ! bash "$script_dir/retry-ssh.sh" ssh-keyscan -T 10 -t ed25519,ecdsa,rsa "$HETZNER_HOST" > "$scan_file"; then
  rm -f "$identity_file" "$scan_file"
  echo "::error::No SSH host keys could be read from HETZNER_HOST."
  exit 1
fi
if [[ ! -s "$scan_file" ]]; then
  rm -f "$identity_file" "$scan_file"
  echo "::error::No SSH host keys could be read from HETZNER_HOST."
  exit 1
fi

: > "$known_hosts_file"
matched=0
keys_seen=0
index=0
while IFS= read -r line; do
  [[ -n "$line" && "$line" != \#* ]] || continue
  candidate="$ssh_dir/candidate-$index"
  printf '%s\n' "$line" | awk 'NF >= 3 {print $2, $3}' > "$candidate"
  if ! fingerprint="$(ssh-keygen -lf "$candidate" 2>/dev/null | awk 'NR == 1 {print $2}')" || [[ -z "$fingerprint" ]]; then
    rm -f "$candidate" "$identity_file" "$known_hosts_file" "$scan_file"
    echo "::error::An invalid SSH host key was received from HETZNER_HOST."
    exit 1
  fi
  rm -f "$candidate"
  keys_seen=$((keys_seen + 1))
  if [[ "$fingerprint" == "$HETZNER_HOST_FINGERPRINT" ]]; then
    printf '%s\n' "$line" >> "$known_hosts_file"
    matched=1
  fi
  index=$((index + 1))
done < "$scan_file"
rm -f "$scan_file"

if [[ "$keys_seen" -eq 0 ]]; then
  rm -f "$identity_file" "$known_hosts_file"
  echo "::error::No SSH host keys could be read from HETZNER_HOST."
  exit 1
fi
if [[ "$matched" -ne 1 ]]; then
  rm -f "$identity_file" "$known_hosts_file"
  echo "::error::The SSH host key does not match HETZNER_HOST_FINGERPRINT."
  exit 1
fi
chmod 600 "$identity_file" "$known_hosts_file"
{
  printf 'HETZNER_SSH_IDENTITY_FILE=%s\n' "$identity_file"
  printf 'HETZNER_SSH_KNOWN_HOSTS_FILE=%s\n' "$known_hosts_file"
} >> "$GITHUB_ENV"
