#!/usr/bin/env bash
# Install the daily Bosun job as systemd user units for this checkout. Run again after
# moving the checkout. Enable with: systemctl --user enable --now leeboard-bosun.timer
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
units="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
mkdir -p "$units"
sed "s|@REPO@|$repo|g" "$repo/deploy/leeboard-bosun.service.in" > "$units/leeboard-bosun.service"
cp "$repo/deploy/leeboard-bosun.timer" "$units/leeboard-bosun.timer"
systemctl --user daemon-reload
echo "installed leeboard-bosun.service and leeboard-bosun.timer in $units"
