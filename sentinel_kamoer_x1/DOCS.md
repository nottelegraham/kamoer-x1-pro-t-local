# Sentinel Kamoer X1 Bridge

Runs the Kamoer X1 Pro-T bridge inside Home Assistant. It talks to the pump on your
LAN (no Kamoer cloud) and creates the pump's entities through MQTT discovery.

## Setup
1. Install the **Mosquitto broker** add-on (the bridge uses its login automatically).
2. In **Configuration**, fill in your pump's `product_key`, `device_name`,
   `device_secret` and `lan_prefix` (see `docs/METHOD_AND_REFERENCE.md`, section 6).
3. Optional: `pump_host` (the pump's IP, as a starting hint) and `pump_mac`.
   If the IP stops answering, the bridge finds the pump again by MAC.
4. Turn on **Start on boot** and **Watchdog**, then start the add-on.

## Self-restart
With Watchdog on, Home Assistant restarts the add-on if it crashes, if MQTT has been
down for 3 minutes, or if the pump has not answered for
`restart_if_pump_unreachable_minutes` (0 turns this one off).

## Moving from the Mac/Linux bridge
Stop the old bridge first (two bridges fight over the same MQTT name). To keep your
calibration, copy its `calibration.json` to `/share/kamoer/` before the first start.
