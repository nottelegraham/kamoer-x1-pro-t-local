# Changelog

## 2026-11-15 — Sentinel X1 smart dosing + accuracy work

### Bridge (`kamoer_bridge.py`, `kamoerx1.py`)
- Pulses of 10 s or less start and stop on one LAN session, timed from the START frame,
  with a spin-wait for the last 0.5 s. macOS timer coalescing used to stretch 0.13 s pulses
  by 100–200 ms.
- Fast STOP retry (0.15 s, up to 8 tries); recorded on-time ends at the acknowledged STOP.
- `sensor.*_last_pulse` with planned vs actual on-time and the spread of the last 50 pulses.
- Overdose guard: a pulse that overruns (>1.5x and >0.2 s) or a STOP that never acks latches
  a fault (`binary_sensor.*_pulse_fault`); all doses are refused until cleared from HA.
- Manual Speed / Dose volume / Continuous controls removed from the dashboard's Bridge panel
  (they bypassed the engine's accounting and caps).

### Home Assistant (`sentinel-x1/`)
- New package + custom card (`custom:sentinel-x1-card`, views dosing / status / settings).
  Supersedes `homeassistant/kamoer_doser.yaml`; do not run both.
- Three-speed calibration (low / 200 / 350 RPM) with live countdowns, ±10 % expected ranges,
  and a 25 % sanity check before a big change is saved. All three points are required to dose.
- Pulse check with an explicit Save (preview first). Speed test tool: timed run at any RPM,
  compare with the estimate, optionally make it the low calibration point.
- Speeds shown and entered in mL/min, converted with the calibration curve.
- Minimum pulse of 2 pump-head turns: sub-turn pulses measured 0.4x–2.5x of target.
- Calibration refuses to run while the schedule is on; offers to pause it, asks to restart it
  afterwards, and alerts every 30 min while it stays off.
- Overdose guards: pH above the alarm limit pauses dosing (auto-resume after 30 min under it);
  KH above target + max daily rise pauses dosing.
- Clear calibration button. Container-days no longer reads 0 (false "container low") when not dosing.
