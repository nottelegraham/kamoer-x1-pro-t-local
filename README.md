# Kamoer X1 Pro-T — Local Control & Home Assistant

Local control of the **Kamoer X1 Pro-T** WiFi dosing pump — speed, dosing,
continuous run, stop — over your LAN, with **no Kamoer cloud, no account
binding, and no hardware modification**.

This is an **interoperability** project: it lets you control a pump **you own**
on your **own network**, locally, after the manufacturer's app/cloud. It talks
to the pump's own on-device local-control server (Alibaba ALCS over CoAP) using
your device's own key.

## What it does
- Authenticates a local session to the pump (no cloud).
- Drives the motor: select speed (RPM) and run for a duration — speed x time = dose.
- Exposes a native **Home Assistant** doser device over MQTT discovery
  (Speed, Dose Volume, Dose Now, Continuous, Stop, Status) — desktop + mobile.
- Includes an app-free WiFi provisioner and the full protocol write-up.

## Quick start
1. Get your pump on 2.4 GHz WiFi (manufacturer app once, or `provisioner/`).
2. Obtain your pump's **device secret** — see `docs/METHOD_AND_REFERENCE.md`,
   Section 6. (The pump doesn't hand it out; the doc explains how.)
3. `cp kamoer_creds.example.json kamoer_creds.json` and fill it in.
4. `cp config.example.yaml config.yaml` and fill in MQTT + pump.
5. Test:  `python3 kamoerx1.py --host <pump-ip> auth`  ->  `LAN auth OK`
6. Run as a service:  `./install.sh`  (venv + launchd/systemd, auto-detected)

The Home Assistant device then appears automatically via MQTT discovery. Add the
card in `homeassistant/dashboard-card.yaml` and the schedules in
`homeassistant/kamoer_doser.yaml`.

## Files
| Path | Purpose |
|---|---|
| `kamoerx1.py` | Self-contained LAN controller (auth, dose, stop, discovery) |
| `kamoer_bridge.py` | MQTT <-> pump bridge for Home Assistant |
| `install.sh` | OS-aware installer (venv + launchd/systemd) |
| `provisioner/provision.py` | App-free WiFi setup (local web UI + CoAP) |
| `homeassistant/` | Lovelace card + scheduler package |
| `docs/METHOD_AND_REFERENCE.md` | Full method, protocol, and how to find the device secret |

## Credentials & privacy
Your `kamoer_creds.json` holds your pump's **device secret** — keep it local; it
is gitignored. Never commit it or `config.yaml`.

## Status
Working: local control verified on real hardware; HA integration running.
Planned: a HACS-installable native HA custom integration with one-time
cloud-assisted pairing (so no manual secret capture) — see the doc's open items.

## Credits & license
See `ACKNOWLEDGEMENTS.md` (ffirenmatana's X2SR work; Alibaba iotkit-embedded).
Licensed MIT — see `LICENSE`.

> Not affiliated with or endorsed by Kamoer or Alibaba. For use with hardware you own.
