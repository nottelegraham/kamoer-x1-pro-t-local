"""App-free Wi-Fi provisioner for the Kamoer X1 Pro-T (Alibaba awss dev-AP).
Serves a local web page; the Python backend speaks CoAP to the pump's hotspot
(192.168.4.1:5683) since browsers can't send UDP.

Flow: join the pump's KAMOER_xxxx hotspot on this Mac, open http://127.0.0.1:8777,
enter your Wi-Fi, click Provision. Password is AES-encrypted exactly as the pump
expects (device-secret level, cipherType 4), using the key in kamoer_creds.json.
"""
import os, sys, json, socket, hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

HERE = os.path.dirname(os.path.abspath(__file__))
CREDS = json.load(open(os.path.join(HERE, 'kamoer_creds.json')))
PUMP_AP_IP = '192.168.4.1'
COAP_PORT = 5683

# ---------- minimal CoAP GET with JSON payload (no session) ----------
def _payload_of(data):
    if len(data) < 4: return None
    pos = 4 + (data[0] & 15)
    while pos < len(data):
        if data[pos] == 255: return data[pos+1:]
        first = data[pos]; pos += 1
        delta, length = first >> 4, first & 15
        if delta == 15 or length == 15: return None
        for fld in ('d','l'):
            v = delta if fld=='d' else length
            if v == 13: v = 13 + data[pos]; pos += 1
            elif v == 14: v = 269 + int.from_bytes(data[pos:pos+2],'big'); pos += 2
            if fld=='l': length = v
        pos += length
    return None

def coap_get(path, obj, timeout=8):
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); s.bind(('', 0))
    token = os.urandom(2)
    pkt = bytes([0x42, 0x01]) + os.urandom(2) + token      # ver1 CON, GET, TKL2
    prev = 0
    for seg in path.strip('/').split('/'):
        b = seg.encode()
        if len(b) < 13:
            pkt += bytes([((11-prev) << 4) | len(b)]) + b
        else:
            pkt += bytes([((11-prev) << 4) | 13, len(b)-13]) + b
        prev = 11
    pkt += b'\xff' + json.dumps(obj, separators=(',',':')).encode()
    try:
        s.sendto(pkt, (PUMP_AP_IP, COAP_PORT))
        s.settimeout(timeout)
        import time; deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            try: data, addr = s.recvfrom(16384)
            except socket.timeout: break
            if addr[0] != PUMP_AP_IP or len(data) < 4: continue
            if (data[0] >> 4) & 3 == 0: s.sendto(b'\x60\x00' + data[2:4], addr)
            if data[1] == 0: continue
            body = _payload_of(data)
            if body:
                try: return json.loads(body.rstrip(b'\0'))
                except ValueError: return {'raw': body.decode('utf-8','ignore')}
        return None
    finally:
        s.close()

# ---------- password encryption (SDK: cal_passwd + AES-128-CBC) ----------
def encrypt_passwd(plain, secret, random16):
    key = hashlib.sha256(secret.encode() + b',' + random16).digest()[:16]
    pt = plain.encode()
    pt += b'\x00' * ((16 - len(pt) % 16) % 16)        # zero-pad to block size
    if not pt: pt = b'\x00' * 16
    enc = Cipher(algorithms.AES(key), modes.CBC(random16)).encryptor()
    return (enc.update(pt) + enc.finalize()).hex()

def detect():
    r = coap_get('/sys/device/info/get', {'id': '1', 'version': '1.0', 'method': 'device.info.get', 'params': {}})
    return r

def provision(ssid, passwd, secure):
    random16 = os.urandom(16)
    params = {'ssid': ssid, 'random': random16.hex(), 'bssid': '00:00:00:00:00:00'}
    params['passwd'] = encrypt_passwd(passwd, CREDS['DEVICE_SECRET'], random16) if secure else ''
    r = coap_get('/sys/awss/device/softap/switchap',
                 {'id': '2', 'version': '1.0', 'method': 'awss.device.softap.switchap', 'params': params})
    return r

# ---------- tiny web UI ----------
PAGE = """<!doctype html><html><head><meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1">
<title>Kamoer X1 Pro-T Provisioner</title>
<style>
 body{font:16px system-ui;margin:0;background:#0b1220;color:#e8eef7}
 .wrap{max-width:460px;margin:0 auto;padding:24px}
 h1{font-size:19px;margin:0 0 4px} .sub{color:#8fa3bf;font-size:13px;margin:0 0 20px}
 label{display:block;margin:14px 0 4px;font-size:13px;color:#b9c7dc}
 input,select{width:100%;box-sizing:border-box;padding:11px;border-radius:9px;border:1px solid #2a3a55;background:#111a2b;color:#e8eef7;font-size:15px}
 button{width:100%;margin-top:20px;padding:13px;border:0;border-radius:10px;background:#2f6df6;color:#fff;font-size:16px;font-weight:600}
 button.ghost{background:#1b2740;color:#cfe}
 #out{margin-top:16px;white-space:pre-wrap;font:13px ui-monospace,monospace;background:#0a1322;border:1px solid #223css;border-radius:9px;padding:12px;min-height:20px;border-color:#223}
 .ok{color:#49d17a}.err{color:#ff6b6b}
</style></head><body><div class=wrap>
<h1>Kamoer X1 Pro-T</h1><p class=sub>App-free Wi-Fi setup. Join the pump's KAMOER_ hotspot first.</p>
<button class=ghost onclick=detect()>Detect pump</button>
<label>Wi-Fi name (SSID)</label><input id=ssid autocapitalize=off autocorrect=off>
<label>Security</label><select id=sec><option value=1>WPA/WPA2 (password)</option><option value=0>Open (no password)</option></select>
<label>Wi-Fi password</label><input id=pw type=text autocapitalize=off autocorrect=off>
<button onclick=go()>Provision pump</button>
<div id=out></div>
</div><script>
const out=document.getElementById('out');
function show(t,cls){out.className=cls||'';out.textContent=t}
async function detect(){show('Querying pump at 192.168.4.1 ...');
 try{const r=await fetch('/api/detect',{method:'POST'});const j=await r.json();
  show(j.ok?('Found pump:\\n'+JSON.stringify(j.info,null,2)):('No reply. Are you on the KAMOER_ hotspot?'),j.ok?'ok':'err')}
 catch(e){show('Error: '+e,'err')}}
async function go(){const ssid=document.getElementById('ssid').value.trim();
 const pw=document.getElementById('pw').value;const sec=document.getElementById('sec').value;
 if(!ssid){show('Enter a Wi-Fi name.','err');return}
 show('Sending Wi-Fi to pump ...');
 try{const r=await fetch('/api/provision',{method:'POST',headers:{'content-type':'application/json'},
   body:JSON.stringify({ssid,passwd:pw,secure:sec==='1'})});const j=await r.json();
  if(j.ok&&j.code===200)show('Accepted. The pump is switching to "'+ssid+'". It will drop this hotspot and join your Wi-Fi in ~30s.','ok');
  else if(j.code)show('Pump replied code '+j.code+': '+(j.data||'')+'\\n(negative code = rejected; may be product-secret level)','err');
  else show('No reply from pump. Still on the KAMOER_ hotspot?','err')}
 catch(e){show('Error: '+e,'err')}}
</script></body></html>"""

class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def _send(self, code, body, ctype='application/json'):
        b = body if isinstance(body, bytes) else body.encode()
        self.send_response(code); self.send_header('content-type', ctype)
        self.send_header('content-length', str(len(b))); self.end_headers(); self.wfile.write(b)
    def do_GET(self):
        if self.path in ('/', '/index.html'): self._send(200, PAGE, 'text/html; charset=utf-8')
        else: self._send(404, '{"ok":false}')
    def do_POST(self):
        n = int(self.headers.get('content-length', 0) or 0)
        raw = self.rfile.read(n) if n else b''
        try:
            if self.path == '/api/detect':
                info = detect()
                self._send(200, json.dumps({'ok': bool(info), 'info': info}))
            elif self.path == '/api/provision':
                d = json.loads(raw or b'{}')
                r = provision(d.get('ssid',''), d.get('passwd',''), bool(d.get('secure', True)))
                if isinstance(r, dict):
                    self._send(200, json.dumps({'ok': True, 'code': r.get('code'), 'data': r.get('data')}))
                else:
                    self._send(200, json.dumps({'ok': False}))
            else:
                self._send(404, '{"ok":false}')
        except Exception as e:
            self._send(200, json.dumps({'ok': False, 'error': str(e)}))

if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8777
    print(f'Provisioner UI: http://127.0.0.1:{port}  (join the pump KAMOER_ hotspot first)')
    ThreadingHTTPServer(('127.0.0.1', port), H).serve_forever()
