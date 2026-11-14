# Kamoer X1 Pro-T — Local Control: Complete Method & Reference

**Goal achieved:** full local control of the Kamoer X1 Pro-T WiFi dosing pump —
speed, dosing, continuous run, stop — over the LAN with **no Kamoer/Alibaba
cloud, no account binding, and no hardware modification**. Verified on a real
pump driving its motor, and integrated into Home Assistant.

This document is the complete method: how it works, the protocol, how to bring
up **any** X1 Pro-T, and **how to obtain the one secret the method needs**.

---

## 1. The short version

The pump is an Alibaba IoT ("Living Link" / Feiyan) device. Besides its cloud
MQTT connection, its firmware runs a **local control server (ALCS)** on the LAN:
CoAP over UDP port 5683. That local server authenticates with the device's own
**deviceSecret** — no cloud, no binding. Once you have the deviceSecret you can:

1. Authenticate a local session to the pump (CoAP/ALCS handshake).
2. Send native command frames (select Manual mode, run at a speed, stop).
3. Drive the motor directly — speed x time = dose.

Everything else (the Home Assistant bridge, schedules) is built on those three
steps.

The earlier belief that actuation required cloud binding was **wrong**. The real
requirements were: the correct frame format, selecting **Manual mode first**,
and the local device-secret auth. Binding is never needed.

---

## 2. What you need per pump

| Item | For this pump | How to get it (any pump) |
|---|---|---|
| productKey (PK) | `a1ArHZrSOGC` | same for all X1 Pro-T; from device info or the APK |
| deviceName (DN) | `<YOUR_DEVICE_NAME>` | printed/derived from MAC; readable locally (device.info.get) |
| **deviceSecret** | `<YOUR_DEVICE_SECRET>` | **see Section 6 — this is the one secret you must obtain** |
| LAN prefix | `<YOUR_LAN_PREFIX>` | captured with the deviceSecret (Section 6) |
| MAC | `<YOUR_PUMP_MAC>` | sticker / router |

> The deviceSecret is sensitive — it is the key to the pump. Keep it local.

PK and DN are not secret (DN is visible in the pump's local `device.info.get`).
Only the **deviceSecret** (and the LAN prefix that comes with it) must be
obtained once per pump.

---

## 3. Local authentication (ALCS)

CoAP GET to `coap://<pump-ip>:5683/dev/<PK>/<DN>/core/service/auth` with a JSON
body. Derivation (from Alibaba iotkit-embedded, verified against the pump):

```
accessKey   = LAN_PREFIX + "00" + "001"
accessToken = Base64( HMAC-SHA1( key=deviceSecret, msg=accessKey ) )
randomKey   = 16 random hex chars (client)
sign        = Base64( HMAC-SHA1( key=accessToken, msg=randomKey ) )

POST params: {prodKey, deviceName, encrypt:"payload", randomKey, sign, accessKey}
```

The pump replies `code:200` with its own `randomKey`, `sign`, and a `sessionId`.
Verify its sign (note: the pump returns a 15-char random but signs the padded
16-byte field — append a trailing NUL when verifying). Then:

```
sessionKey = HMAC-SHA1( key=accessToken, msg=randomKey + serverRandom )   # first 16 bytes = AES key
```

Subsequent commands are CoAP with the body AES-128-CBC encrypted (IV =
`a1b1c1d1e1f1g1h1`), session id carried in CoAP option 71. (SDK quirk: process
full blocks as one CBC stream, then reset IV for the final padded block.)

Commands are sent to:
`/sys/<PK>/<DN>/thing/service/property/set` with
`{"method":"thing.service.property.set","params":{"PumpSerialNumber":"<hex frame>"}}`.

---

## 4. The command protocol

All commands are hex frames carried in the `PumpSerialNumber` property.

**General frame:** `[seq:1] 02 [payload-len:2 BE] [group:2 BE] [command:2 BE] [payload]`
The sequence byte must advance each command.

**Select Manual mode** (required before dosing):
`[seq] 02 0002 0006 0016 0000`  (group 0006, cmd 0016, mode 0 = Manual)
Modes: 0=Manual, 1=Plan, 2=Continuity, 3=Auto Speed.

**Dose / run / stop** (group 0006, cmd 0014, 15-byte payload):
```
[channel:1=00] [mode:1=00] [action:1]
[volume float32 BE] [00000000] [speed float32 BE]
```
- action `01` = START, `00` = STOP.
- volume: the pump's own volume request; for duration-driven control set it high
  (e.g. 9999) and send STOP yourself after the desired time.
- speed: RPM setpoint (verified: shaft tracks 120/240/350). Keep <= 350 (the
  app's supported ceiling). Example floats: 1.0=`3f800000`, 50.0=`42480000`,
  350.0=`43af0000`.

**Confirmed working start frame (50 mL @ 350):**
`f302000f00060014000001424800000000000043af0000`

**Control model:** volume = speed x time. Pick a speed, START, STOP after the
time that delivers the dose. Microdose (low speed, short) to continuous (any
speed, run for hours) all come from these two knobs. The motor ramps down on
STOP, so a dose has a small tail — calibrate by catching real output.

**Status read:** frame `[seq] 02 0001 0006 0001 00`. (Generic property/get
returns empty; the native status frame carries mode/calibration/RPM, e.g. body
offsets 5-8 = calibration float, 9-12 = RPM float.)

---

## 5. Bringing up any X1 Pro-T — procedure

1. **Provision onto WiFi (2.4 GHz only).** Either the Kamoer app (simplest,
   one time) or the app-free provisioner (`provisioner/provision.py`): join the
   pump's `KAMOER_xxxx` hotspot, serve the page, enter SSID/password. The
   provisioner encrypts the WiFi password exactly as the firmware expects
   (Section 7). Ignore any "binding failed" message — binding is not used.
2. **Obtain the deviceSecret + LAN prefix** (Section 6) — once per pump.
3. **Find the pump's IP** (router/DHCP; set a reservation) or auto-discover by MAC.
4. **Control it:** `python3 kamoerx1.py --host <ip> auth` then `... dose --speed 200 --seconds 5`,
   or run the Home Assistant bridge (`kamoer_bridge.py`).

---

## 6. How to find the device secret (the key step)

The pump will not hand out its deviceSecret directly. Two methods:

### Method A — Capture it from the cloud (proven, works today)
The Alibaba cloud **sends the deviceSecret to the pump in the clear** inside the
MQTT `thing/lan/prefix/get_reply` during startup. Intercept that once:

1. Put the pump on a network you control (e.g. a Mac sharing its connection, or
   a router whose DNS you can point). The pump uses its gateway's DNS, so
   hostnames can be redirected without touching the pump.
2. The pump connects to `public.iot-as-mqtt.ap-southeast-1.aliyuncs.com:1883`
   over **TLS 1.2 (cipher 0x003d, legacy RSA)** and **does not validate the
   server certificate**. Stand up a TLS-terminating proxy with a self-signed RSA
   cert, redirect the pump's port 1883 to it (macOS `pf rdr`), and relay to the
   real broker so startup completes.
3. In the decrypted stream, read `thing/lan/prefix/get_reply` — it contains the
   **deviceSecret** and the **LAN prefix**. Capture both. (Tools:
   `kamoer_capture_proxy.py` + redirect script.)

This is a one-time capture per pump. After it, the pump never needs the cloud again.

### Method B — Fetch it from your Kamoer account (turnkey, for the public release)
During normal provisioning the app itself fetches the deviceSecret from the
Alibaba cloud using the signed-in account (region `ap-southeast-1`). A packaged
integration can do the same: sign in to the user's Kamoer account once, call the
device-provisioning/secret API for the pump (by PK + DN), store the secret, then
run fully local. This removes the MITM step and is the planned basis for the
HACS "sign in once, then local forever" pairing. (Flow understood from the app's
cloud traffic; the secret-fetch endpoint is the remaining piece to finalize.)

### Notes
- The **LAN prefix** is needed alongside the deviceSecret and is captured with it
  in Method A. It has been stable across re-provisioning in testing.
- deviceName is derivable/readable locally; productKey is constant for the model.

---

## 7. App-free provisioning (WiFi password encryption)

The pump decrypts the WiFi password during awss dev-AP using AES-128-CBC:
```
key = SHA256( secret + "," + random )[:16]
iv  = random            # 16 bytes, supplied by the provisioner in the request
cipher = hex( AES128-CBC( zero-padded-password ) )
```
`secret` is the **deviceSecret** for device-level encryption (the X1 Pro-T
reports `cipherType 4` = device level). Request goes as a CoAP GET to
`/sys/awss/device/softap/switchap` on `192.168.4.1` with
`params:{ssid, random(32 hex), passwd(hex cipher), bssid}`. Open networks need
no secret (empty passwd). Source of truth: Alibaba iotkit-embedded
`awss_dev_ap.c` / `awss_crypt.c`.

---

## 8. Home Assistant integration

**Now (working):** `kamoer_bridge.py` — a small MQTT bridge that does the local
control above and exposes a native doser device (Speed, Dose Volume, Dose Now,
Continuous, Stop, Status) via MQTT discovery. Self-configuring: auto-discovers
the pump, re-discovers on IP change, auto-reconnects, dead-man auto-stop. Runs on
any macOS/Linux box on the LAN; `install.sh` registers it (launchd/systemd, in a
venv). Entities work on desktop and mobile.

**Next (host-agnostic, install-for-anyone):** a native HA **custom integration**
installed via **HACS**. Runs inside Home Assistant itself — no external process,
works on HA OS / Container / Core on any hardware. Config flow for setup, LAN
discovery, async CoAP/ALCS, native entities. Uses Method B pairing so a stranger
can install from HACS and get going without a MITM capture.

## 9. Calibration & safety
- Calibrate: run at 350 RPM for a measured time into a graduated cylinder; record
  mL/min. The controller scales linearly with speed.
- Safety: every run has a dead-man auto-stop; the bridge stops the pump on
  shutdown; the pump ramps down smoothly. No liquid sensor — supervise new
  schedules until trusted.

## 10. Tool index
- `kamoerx1.py` — self-contained LAN controller (auth, dose, stop, discovery).
- `kamoer_bridge.py` — MQTT <-> pump bridge for Home Assistant.
- `provisioner/provision.py` — app-free WiFi setup (local web UI + CoAP).
- `kamoer_capture_proxy.py` + redirect script — Method A deviceSecret capture.
- `install.sh` — OS-aware service installer (venv + launchd/systemd).
- `homeassistant/` — dashboard card + scheduler package.

## 11. Open items
- Finalize Method B secret-fetch endpoint for turnkey pairing.
- Build the HACS custom integration (config flow + async control + pairing).
- Measured-volume calibration on this unit.
- Optional: live RPM/calibration telemetry via the native status frame.
