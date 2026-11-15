#!/bin/bash
# Redirect a pump's :1883 into find_secret's proxy. Host must be the pump's
# gateway (e.g. macOS Internet Sharing = bridge100).  sudo ./redirect.sh on <pump-ip>  |  off
set -e
IFACE="${IFACE:-bridge100}"; ANCHOR="kamoer_find"; PORT="${PORT:-18883}"
if [ "$1" = "on" ]; then
  PUMP="${2:?usage: sudo ./redirect.sh on <pump-ip>}"
  sysctl -w net.inet.ip.forwarding=1 >/dev/null
  echo "rdr pass on $IFACE inet proto tcp from $PUMP to any port 1883 -> 127.0.0.1 port $PORT" > /tmp/$ANCHOR.conf
  pfctl -a "$ANCHOR" -f /tmp/$ANCHOR.conf 2>/dev/null || true
  pfctl -sn 2>/dev/null | grep -q "anchor \"$ANCHOR\"" || (pfctl -sn 2>/dev/null; echo "rdr-anchor \"$ANCHOR\""; echo "anchor \"$ANCHOR\"") | pfctl -f - 2>/dev/null || true
  pfctl -a "$ANCHOR" -f /tmp/$ANCHOR.conf 2>/dev/null || true
  pfctl -e 2>/dev/null || true
  echo "[+] redirect ON: $PUMP:1883 -> 127.0.0.1:$PORT (iface $IFACE)"
elif [ "$1" = "off" ]; then
  pfctl -a "$ANCHOR" -F all 2>/dev/null || true; echo "[+] redirect removed"
else echo "usage: sudo $0 on <pump-ip> | off"; fi
