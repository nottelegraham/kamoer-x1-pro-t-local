"""Kamoer X1 Pro-T <-> Home Assistant bridge (MQTT discovery), mature build.

Self-configuring: auto-discovers the pump (and re-discovers if its IP changes),
auto-reconnects to MQTT, tracks availability, and exposes a native doser device
(speed, dose volume, dose button, continuous switch, stop, status/last-run).
Runs anywhere on the pump's LAN (macOS or Linux). No Kamoer cloud.
"""
import os, sys, json, time, signal, threading
import yaml
import paho.mqtt.client as mqtt
from kamoerx1 import Pump, discover, MAX_SPEED, DEFAULT_MAC

HERE = os.path.dirname(os.path.abspath(__file__))
CFG = yaml.safe_load(open(os.path.join(HERE, 'config.yaml'))) or {}
CREDS = json.load(open(os.path.join(HERE, 'kamoer_creds.json')))

DISC = CFG.get('discovery_prefix', 'homeassistant')
NODE = 'kamoer_x1'
BASE = 'kamoerx1'
AVAIL = f'{BASE}/availability'
CAL_FILE = os.path.join(HERE, 'calibration.json')
# Three-point calibration set from Home Assistant (Sentinel X1 dashboard) and
# saved here: measured mL/min at a low RPM, at 200 and at 350, plus a pulse
# factor (delivered / expected) from a 50-pulse check. Flow at any speed is
# interpolated between the points. config.yaml's single value is only a
# first-run fallback for the 350 point.
MID_RPM, HIGH_RPM = 200.0, 350.0
def _load_cal():
    c = {'low_rpm': 30.0, 'low': 0.0, 'mid': 0.0, 'high': 0.0, 'pulse_factor': 1.0}
    try:
        d = json.load(open(CAL_FILE))
        if 'ml_per_min_at_350' in d and 'high' not in d:   # old single-point file
            d = {'high': d['ml_per_min_at_350']}
        c.update({k: float(v) for k, v in d.items() if k in c})
    except Exception:
        c['high'] = float(CFG.get('calibration_ml_per_min_at_350', 0) or 0)
    return c
CAL = _load_cal()
MAXRUN = int(CFG.get('safety_max_run_seconds', 1800))
# Runs this short or shorter are done start->stop on one LAN session (see Pump.pulse).
PULSE_MAX_S = float(CFG.get('pulse_inline_max_seconds', 10))
# Overdose guard: a pulse whose motor on-time ran more than this ratio past plan (and at
# least PULSE_OVERRUN_MIN_S longer) latches a fault. While latched, every dose is refused
# until it is cleared from Home Assistant. Lives in memory; a bridge restart clears it.
PULSE_OVERRUN_RATIO = float(CFG.get('pulse_overrun_ratio', 1.5))
PULSE_OVERRUN_MIN_S = float(CFG.get('pulse_overrun_min_s', 0.2))
fault = {}
PUMP_MAC = CFG.get('pump', {}).get('mac', DEFAULT_MAC)

DEVICE = {'identifiers': [NODE], 'name': 'Kamoer X1 Pro-T',
          'manufacturer': 'Kamoer', 'model': 'X1 Pro-T', 'sw_version': 'local-bridge'}

state = {'speed': float(CFG.get('default_speed_rpm', 200)), 'dose_ml': 10.0,
         'status': 'starting', 'continuous': 'OFF', 'last_run': '', 'pump_ip': ''}
_timer = None
_lock = threading.Lock()
_cancel_ev = threading.Event()   # set by any stop: ends a running pulse early
from collections import deque
_recent = deque(maxlen=50)       # on-time / planned of the last 50 pulses (spread check)
_host = None

def log(*a): print(time.strftime('%H:%M:%S'), *a, flush=True)

# ---------- pump resolution (auto-discover + cache + re-discover) ----------
def resolve_host(force=False):
    global _host
    fixed = CFG.get('pump', {}).get('host')
    if fixed:
        _host = fixed; return _host
    if _host and not force:
        return _host
    log('discovering pump by MAC', PUMP_MAC, '...')
    _host = discover(PUMP_MAC)
    log('pump at', _host) if _host else log('pump not found on network')
    return _host

def with_pump(fn):
    """Run fn(Pump). On failure, re-discover once and retry."""
    h = resolve_host()
    if not h:
        raise RuntimeError('pump not found')
    try:
        return fn(Pump(h, CREDS))
    except Exception as e:
        log('command failed on', h, '-', e, '- re-discovering')
        h2 = resolve_host(force=True)
        if not h2:
            raise
        return fn(Pump(h2, CREDS))

CAL_LIMITS = {'low_rpm': (1, 200), 'low': (0, 200), 'mid': (0, 200), 'high': (0, 200), 'pulse_factor': (0.5, 1.5)}
def set_cal(key, v):
    lo, hi = CAL_LIMITS[key]
    CAL[key] = max(lo, min(hi, float(v)))
    try:
        json.dump(dict(CAL, set_at=time.strftime('%Y-%m-%d %H:%M:%S')), open(CAL_FILE, 'w'))
    except Exception as e:
        log('could not save calibration:', e)

def cal_points():
    pts = [(0.0, 0.0)]
    for r, k in ((CAL['low_rpm'], 'low'), (MID_RPM, 'mid'), (HIGH_RPM, 'high')):
        if CAL[k] > 0 and r > pts[-1][0]:
            pts.append((r, CAL[k]))
    return pts

def flow_ml_min(speed):
    """Measured mL/min at this RPM, interpolated between calibration points."""
    pts = cal_points()
    if len(pts) < 2:
        return None
    for (r0, f0), (r1, f1) in zip(pts, pts[1:]):
        if speed <= r1:
            return f0 + (speed - r0) * (f1 - f0) / (r1 - r0)
    (r0, f0), (r1, f1) = pts[-2], pts[-1]          # beyond last point: extend
    return f1 + (speed - r1) * (f1 - f0) / (r1 - r0)

def ml_per_s(speed):
    f = flow_ml_min(speed)
    return f / 60.0 if f and f > 0 else None

# ---------- HA discovery ----------
def publish_discovery(cli):
    def cfg(comp, oid, payload):
        payload.update({'availability_topic': AVAIL, 'device': DEVICE,
                        'unique_id': f'{NODE}_{oid}', 'object_id': f'{NODE}_{oid}'})
        cli.publish(f'{DISC}/{comp}/{NODE}/{oid}/config', json.dumps(payload), retain=True)
    cfg('number', 'speed', {'name': 'Kamoer Speed', 'command_topic': f'{BASE}/speed/set',
        'state_topic': f'{BASE}/speed/state', 'min': 1, 'max': int(MAX_SPEED), 'step': 1,
        'unit_of_measurement': 'RPM', 'icon': 'mdi:speedometer', 'mode': 'slider'})
    cfg('number', 'dose_ml', {'name': 'Kamoer Dose Volume', 'command_topic': f'{BASE}/dose_ml/set',
        'state_topic': f'{BASE}/dose_ml/state', 'min': 0.1, 'max': 500, 'step': 0.1,
        'unit_of_measurement': 'mL', 'icon': 'mdi:cup-water', 'mode': 'box'})
    cfg('button', 'dose', {'name': 'Kamoer Dose Now', 'command_topic': f'{BASE}/dose/press', 'icon': 'mdi:play'})
    cfg('switch', 'continuous', {'name': 'Kamoer Continuous', 'command_topic': f'{BASE}/continuous/set',
        'state_topic': f'{BASE}/continuous/state', 'payload_on': 'ON', 'payload_off': 'OFF', 'icon': 'mdi:pump'})
    cli.publish(f'{DISC}/number/{NODE}/calibration/config', '', retain=True)   # retire old 1-point entity
    for key, name, unit, step, icon in (
            ('low_rpm', 'Kamoer Cal Low Speed', 'RPM', 1, 'mdi:speedometer-slow'),
            ('low', 'Kamoer Cal Low', 'mL/min', 0.01, 'mdi:beaker-outline'),
            ('mid', 'Kamoer Cal 200 RPM', 'mL/min', 0.01, 'mdi:beaker-half-outline'),
            ('high', 'Kamoer Cal 350 RPM', 'mL/min', 0.01, 'mdi:beaker'),
            ('pulse_factor', 'Kamoer Pulse Factor', None, 0.001, 'mdi:water-check')):
        lo, hi = CAL_LIMITS[key]
        pl = {'name': name, 'command_topic': f'{BASE}/cal_{key}/set', 'state_topic': f'{BASE}/cal_{key}/state',
              'min': lo, 'max': hi, 'step': step, 'mode': 'box', 'icon': icon}
        if unit: pl['unit_of_measurement'] = unit
        cfg('number', f'cal_{key}', pl)
    cfg('button', 'stop', {'name': 'Kamoer Stop', 'command_topic': f'{BASE}/stop/press', 'icon': 'mdi:stop'})
    cfg('binary_sensor', 'pulse_fault', {'name': 'Kamoer Pulse Fault', 'state_topic': f'{BASE}/fault/state',
        'json_attributes_topic': f'{BASE}/fault/attr', 'payload_on': 'ON', 'payload_off': 'OFF',
        'device_class': 'problem', 'icon': 'mdi:alert-octagon'})
    cfg('button', 'clear_fault', {'name': 'Kamoer Clear Fault', 'command_topic': f'{BASE}/clear_fault/press', 'icon': 'mdi:restore-alert'})
    cfg('sensor', 'status', {'name': 'Kamoer Status', 'state_topic': f'{BASE}/status/state', 'icon': 'mdi:information-outline'})
    cfg('sensor', 'last_run', {'name': 'Kamoer Last Run', 'state_topic': f'{BASE}/last_run/state', 'icon': 'mdi:history'})
    cfg('sensor', 'last_pulse', {'name': 'Kamoer Last Pulse', 'state_topic': f'{BASE}/last_pulse/state',
        'json_attributes_topic': f'{BASE}/last_pulse/attr', 'unit_of_measurement': 's',
        'state_class': 'measurement', 'force_update': True, 'icon': 'mdi:pulse', 'entity_category': 'diagnostic'})
    cfg('sensor', 'pump_ip', {'name': 'Kamoer IP', 'state_topic': f'{BASE}/pump_ip/state',
        'icon': 'mdi:ip-network', 'entity_category': 'diagnostic'})

def push(cli):
    cli.publish(f'{BASE}/fault/state', 'ON' if fault else 'OFF', retain=True)
    cli.publish(f'{BASE}/fault/attr', json.dumps(fault or {}), retain=True)
    cli.publish(f'{BASE}/speed/state', round(state['speed']), retain=True)
    cli.publish(f'{BASE}/dose_ml/state', round(state['dose_ml'], 1), retain=True)
    for key in CAL_LIMITS:
        cli.publish(f'{BASE}/cal_{key}/state', round(CAL[key], 3), retain=True)
    cli.publish(f'{BASE}/continuous/state', state['continuous'], retain=True)
    cli.publish(f'{BASE}/status/state', state['status'], retain=True)
    cli.publish(f'{BASE}/last_run/state', state['last_run'], retain=True)
    cli.publish(f'{BASE}/pump_ip/state', state['pump_ip'] or 'searching', retain=True)

def _cancel():
    global _timer
    if _timer: _timer.cancel(); _timer = None

def do_stop(cli, reason=''):
    _cancel_ev.set()
    with _lock:
        _cancel()
        try:
            with_pump(lambda p: p.stop()); state['pump_ip'] = _host or ''
        except Exception as e:
            log('stop error:', e); state['status'] = 'offline'; push(cli); return
        state['continuous'] = 'OFF'; state['status'] = 'idle'
        if reason: state['last_run'] = reason
        push(cli)

def start_run(cli, speed, run_seconds, label):
    global _timer
    with _lock:
        _cancel()
        try:
            ok = with_pump(lambda p: p.dose(speed)); state['pump_ip'] = _host or ''
        except Exception as e:
            log('dose error:', e); state['status'] = 'offline'; push(cli); return
        if not ok:
            state['status'] = 'error'; push(cli); return
        state['status'] = 'running'; state['last_run'] = label; push(cli)
        secs = min(run_seconds or MAXRUN, MAXRUN)
        _timer = threading.Timer(secs, lambda: do_stop(cli, label + ' (done)'))
        _timer.daemon = True; _timer.start()

def run_pulse(cli, speed, secs, label):
    """Short dose: start and stop on one session so the on-time is the planned
    time plus a few ms of network, not plus a fresh auth handshake."""
    with _lock:
        _cancel(); _cancel_ev.clear()
        state['status'] = 'running'; state['last_run'] = label; push(cli)
        started = stopped = False; info = {}
        try:
            h = resolve_host()
            if not h: raise RuntimeError('pump not found')
            started, stopped, info = Pump(h, CREDS).pulse(speed, secs, _cancel_ev)
            state['pump_ip'] = h
        except Exception as e:
            log('pulse error:', e)
        if not stopped:                                   # belt and braces
            fault.update(reason='stop not acknowledged', label=label, at=time.strftime('%Y-%m-%d %H:%M:%S'))
            try: with_pump(lambda p: p.stop())
            except Exception as e: log('pulse fallback stop failed:', e); state['status'] = 'offline'; push(cli); return
        info.update(speed_rpm=round(speed), started=started)
        log('pulse', label, info)
        on, pl = info.get('on_s'), info.get('planned_s')
        if on and pl and on > pl * PULSE_OVERRUN_RATIO and on - pl > PULSE_OVERRUN_MIN_S:
            fault.update(reason='pulse overran', label=label, on_s=on, planned_s=round(pl, 3),
                         ratio=round(on / pl, 2), at=time.strftime('%Y-%m-%d %H:%M:%S'))
        if fault: log('FAULT latched:', fault)
        if 'on_s' in info:
            if info.get('planned_s'): _recent.append(info['on_s'] / info['planned_s'])
            if _recent:
                r = sorted(_recent)
                info.update(recent_n=len(r), recent_min_ratio=round(r[0], 3),
                            recent_max_ratio=round(r[-1], 3), recent_avg_ratio=round(sum(r) / len(r), 3))
            cli.publish(f'{BASE}/last_pulse/attr', json.dumps(info))
            cli.publish(f'{BASE}/last_pulse/state', info['on_s'])
        state['status'] = 'idle'   # stopped (in-session or fallback); start ack loss is logged in info
        state['last_run'] = label + (f" (on {info['on_s']:.3f}s)" if 'on_s' in info else ' (not started)')
        push(cli)

# ---------- MQTT ----------
def on_connect(cli, u, f, rc, props=None):
    log('MQTT connected rc', rc)
    cli.publish(AVAIL, 'online', retain=True)
    publish_discovery(cli)
    for t in ('speed/set', 'dose_ml/set', 'dose/press', 'continuous/set', 'stop/press', 'clear_fault/press') + tuple(f'cal_{k}/set' for k in CAL_LIMITS):
        cli.subscribe(f'{BASE}/{t}')
    state['status'] = 'idle' if state['status'] == 'starting' else state['status']
    threading.Thread(target=lambda: (resolve_host(), state.update(pump_ip=_host or ''), push(cli)), daemon=True).start()
    push(cli)

def on_disconnect(cli, u, rc, props=None):
    log('MQTT disconnected rc', rc, '- auto-reconnecting')

def on_message(cli, u, msg):
    p = msg.payload.decode('utf-8', 'ignore').strip(); t = msg.topic
    try:
        if t == f'{BASE}/speed/set':
            state['speed'] = max(1.0, min(MAX_SPEED, float(p))); push(cli)
            if state['continuous'] == 'ON':
                start_run(cli, state['speed'], 0, f"continuous @ {state['speed']:.0f}")
        elif t == f'{BASE}/dose_ml/set':
            state['dose_ml'] = max(0.1, float(p)); push(cli)
        elif t.startswith(f'{BASE}/cal_') and t.endswith('/set'):
            key = t[len(f'{BASE}/cal_'):-len('/set')]
            set_cal(key, p); log('calibration', key, '=', CAL[key], '| points', cal_points())
            if state['status'] == 'need-calibration': state['status'] = 'idle'
            push(cli)
        elif t == f'{BASE}/clear_fault/press':
            log('fault cleared from HA:', fault); fault.clear(); state['status'] = 'idle'; push(cli)
        elif t == f'{BASE}/dose/press' and fault:
            log('dose refused: fault latched', fault); state['status'] = 'fault'; push(cli)
        elif t == f'{BASE}/dose/press':
            r = ml_per_s(state['speed'])
            if not r:
                log('no calibration set'); state['status'] = 'need-calibration'; push(cli); return
            secs = state['dose_ml'] / r
            if state['dose_ml'] <= 1.0:      # pulse-sized dose: apply 50-pulse check factor
                secs /= CAL['pulse_factor']
            label = f"dose {state['dose_ml']:.1f} mL @ {state['speed']:.0f} ({secs:.2f}s)"
            if secs <= PULSE_MAX_S:     # never block the MQTT thread for a pulse
                threading.Thread(target=run_pulse, args=(cli, state['speed'], secs, label), daemon=True).start()
            else:
                start_run(cli, state['speed'], secs, label)
        elif t == f'{BASE}/continuous/set':
            if p == 'ON':
                state['continuous'] = 'ON'; start_run(cli, state['speed'], 0, f"continuous @ {state['speed']:.0f}")
            else:
                do_stop(cli, 'continuous stopped')
        elif t == f'{BASE}/stop/press':
            do_stop(cli, 'manual stop')
    except Exception as e:
        log('msg error:', e)

def main():
    m = CFG.get('mqtt', {})
    try:
        cli = mqtt.Client(mqtt.CallbackAPIVersion.VERSION1, client_id='kamoer-x1-bridge')
    except (AttributeError, TypeError):
        cli = mqtt.Client(client_id='kamoer-x1-bridge')
    if m.get('username'): cli.username_pw_set(m['username'], m.get('password', ''))
    cli.will_set(AVAIL, 'offline', retain=True)
    cli.reconnect_delay_set(min_delay=1, max_delay=30)
    cli.on_connect = on_connect; cli.on_message = on_message; cli.on_disconnect = on_disconnect

    def bye(*a):
        log('shutting down - stopping pump')
        try: do_stop(cli, 'bridge shutdown'); cli.publish(AVAIL, 'offline', retain=True); time.sleep(.3)
        finally: cli.disconnect(); sys.exit(0)
    signal.signal(signal.SIGTERM, bye); signal.signal(signal.SIGINT, bye)

    host, port = m.get('host', 'homeassistant.local'), int(m.get('port', 1883))
    log(f'connecting to MQTT {host}:{port}; calibration points {cal_points()} pulse factor {CAL["pulse_factor"]}')
    while True:
        try:
            cli.connect(host, port, 60); break
        except Exception as e:
            log('MQTT connect failed:', e, '- retry in 5s'); time.sleep(5)
    cli.loop_forever(retry_first_connection=True)

if __name__ == '__main__':
    main()
