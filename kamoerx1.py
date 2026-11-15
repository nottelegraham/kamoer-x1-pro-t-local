"""Self-contained Kamoer X1 Pro-T local controller (LAN / Alibaba ALCS, no cloud).
Credentials come from the caller (config), target host is a parameter, so this
runs anywhere on the pump's LAN. Verified CoAP/AES framing ported from the
working reverse-engineering tools.
"""
import os, sys, re, time, json, socket, struct, base64, hmac, hashlib, subprocess, platform
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

PORT = 5683
DEFAULT_MAC = "xx:xx:xx:xx:xx:xx"   # set pump.mac in config.yaml
MAX_SPEED = 350.0            # app-supported RPM ceiling; do not exceed
RUN_VOLUME = 9999.0          # large volume = run until we STOP (duration-driven)

# ---------- CoAP option + packet framing ----------
def _option(number, value, previous):
    def field(n):
        if n < 13:  return n, b''
        if n < 269: return 13, bytes([n - 13])
        return 14, (n - 269).to_bytes(2, 'big')
    dn, de = field(number - previous); ln, le = field(len(value))
    return bytes([(dn << 4) | ln]) + de + le + value

def _crypt(data, key, enc):
    cph = Cipher(algorithms.AES(key[:16]), modes.CBC(b'a1b1c1d1e1f1g1h1'))
    t = cph.encryptor() if enc else cph.decryptor()
    return t.update(data) + t.finalize()

def _encrypt(body, key):
    split = len(body) // 16 * 16; pad = 16 - (len(body) - split)
    tail = body[split:] + bytes([pad]) * pad
    return (_crypt(body[:split], key, True) if split else b'') + _crypt(tail, key, True)

def _decrypt(body, key):
    if not body or len(body) % 16: raise ValueError()
    head = _crypt(body[:-16], key, False) if len(body) > 16 else b''
    tail = _crypt(body[-16:], key, False); pad = tail[-1]
    if not 1 <= pad <= 16 or tail[-pad:] != bytes([pad]) * pad: raise ValueError()
    return head + tail[:-pad]

def _payload_of(data):
    if len(data) < 4: return None
    pos = 4 + (data[0] & 15)
    while pos < len(data):
        if data[pos] == 255: return data[pos + 1:]
        first = data[pos]; pos += 1
        delta, length = first >> 4, first & 15
        if delta == 15 or length == 15: return None
        for fld in ('delta', 'length'):
            v = delta if fld == 'delta' else length
            if v == 13:
                if pos >= len(data): return None
                v = 13 + data[pos]; pos += 1
            elif v == 14:
                if pos + 2 > len(data): return None
                v = 269 + int.from_bytes(data[pos:pos + 2], 'big'); pos += 2
            if fld == 'length': length = v
        pos += length
    return None

def _make_packet(path, obj, sid=None, key=None):
    token = os.urandom(4)
    packet = b'\x44\x01' + os.urandom(2) + token
    prev = 0
    for seg in path.strip('/').split('/'):
        packet += _option(11, seg.encode(), prev); prev = 11
    packet += _option(12, b'\x2a' if sid else b'\x32', prev)
    if sid:
        packet += _option(71, sid.to_bytes((sid.bit_length() + 7) // 8, 'big'), 12)
    body = json.dumps(obj, separators=(',', ':')).encode()
    if sid: body = _encrypt(body, key)
    return packet + b'\xff' + body, token

def _request(sock, host, path, obj, sid=None, key=None, timeout=10):
    packet, token = _make_packet(path, obj, sid, key)
    sock.sendto(packet, (host, PORT))
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        sock.settimeout(max(.01, deadline - time.monotonic()))
        try: data, addr = sock.recvfrom(16384)
        except socket.timeout: break
        if addr[0] != host or len(data) < 4: continue
        if (data[0] >> 4) & 3 == 0: sock.sendto(b'\x60\x00' + data[2:4], addr)
        if data[1] == 0: continue
        if data[4:4 + (data[0] & 15)] != token: continue
        body = _payload_of(data)
        if not body: return None
        try: return json.loads(body.rstrip(b'\0'))
        except ValueError:
            if key:
                try: return json.loads(_decrypt(body, key))
                except (ValueError, UnicodeError): return None
            return None
    return None

def _authenticate(sock, host, cr):
    access_key = cr['LAN_PREFIX'] + '00' + '001'
    atok = base64.b64encode(hmac.new(cr['DEVICE_SECRET'].encode(), access_key.encode(), hashlib.sha1).digest())
    rk = os.urandom(8).hex()
    sign = base64.b64encode(hmac.new(atok, rk.encode(), hashlib.sha1).digest()).decode()
    obj = {'version': '1.0', 'method': 'core/service/auth', 'id': str(int(time.time() * 1000)),
           'params': {'prodKey': cr['PK'], 'deviceName': cr['DN'], 'encrypt': 'payload',
                      'randomKey': rk, 'sign': sign, 'accessKey': access_key}}
    r = _request(sock, host, f"/dev/{cr['PK']}/{cr['DN']}/core/service/auth", obj, timeout=3)
    if not isinstance(r, dict):
        raise TimeoutError('No valid LAN authentication reply from ' + host)
    if r.get('code') != 200:
        code = r.get('code')
        safe_code = str(code) if isinstance(code, int) else 'unknown'
        raise ValueError('LAN authentication rejected (code ' + safe_code + '); response details omitted')
    d = r.get('data', {}); rem, sg, sid = d.get('randomKey'), d.get('sign'), d.get('sessionId')
    if not isinstance(rem, str) or not isinstance(sg, str) or not isinstance(sid, int) or sid <= 0:
        raise ValueError('incomplete session')
    cand = [rem.encode()] + ([rem.encode() + b'\0'] if len(rem.encode()) == 15 else [])
    if not any(hmac.compare_digest(base64.b64encode(hmac.new(atok, c, hashlib.sha1).digest()).decode(), sg) for c in cand):
        raise ValueError('session signature mismatch')
    return sid, hmac.new(atok, (rk + rem).encode(), hashlib.sha1).digest()

# ---------- native command frames ----------
def _frame(seq, opcode, payload):
    return (bytes([seq, 2]) + len(payload).to_bytes(2, 'big')
            + bytes.fromhex('0006') + opcode.to_bytes(2, 'big') + payload).hex()
def f_manual(seq):                 return _frame(seq, 0x16, b'\0\0')
def f_dose(seq, action, vol, spd): return _frame(seq, 0x14, bytes([0, 0, action]) + struct.pack('>f', vol) + b'\0'*4 + struct.pack('>f', spd))
def f_status(seq):                 return _frame(seq, 0x01, b'\0')

def _local_ipv4():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); s.connect(('8.8.8.8', 80))
        ip = s.getsockname()[0]; s.close(); return ip
    except Exception:
        return None

def _ip_in(line):
    m = re.search(r'(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})', line)
    return m.group(1) if m else None

def _neighbors():
    out = ''
    for cmd in (['arp', '-an'], ['ip', 'neigh']):
        try: out += subprocess.run(cmd, capture_output=True, text=True, timeout=5).stdout + '\n'
        except Exception: pass
    return out

def discover(mac=DEFAULT_MAC):
    """Cross-platform: read arp/ip-neigh, else ping-sweep the local /24 and re-read."""
    mac = mac.lower()
    for line in _neighbors().splitlines():
        if mac in line.lower():
            ip = _ip_in(line)
            if ip: return ip
    base = _local_ipv4()
    if base:
        wait = '-W1' if platform.system() == 'Linux' else '-t1'
        net = '.'.join(base.split('.')[:3]); procs = []
        for i in range(1, 255):
            try: procs.append(subprocess.Popen(['ping', '-c1', wait, f'{net}.{i}'],
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL))
            except Exception: break
        time.sleep(3)
        for pr in procs:
            try: pr.kill()
            except Exception: pass
        for line in _neighbors().splitlines():
            if mac in line.lower():
                ip = _ip_in(line)
                if ip: return ip
    return None

class Pump:
    def __init__(self, host, creds):
        self.host, self.creds = host, creds
    def _ses(self):
        # UDP replies can be lost during Wi-Fi reconnection. Retry missing replies,
        # not explicit credential rejections, and close every failed socket.
        for attempt in range(3):
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            try:
                s.bind(('', 0))
                sid, key = _authenticate(s, self.host, self.creds)
                return s, sid, key
            except TimeoutError:
                s.close()
                if attempt == 2:
                    raise
                time.sleep(.35 * (attempt + 1))
            except BaseException:
                s.close()
                raise
    def _set(self, s, sid, key, raw, timeout=10):
        obj = {'id': str(time.time_ns()), 'version': '1.0', 'method': 'thing.service.property.set',
               'params': {'PumpSerialNumber': raw}}
        return _request(s, self.host, f"/sys/{self.creds['PK']}/{self.creds['DN']}/thing/service/property/set", obj, sid, key, timeout)
    @staticmethod
    def _ok(r): return isinstance(r, dict) and r.get('code') == 200
    def auth_test(self):
        s, sid, key = self._ses(); s.close(); return True
    def dose(self, speed, volume=RUN_VOLUME):
        speed = max(1.0, min(MAX_SPEED, float(speed)))
        s, sid, key = self._ses(); seq = time.time_ns() & 255
        def nx():
            nonlocal seq; seq = (seq + 1) & 255; return seq
        try:
            if not self._ok(self._set(s, sid, key, f_manual(nx()))): return False
            self._set(s, sid, key, f_dose(nx(), 0, volume, speed))     # stop preflight
            return self._ok(self._set(s, sid, key, f_dose(nx(), 1, volume, speed)))  # START
        finally: s.close()
    def pulse(self, speed, seconds, cancel=None):
        """One short run on ONE LAN session: start, hold, stop.
        dose() + stop() each open their own session, so a short pulse used to run
        for its planned time PLUS a fresh auth handshake before the stop landed
        (and a lost UDP reply there adds 3 s). Here the stop goes out on the
        session that started the motor, timed from when START was sent.
        Returns (started, stopped, info); info holds measured timings (s)."""
        speed = max(1.0, min(MAX_SPEED, float(speed)))
        info = {'planned_s': round(float(seconds), 3)}
        s, sid, key = self._ses(); seq = time.time_ns() & 255
        def nx():
            nonlocal seq; seq = (seq + 1) & 255; return seq
        started = stopped = False; t0 = None
        try:
            if not self._ok(self._set(s, sid, key, f_manual(nx()))): return False, True, info
            self._set(s, sid, key, f_dose(nx(), 0, RUN_VOLUME, speed))       # stop preflight
            t0 = time.monotonic()
            started = self._ok(self._set(s, sid, key, f_dose(nx(), 1, RUN_VOLUME, speed), timeout=max(float(seconds), .3)))
            info['start_ack_ms'] = round((time.monotonic() - t0) * 1000)
            # Hold until the planned stop time. macOS coalesces timers for background
            # (launchd) processes, so a plain sleep/wait can wake 100-200 ms late, which
            # more than doubles a 0.13 s pulse. Sleep coarsely only until 0.5 s before
            # the deadline, then spin on the monotonic clock for the last stretch.
            deadline = t0 + float(seconds)
            while True:
                left = deadline - time.monotonic()
                if left <= 0 or (cancel is not None and cancel.is_set()): break
                if left > 0.5:
                    if cancel is not None: cancel.wait(left - 0.5)
                    else: time.sleep(left - 0.5)
                else:
                    time.sleep(0)            # yield, keep spinning
        finally:
            if t0 is not None:                       # START went out: always stop
                ts = time.monotonic()
                # A lost STOP keeps the motor running until the retry, so retry fast
                # (LAN round trip is ~50 ms): up to 8 tries, 0.15 s apart.
                tries = 0
                for _ in range(8):
                    tries += 1; ts = time.monotonic()   # on-time ends at the STOP that got through
                    try:
                        if self._ok(self._set(s, sid, key, f_dose(nx(), 0, RUN_VOLUME, speed), timeout=.15)):
                            stopped = True; break
                    except Exception:
                        pass
                info['stop_tries'] = tries
                info['on_s'] = round(ts - t0, 3)     # START sent -> acknowledged STOP sent = motor on-time
                info['stop_ack_ms'] = round((time.monotonic() - ts) * 1000)
            s.close()
        return started, stopped, info
    def stop(self):
        s, sid, key = self._ses(); seq = time.time_ns() & 255
        try:
            last = None
            for _ in range(3):
                seq = (seq + 1) & 255
                last = self._set(s, sid, key, f_dose(seq, 0, RUN_VOLUME, 200.0)); time.sleep(.08)
            return self._ok(last)
        finally: s.close()

if __name__ == '__main__':
    import argparse
    ap = argparse.ArgumentParser(); ap.add_argument('--host'); ap.add_argument('--discover', action='store_true')
    ap.add_argument('--creds', default=os.path.join(os.path.dirname(__file__), 'kamoer_creds.json'))
    sub = ap.add_subparsers(dest='cmd', required=True)
    sub.add_parser('auth'); sub.add_parser('stop')
    dp = sub.add_parser('dose'); dp.add_argument('--speed', type=float, default=200.0); dp.add_argument('--seconds', type=float, default=5.0)
    a = ap.parse_args()
    creds = json.load(open(a.creds))
    host = a.host or (discover() if a.discover else None)
    if not host: print('No host (use --host or --discover).'); sys.exit(1)
    p = Pump(host, creds); print('Target:', host)
    if a.cmd == 'auth': print('LAN auth OK' if p.auth_test() else 'FAILED')
    elif a.cmd == 'stop': print('stop:', 'ok' if p.stop() else 'no-ack')
    elif a.cmd == 'dose':
        input(f'{a.speed:.0f} RPM for {a.seconds:.0f}s. Power in reach. Return to START: ')
        try:
            print('started' if p.dose(a.speed) else 'start not acked'); time.sleep(a.seconds)
        finally: print('stop:', 'ok' if p.stop() else 'no-ack')
