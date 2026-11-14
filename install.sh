#!/bin/bash
# OS-aware installer for the Kamoer X1 Pro-T HA bridge.
# Creates a per-machine virtualenv (outside iCloud) so Homebrew/PEP-668 Python
# won't block installs, then registers an always-on service: launchd (macOS) or
# systemd (Linux). Detects Home Assistant OS and explains the alternative there.
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
OS="$(uname -s)"
LABEL="com.telegraham.kamoer-bridge"
VENV="$HOME/.kamoer-bridge-venv"
PYBOOT="$(command -v python3)"

echo "[*] bridge dir: $DIR"
echo "[*] OS:         $OS"
echo "[*] bootstrap python: $PYBOOT"

# --- per-machine venv (kept out of iCloud; each machine/arch needs its own) ---
if [ ! -x "$VENV/bin/python" ]; then
  echo "[*] creating virtualenv at $VENV"
  "$PYBOOT" -m venv "$VENV"
fi
PY="$VENV/bin/python"
echo "[*] installing deps into the venv (no system Python touched)..."
"$VENV/bin/pip" install --quiet --upgrade pip
"$VENV/bin/pip" install --quiet paho-mqtt cryptography pyyaml
"$PY" -c 'import paho.mqtt.client, yaml, cryptography; print("[+] deps OK: paho-mqtt, pyyaml, cryptography")'

if grep -q "REPLACE_WITH_REEF_MQTT_PASSWORD" "$DIR/config.yaml"; then
  echo "!! config.yaml still has the placeholder MQTT password - edit it first."
fi

if [ -d /usr/share/hassio ] || [ -f /etc/hassos-release ]; then
  echo ""
  echo ">> Home Assistant OS detected (locked appliance). Run this bridge on another"
  echo ">> always-on box on your LAN (a Pi, a NAS, the Mac mini) pointing mqtt.host at"
  echo ">> this HA's IP, or package it as an add-on (ask Claude)."
  exit 0
fi

case "$OS" in
  Darwin)
    PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
    launchctl unload "$PLIST" 2>/dev/null || true
    cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$PY</string><string>$DIR/kamoer_bridge.py</string></array>
  <key>WorkingDirectory</key><string>$DIR</string>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$DIR/bridge.log</string>
  <key>StandardErrorPath</key><string>$DIR/bridge.log</string>
</dict></plist>
PL
    launchctl load "$PLIST"
    echo "[+] launchd service (re)loaded. Logs: $DIR/bridge.log"
    echo "    tail -f \"$DIR/bridge.log\"   |   stop: launchctl unload $PLIST"
    ;;
  Linux)
    UNIT="/etc/systemd/system/kamoer-bridge.service"
    SUDO=""; [ "$(id -u)" -ne 0 ] && SUDO="sudo"
    $SUDO bash -c "cat > $UNIT" <<UN
[Unit]
Description=Kamoer X1 Pro-T HA bridge
After=network-online.target
Wants=network-online.target
[Service]
Type=simple
User=$USER
WorkingDirectory=$DIR
ExecStart=$PY $DIR/kamoer_bridge.py
Restart=always
RestartSec=5
[Install]
WantedBy=multi-user.target
UN
    $SUDO systemctl daemon-reload
    $SUDO systemctl enable --now kamoer-bridge.service
    echo "[+] systemd service installed. logs: journalctl -u kamoer-bridge -f"
    ;;
  *) echo "!! unknown OS; run manually: $PY $DIR/kamoer_bridge.py" ;;
esac
