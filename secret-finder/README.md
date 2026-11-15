# find_secret — get a Kamoer X1 Pro-T's device secret

The local control method needs one secret per pump: its **deviceSecret** (and
LAN prefix). The pump won't hand it out, but **its cloud sends it in the clear**
in the MQTT `thing/lan/prefix/get_reply` during startup. This tool intercepts
that once and writes `kamoer_creds.json` for you.

It runs a TLS man-in-the-middle in front of the pump's cloud MQTT (self-signed
RSA cert — the pump doesn't validate it), relays to the real broker so startup
completes, grabs productKey / deviceName / deviceSecret / LAN-prefix, and exits.

## Requirement: the pump's traffic must reach this proxy
You need the pump's port-1883 (MQTT) traffic to arrive at the machine running
this. Pick whichever fits your setup:

**Option 1 — this machine is the pump's gateway (simplest on a Mac).**
1. Turn on Internet Sharing (System Settings -> General -> Sharing), share to
   Wi-Fi, **channel 1/6/11 (2.4 GHz)**. Put the pump on that Wi-Fi.
2. Find the pump's IP (it's a client of this Mac now).
3. Redirect + run:
   ```
   sudo ./redirect.sh on <pump-ip>
   sudo python3 find_secret.py --pump-ip <pump-ip>
   ```
4. **Power-cycle the pump.** Within ~a minute it captures the secret and writes
   `kamoer_creds.json`. Then: `sudo ./redirect.sh off`

**Option 2 — DNS rewrite (router-agnostic, needs Pi-hole/AdGuard or a router
that supports host overrides).**
1. Point `public.iot-as-mqtt.ap-southeast-1.aliyuncs.com` at this machine's IP.
2. Run the proxy on the real MQTT port (no redirect needed):
   ```
   sudo python3 find_secret.py --pump-ip <pump-ip> --listen 0.0.0.0:1883
   ```
3. Power-cycle the pump. (The proxy still relays to the real broker using an
   honest resolver, so startup completes and the secret comes through.)

## Output
Writes `kamoer_creds.json`:
```json
{ "PK": "...", "DN": "...", "DEVICE_SECRET": "...", "LAN_PREFIX": "..." }
```
Copy it next to `kamoerx1.py` / the bridge and you have full local control — no
cloud needed again. **Keep this file private; it is the key to your pump.**

## Notes
- Works with the pump either freshly provisioned or already on your Wi-Fi, as
  long as it does a startup MQTT connect while the proxy is up (power-cycle it).
- Requires `openssl` (present on macOS/Linux) for the throwaway cert.
- This is the manual, one-time method. A future account-based pairing (sign in
  once, fetch the secret from the cloud) will remove the routing step — see the
  main project's roadmap.
