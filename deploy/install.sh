#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Install the TIA continuous-deploy systemd *user* units. No system services are
# touched, so nothing else on the host is affected. Run once, from the repo:
#     deploy/install.sh
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UNIT_DIR="$HOME/.config/systemd/user"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"

chmod +x "$SCRIPT_DIR/update.sh"
mkdir -p "$UNIT_DIR"
cp "$SCRIPT_DIR/tia-deploy.service" "$UNIT_DIR/"
cp "$SCRIPT_DIR/tia-deploy.timer"   "$UNIT_DIR/"

# Keep the user manager alive without an interactive login so the timer fires 24/7.
sudo loginctl enable-linger "$USER" || true

systemctl --user daemon-reload
systemctl --user enable --now tia-deploy.timer

echo "── installed ─────────────────────────────────────────────"
systemctl --user list-timers tia-deploy.timer --no-pager || true
echo "logs: $HOME/Deploy/tia-deploy.log"
