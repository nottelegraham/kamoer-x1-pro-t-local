#!/usr/bin/env python3
"""find_secret.py — capture a Kamoer X1 Pro-T's deviceSecret + LAN prefix.

The pump's cloud sends its deviceSecret in the clear inside the MQTT
`thing/lan/prefix/get_reply` during startup. This runs a TLS man-in-the-middle
in front of that MQTT connection (self-signed RSA cert; the pump does not
validate it), relays to the real broker so startup completes, extracts
productKey / deviceName / deviceSecret / LAN-prefix, writes kamoer_creds.json,
and exits.

Routing: the pump's port-1883 traffic must reach this proxy. Easiest is to run
this on the box that is the pump's gateway and redirect with the helper
(macOS: ./redirect.sh on <pump-ip>). See README.md.

  sudo python3 find_secret.py --pump-ip 192.168.4.26
"""
import os, sys, re, ssl, json, socket, argparse, threading, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import kamoer_capture_proxy as proxy
import mqtt_decode

FOUND = threading.Event()
RESULT = {}
HEX32 = re.compile(r'^[0-9a-fA-F]{32}$')

def _strings(o):
    if isinstance(o, dict):
        for v in o.values(): yield from _strings(v)
    elif isinstance(o, list):
        for v in o: yield from _strings(v)
    elif isinstance(o, str):
        yield o

def extract(info):
    if FOUND.is_set() or info.get('type') != 'PUBLISH':
        return
    topic = info.get('topic', '') or ''
    if 'thing/lan/prefix/get_reply' not in topic:
        return
    parts = topic.strip('/').split('/')
    pk = dn = None
    if len(parts) >= 3 and parts[0] == 'sys':
        pk, dn = parts[1], parts[2]
    try:
        data = json.loads((info.get('payload', b'') or b'').decode('utf-8', 'replace'))
    except Exception:
        return
    secret = prefix = None
    def scan(o):
        nonlocal secret, prefix
        if isinstance(o, dict):
            for k, v in o.items():
                kl = k.lower()
                if isinstance(v, str):
                    if 'secret' in kl and HEX32.match(v): secret = v
                    elif 'prefix' in kl: prefix = v
                scan(v)
        elif isinstance(o, list):
            for v in o: scan(v)
    scan(data)
    if not secret:
        for s in _strings(data):
            if HEX32.match(s): secret = s; break
    if secret and pk and dn:
        RESULT.update(PK=pk, DN=dn, DEVICE_SECRET=secret, LAN_PREFIX=prefix or '')
        FOUND.set()

# Hook the proxy's decoder so we see full payloads without forking its code.
_orig = mqtt_decode.oneline
def _hooked(info):
    try: extract(info)
    except Exception: pass
    return _orig(info)
mqtt_decode.oneline = _hooked

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--pump-ip', required=True, help="the pump's IP on your LAN")
    ap.add_argument('--listen', default='127.0.0.1:18883')
    ap.add_argument('--out', default='kamoer_creds.json')
    ap.add_argument('--timeout', type=int, default=240)
    a = ap.parse_args()

    log = proxy.Log(None)
    cert, key = os.path.join(os.path.dirname(__file__), 'proxy_cert.pem'), os.path.join(os.path.dirname(__file__), 'proxy_key.pem')
    proxy.ensure_cert(cert, key, log)
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(cert, key)
    try: ctx.set_ciphers(proxy.RSA_CIPHERS)
    except ssl.SSLError: ctx.set_ciphers('DEFAULT:@SECLEVEL=0')
    ctx.minimum_version = ssl.TLSVersion.TLSv1_2

    host, port = a.listen.split(':')
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind((host, int(port))); srv.listen(16); srv.settimeout(1)
    print(f'[*] MITM proxy on {a.listen}. Waiting for pump {a.pump_ip} — power-cycle it now.')
    print('[*] (its traffic must be redirected here; see README). Ctrl-C to stop.')
    deadline = time.time() + a.timeout
    try:
        while not FOUND.is_set() and time.time() < deadline:
            try: cli, addr = srv.accept()
            except socket.timeout: continue
            threading.Thread(target=proxy.handle,
                args=(cli, addr, ctx, log, a.pump_ip, 1883, None), daemon=True).start()
    except KeyboardInterrupt:
        pass
    srv.close()
    if FOUND.is_set():
        json.dump(RESULT, open(a.out, 'w'), indent=2)
        s = RESULT['DEVICE_SECRET']
        print('\n[+] SECRET CAPTURED')
        print(f"    productKey  : {RESULT['PK']}")
        print(f"    deviceName  : {RESULT['DN']}")
        print(f"    deviceSecret: {s[:4]}...{s[-4:]}  (full value saved)")
        print(f"    LAN prefix  : {RESULT['LAN_PREFIX']}")
        print(f"[+] wrote {a.out}  — copy it next to kamoerx1.py / the bridge.")
    else:
        print('\n[-] No secret seen before timeout.')
        print('    The pump never reached this proxy, or never did its startup.')
        print('    Check the redirect (README) and power-cycle the pump while this runs.')

if __name__ == '__main__':
    main()
