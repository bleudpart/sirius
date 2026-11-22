#!/bin/sh
set -eu

if [ "$(id -u)" -ne 0 ]; then
    echo "Lancez ce script avec sudo." >&2
    exit 1
fi

if ! id sirius >/dev/null 2>&1; then
    echo "L'utilisateur Linux « sirius » est introuvable." >&2
    exit 1
fi

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

apt-get update
apt-get install -y cups chromium printer-driver-ptouch
usermod -aG lp sirius
install -d -o sirius -g sirius -m 0700 /home/sirius/.config/sirius
install -d -o sirius -g sirius -m 0700 /home/sirius/.local/share/sirius
install -d -o root -g root -m 0755 /opt/sirius
install -o root -g root -m 0755 "$SCRIPT_DIR/haccp_linux_relay.py" /opt/sirius/haccp_linux_relay.py
install -o root -g root -m 0644 "$SCRIPT_DIR/sirius-haccp-relay.service" /etc/systemd/system/sirius-haccp-relay.service
systemctl enable --now cups
systemctl daemon-reload

echo "Installation terminée. Configurez la file Brother dans CUPS, puis saisissez le jeton avec :"
echo "  sudo -u sirius env HOME=/home/sirius python3 /opt/sirius/haccp_linux_relay.py --configure"
echo "Après l'appairage, démarrez le relais avec :"
echo "  sudo systemctl enable --now sirius-haccp-relay.service"
