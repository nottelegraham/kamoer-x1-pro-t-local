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
CAL = float(CFG.get('calibration_ml_per_min_at_350', 0) or 0)
MAXRUN = int(CFG.get('safety_max_run_seconds', 1800))
PUMP_MAC = CFG.get('pump', {}).get('mac', DEFAULT_MAC)

DEVICE = {'identifiers': [NODE], 'name': 'Kamoer X1 Pro-T',
          'manufacturer': 'Kamoer', 'model': 'X1 Pro-T', 'sw_version': 'local-bridge'}

state = {'speed': float(CFG.get('default_speed_rpm', 200)), 'dose_ml': 10.0,
         'status': 'starting', 'continuous': 'OFF', 'last_run': '', 'pump_ip': ''}
_timer = None
_lock = threading.Lock()
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

def ml_per_s(speed):
    return (CAL / 60.0) * (speed / 350.0) if CAL > 0 else None

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
    cfg('button', 'stop', {'name': 'Kamoer Stop', 'command_topic': f'{BASE}/stop/press', 'icon': 'mdi:stop'})
    cfg('sensor', 'status', {'name': 'Kamoer Status', 'state_topic': f'{BASE}/status/state', 'icon': 'mdi:information-outline'})
    cfg('sensor', 'last_run', {'name': 'Kamoer Last Run', 'state_topic': f'{BASE}/last_run/state', 'icon': 'mdi:history'})
    cfg('sensor', 'pump_ip', {'name': 'Kamoer IP', 'state_topic': f'{BASE}/pump_ip/state',
        'icon': 'mdi:ip-network', 'entity_category': 'diagnostic'})

def push(cli):
    cli.publish(f'{BASE}/speed/state', round(state['speed']), retain=True)
    cli.publish(f'{BASE}/dose_ml/state', round(state['dose_ml'], 1), retain=True)
    cli.publish(f'{BASE}/continuous/state', state['continuous'], retain=True)
    cli.publish(f'{BASE}/status/state', state['status'], retain=True)
    cli.publish(f'{BASE}/last_run/state', state['last_run'], retain=True)
    cli.publish(f'{BASE}/pump_ip/state', state['pump_ip'] or 'searching', retain=True)

def _cancel():
    global _timer
    if _timer: _timer.cancel(); _timer = None

def do_stop(cli, reason=''):
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

# ---------- MQTT ----------
def on_connect(cli, u, f, rc, props=None):
    log('MQTT connected rc', rc)
    cli.publish(AVAIL, 'online', retain=True)
    publish_discovery(cli)
    for t in ('speed/set', 'dose_ml/set', 'dose/press', 'continuous/set', 'stop/press'):
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
        elif t == f'{BASE}/dose/press':
            r = ml_per_s(state['speed'])
            if not r:
                log('no calibration set'); state['status'] = 'need-calibration'; push(cli); return
            secs = state['dose_ml'] / r
            start_run(cli, state['speed'], secs, f"dose {state['dose_ml']:.1f} mL @ {state['speed']:.0f} ({secs:.1f}s)")
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
    log(f'connecting to MQTT {host}:{port}; calibration {CAL or "UNSET"} ml/min@350')
    while True:
        try:
            cli.connect(host, port, 60); break
        except Exception as e:
            log('MQTT connect failed:', e, '- retry in 5s'); time.sleep(5)
    cli.loop_forever(retry_first_connection=True)

if __name__ == '__main__':
    main()
