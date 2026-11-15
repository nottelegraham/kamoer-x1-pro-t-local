# Sentinel X1 Pro-T

Smart dosing for the Kamoer X1 Pro-T on top of the local bridge
(`kamoer_bridge.py`). Home Assistant runs the engine; the bridge moves the motor.

## Files
| File | Goes to |
|---|---|
| `packages/sentinel_x1.yaml` | `config/packages/` |
| `themes/sentinel.yaml` | `config/themes/` |
| `www/sentinel-x1-card.js`, `www/sentinel-x1-logo.svg` | `config/www/sentinel-x1/` |
| `dashboard/sentinel_x1_dashboard.yaml` | pasted into a new dashboard's raw config |

Add the card as a dashboard resource: Settings › Dashboards › ⋮ › Resources › Add,
URL `/local/sentinel-x1/sentinel-x1-card.js`, type JavaScript module. Bump `?v=` after updates.

## Install
1. **Remove the old package.** Delete the `kamoer_doser: !include …` line from
   `configuration.yaml` (its every-30-min automation would dose on top of this one).
2. Add to `configuration.yaml`:
   ```yaml
   homeassistant:
     packages:
       sentinel_x1: !include packages/sentinel_x1.yaml
   frontend:
     themes: !include_dir_merge_named themes
   ```
   (Skip the `frontend:` lines if you already load a themes folder.)
3. Check configuration, restart Home Assistant.
4. Run **Sentinel X1 · Load defaults (run once)** (Pump tab, bottom). It leaves
   dosing **off**.
5. Settings › Dashboards › Add dashboard › New from scratch › "Sentinel X1" ›
   Edit › ⋮ › Raw configuration editor › paste the dashboard file › Save.
6. Restart the bridge once (`launchctl kickstart -k gui/$(id -u)/com.telegraham.kamoer-bridge`),
   then calibrate on the Pump tab. The dashboard is the only place you enter it;
   the bridge saves it in `calibration.json`.
7. Set the daily target, window and pauses, fill in the pH / return-pump /
   AWC entity IDs, then switch **Dosing** on.

Needs Home Assistant 2024.11 or newer (sections view, heading card, tile features).

## How the engine works
- Every minute `sensor.sentinel_x1_engine` works out the plan: the window
  (24 h or start/stop, overnight allowed), the distribution weight for this
  hour, the mode, and anything that should pause dosing.
- At :30 s the **Tick** automation acts:
  - **Continuous:** sets speed = planned mL/min ÷ calibration and keeps
    `switch.kamoer_x1_pro_t_kamoer_continuous` on, re-sending speed every 20 min so the
    bridge's 30-min dead-man never trips mid-run.
  - **Microdose / Bolus:** adds this minute's share to an accumulator and fires
    one pulse when it reaches the pulse size (at most one per minute).
- **Auto** picks continuous only if the slowest planned hour needs at least the
  *Min stable continuous speed*; otherwise it microdoses.
- Delivered volume, container level and tubing hours are counted from
  commands sent, so they are only as accurate as the calibration.

## Calibration
Three speeds plus a pulse check, all on the Pump tab:
1. **Low speed, 5 min** at your minimum stable speed (default 30 RPM): enter mL collected.
2. **200 RPM, 60 s**: enter mL collected.
3. **350 RPM, 60 s**: enter mL collected.
4. **Pulse check**: 50 pulses of the smallest pulse; enter mL collected. Sets a
   correction factor for pulse-sized doses (≤ 1 mL), since start/stop losses
   don't show up in timed runs.

Each run shows a live countdown (`timer.sentinel_x1_cal`) and the expected
result: ±10 % of the previous calibration, snapshotted when the run starts
(`input_number.sentinel_x1_cal_expect_*`). The pulse check expects 50 × the
smallest pulse. A result outside the range is flagged; re-run to confirm.

Pulses (doses that take 10 s or less) are started and stopped on one LAN
session by the bridge, so the stop isn't delayed by a fresh auth handshake.
Each pulse's measured on-time is published as `sensor.kamoer_x1_pro_t_kamoer_last_pulse`
(attributes: planned_s, on_s, start/stop ack ms).

Flow at any speed is interpolated between the points (through 0 at 0 RPM).
Dosing pauses itself during a run; nothing is owed or caught up afterwards.
After 90 days a dismissible "recalibration recommended" note appears on the
dashboard and in notifications. It is a recommendation only and never stops dosing.

## Safety behaviour
| Condition | Effect | Missed volume |
|---|---|---|
| Dosing off, no calibration, pump offline/error | pause | dropped |
| Container ≤ stop level | pause + alert | dropped |
| pH above ceiling (until below resume) | pause + alert | dropped |
| Return pump entity `off` | pause + alert | dropped |
| AWC / maintenance entity `on` | pause | dropped |
| Feeding window, Pause 1 h | pause | catch-up over 6 h (≤25% of daily) or dropped |
| Outside window | idle | n/a |
| Daily / hourly ceiling | pause + alert | dropped |

If Home Assistant stops, the engine stops: no new pulses, and any continuous
run ends at the bridge's 30-min limit.

## Placeholders to set
Min stable continuous speed (30 RPM), pulse speed (200 RPM), pH 8.45/8.35,
container 2,500 mL, feeding 18:00 for 30 min, lights 10:00–20:00, KH target
8.3. All are editable on the dashboard.
