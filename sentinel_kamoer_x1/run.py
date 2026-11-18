"""Add-on entry: turn the add-on options into the bridge's config, then run it."""
import json, os, shutil, urllib.request, yaml

DATA, APP, SHARE = '/data', '/app', '/share/kamoer'
opt = json.load(open(f'{DATA}/options.json'))

def log(*a): print('[addon]', *a, flush=True)

def supervisor_token():
    # Not always in this process's environment under s6; the container env file has it.
    t = os.environ.get('SUPERVISOR_TOKEN', '')
    if not t:
        try: t = open('/run/s6/container_environment/SUPERVISOR_TOKEN').read().strip()
        except OSError: pass
    return t

# MQTT: the login in the options, else the Mosquitto add-on's login from the Supervisor.
mqtt = {'host': opt['mqtt_host'], 'port': opt['mqtt_port'],
        'username': opt.get('mqtt_username') or '', 'password': opt.get('mqtt_password') or ''}
if not mqtt['username']:
    try:
        req = urllib.request.Request('http://supervisor/services/mqtt',
              headers={'Authorization': 'Bearer ' + supervisor_token()})
        d = json.load(urllib.request.urlopen(req, timeout=10))['data']
        mqtt.update(host=d['host'], port=int(d['port']), username=d['username'], password=d['password'])
        log('using the Mosquitto add-on login')
    except Exception as e:
        log('no MQTT login in the options and none from the Supervisor:', e)

pump = {'host': opt.get('pump_host') or ''}
if opt.get('pump_mac'): pump['mac'] = opt['pump_mac']
cfg = {'mqtt': mqtt, 'pump': pump,
       'discovery_prefix': 'homeassistant',
       'default_speed_rpm': opt['default_speed_rpm'],
       'safety_max_run_seconds': opt['safety_max_run_seconds'],
       'health_pump_grace_seconds': opt['restart_if_pump_unreachable_minutes'] * 60,
       'calibration_ml_per_min_at_350': 0}
yaml.safe_dump(cfg, open(f'{DATA}/config.yaml', 'w'))

# Device keys: from the options if all four are filled in, else /share/kamoer/kamoer_creds.json.
keys = {'PK': opt.get('product_key'), 'DN': opt.get('device_name'),
        'DEVICE_SECRET': opt.get('device_secret'), 'LAN_PREFIX': opt.get('lan_prefix')}
if all(keys.values()):
    json.dump(keys, open(f'{DATA}/kamoer_creds.json', 'w'))
elif os.path.exists(f'{SHARE}/kamoer_creds.json'):
    shutil.copy(f'{SHARE}/kamoer_creds.json', f'{DATA}/kamoer_creds.json')
if not os.path.exists(f'{DATA}/kamoer_creds.json'):
    raise SystemExit('No pump keys: fill in product_key, device_name, device_secret and lan_prefix '
                     'in the add-on Configuration tab (or put kamoer_creds.json in /share/kamoer).')

# Calibration: moving from the Mac bridge? Put its calibration.json in /share/kamoer once.
if not os.path.exists(f'{DATA}/calibration.json') and os.path.exists(f'{SHARE}/calibration.json'):
    shutil.copy(f'{SHARE}/calibration.json', f'{DATA}/calibration.json'); log('imported calibration')

os.environ.update(KAMOER_DATA=DATA, KAMOER_HEALTH_PORT='8742')
os.execv('/usr/bin/python3', ['python3', '-u', f'{APP}/kamoer_bridge.py'])
