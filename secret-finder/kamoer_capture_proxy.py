#!/usr/bin/env python3
"""
Kamoer X1 Pro-T capture/relay proxy  (phase 1 of local control).

What it does
------------
The pump connects to Alibaba's MQTT broker over TLS 1.2 using the legacy
RSA key-exchange cipher (TLS_RSA_WITH_AES_256_CBC_SHA256, 0x003d). This
proxy sits in the middle: it answers the pump with a self-signed RSA
certificate, decrypts the MQTT, logs every frame (CONNECT credentials,
SUBSCRIBE topics, PUBLISH command/telemetry), then re-encrypts and forwards
to the REAL broker so the pump keeps working during capture.

If the pump completes its MQTT CONNECT through this proxy, it does NOT
validate the server certificate -- which is the green light for full local
control (phase 2). If it drops the TLS handshake instead, it validates, and
we pivot.

How traffic reaches it
----------------------
The Mac is the pump's router. A pf redirect (see setup_redirect.sh) sends the
pump's port-1883 traffic to this proxy on 127.0.0.1. The proxy reads the TLS
SNI to learn the real hostname, resolves it with an honest resolver, and
relays there. No DNS hijack needed for phase 1.

Usage
-----
    sudo python3 kamoer_capture_proxy.py --listen 127.0.0.1:18883 \
        --pump-ip 192.168.2.7 --log pump_mqtt.log

Only connections whose decrypted stream is MQTT are parsed; everything else
is relayed byte-for-byte and logged as opaque.
"""
import argparse
import datetime
import os
import select
import socket
import ssl
import subprocess
import sys
import threading

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import mqtt_decode  # noqa: E402

# Honest resolver so the proxy reaches the REAL broker even if the Mac's DNS
# is later pointed at us. Falls back to system resolver.
HONEST_DNS = ["223.5.5.5", "8.8.8.8", "1.1.1.1"]

RSA_CIPHERS = "@SECLEVEL=0:AES256-SHA256:AES128-SHA256:AES256-SHA:AES128-SHA"


def ts():
    return datetime.datetime.now().strftime("%H:%M:%S.%f")[:-3]


class Log:
    def __init__(self, path):
        self.path = path
        self.lock = threading.Lock()
        self.fh = open(path, "a", buffering=1) if path else None

    def __call__(self, *parts):
        line = " ".join(str(p) for p in parts)
        out = f"{ts()} {line}"
        with self.lock:
            print(out, flush=True)
            if self.fh:
                self.fh.write(out + "\n")


def ensure_cert(certfile, keyfile, log):
    if os.path.exists(certfile) and os.path.exists(keyfile):
        return
    log("[*] generating self-signed RSA cert ->", certfile)
    subprocess.check_call([
        "openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes",
        "-keyout", keyfile, "-out", certfile, "-days", "3650",
        "-subj", "/C=US/O=KamoerLab/CN=*.aliyuncs.com",
        "-addext", "subjectAltName=DNS:*.aliyuncs.com,DNS:*.iotgds.aliyuncs.com,DNS:*.aliyun.com",
    ], stderr=subprocess.DEVNULL)


def resolve_honest(host):
    """Resolve host without trusting a possibly-hijacked local resolver."""
    # Try a direct query to a public resolver first.
    try:
        import struct
        import random
        q = host.rstrip(".") + "."
        tid = random.randint(0, 0xffff)
        pkt = struct.pack(">HHHHHH", tid, 0x0100, 1, 0, 0, 0)
        for label in q.split(".")[:-1]:
            pkt += bytes([len(label)]) + label.encode()
        pkt += b"\x00" + struct.pack(">HH", 1, 1)
        for rslv in HONEST_DNS:
            try:
                s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
                s.settimeout(3)
                s.sendto(pkt, (rslv, 53))
                data, _ = s.recvfrom(1024)
                s.close()
                ancount = struct.unpack(">H", data[6:8])[0]
                if ancount == 0:
                    continue
                # walk past question
                p = 12
                while data[p] != 0:
                    p += data[p] + 1
                p += 5
                for _ in range(ancount):
                    # name (pointer or labels)
                    if data[p] & 0xc0 == 0xc0:
                        p += 2
                    else:
                        while data[p] != 0:
                            p += data[p] + 1
                        p += 1
                    rtype, _, _, rdlen = struct.unpack(">HHIH", data[p:p + 10])
                    p += 10
                    if rtype == 1 and rdlen == 4:
                        return ".".join(str(b) for b in data[p:p + 4])
                    p += rdlen
            except Exception:
                continue
    except Exception:
        pass
    # Fallback: system resolver.
    return socket.gethostbyname(host)


def pump_streams(cli_tls, up_tls, sni, log, pump_ip):
    """Relay between pump (cli_tls) and upstream (up_tls), logging MQTT."""
    is_mqtt = sni is None or "mqtt" in (sni or "")

    def emit(tag, info):
        log(f"[{tag}]", mqtt_decode.oneline(info))
        if info.get("type") == "CONNECT":
            log("    >>> CONNECT creds captured:",
                f"clientId={info.get('clientId')}")

    c2s = mqtt_decode.StreamLogger("PUMP->CLOUD", emit) if is_mqtt else None
    s2c = mqtt_decode.StreamLogger("CLOUD->PUMP", emit) if is_mqtt else None

    socks = [cli_tls, up_tls]
    cli_tls.setblocking(False)
    up_tls.setblocking(False)
    try:
        while True:
            r, _, x = select.select(socks, [], socks, 60)
            if x:
                break
            if not r:
                continue
            for s in r:
                try:
                    data = s.recv(65536)
                except ssl.SSLWantReadError:
                    continue
                except Exception:
                    return
                if not data:
                    return
                if s is cli_tls:
                    if c2s:
                        c2s.feed(data)
                    _send_all(up_tls, data)
                else:
                    if s2c:
                        s2c.feed(data)
                    _send_all(cli_tls, data)
    finally:
        for s in socks:
            try:
                s.close()
            except Exception:
                pass


def _send_all(sock, data):
    while data:
        try:
            n = sock.send(data)
            data = data[n:]
        except ssl.SSLWantWriteError:
            continue
        except Exception:
            return


def handle(raw_cli, addr, sslctx, log, pump_ip, upstream_port, upstream_override=None):
    sni_box = {}

    def sni_cb(sslobj, server_name, ctx):
        sni_box["name"] = server_name

    sslctx.sni_callback = sni_cb
    try:
        cli_tls = sslctx.wrap_socket(raw_cli, server_side=True)
    except ssl.SSLError as e:
        # The pump dropped the handshake -> it likely VALIDATES the cert.
        log(f"[!] TLS handshake from {addr[0]} FAILED: {e}")
        log("    (if this is the pump, it validates the cert -> MITM blocked)")
        raw_cli.close()
        return
    except Exception as e:
        log(f"[!] accept error from {addr[0]}: {e}")
        raw_cli.close()
        return

    sni = sni_box.get("name")
    cipher = cli_tls.cipher()
    log(f"[+] TLS up with {addr[0]}  SNI={sni}  cipher={cipher}")
    if addr[0] == pump_ip:
        log("    >>> THIS IS THE PUMP. It accepted our self-signed cert.")
        log("    >>> Cert validation is OFF -> full local control is viable.")

    # Resolve + connect upstream (the real broker).
    target_host = sni or "public.iot-as-mqtt.ap-southeast-1.aliyuncs.com"
    try:
        if upstream_override:
            up_ip, up_port = upstream_override
            log(f"[*] upstream OVERRIDE -> {up_ip}:{up_port}")
        else:
            up_ip = resolve_honest(target_host)
            up_port = upstream_port
            log(f"[*] upstream {target_host} -> {up_ip}:{up_port}")
        up_raw = socket.create_connection((up_ip, up_port), timeout=10)
        up_ctx = ssl.create_default_context()
        up_ctx.check_hostname = False
        up_ctx.verify_mode = ssl.CERT_NONE
        up_ctx.set_ciphers(RSA_CIPHERS + ":DEFAULT")
        up_tls = up_ctx.wrap_socket(up_raw, server_hostname=target_host)
        log(f"[*] upstream TLS up: {up_tls.cipher()}")
    except Exception as e:
        log(f"[!] upstream connect failed: {e}")
        cli_tls.close()
        return

    pump_streams(cli_tls, up_tls, sni, log, pump_ip)
    log(f"[-] session with {addr[0]} closed")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--listen", default="127.0.0.1:18883")
    ap.add_argument("--upstream-port", type=int, default=1883,
                    help="port on the real broker (1883 = Alibaba MQTT/TLS)")
    ap.add_argument("--pump-ip", default="192.168.2.7")
    ap.add_argument("--cert", default="proxy_cert.pem")
    ap.add_argument("--key", default="proxy_key.pem")
    ap.add_argument("--log", default="pump_mqtt.log")
    ap.add_argument("--upstream-override", default=None,
                    help="host:port to force as upstream (harness/testing only)")
    args = ap.parse_args()

    override = None
    if args.upstream_override:
        h, p = args.upstream_override.split(":")
        override = (h, int(p))

    log = Log(args.log)
    ensure_cert(args.cert, args.key, log)

    sslctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    sslctx.load_cert_chain(args.cert, args.key)
    try:
        sslctx.set_ciphers(RSA_CIPHERS)
    except ssl.SSLError:
        sslctx.set_ciphers("DEFAULT:@SECLEVEL=0")
    sslctx.minimum_version = ssl.TLSVersion.TLSv1_2

    host, port = args.listen.split(":")
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind((host, int(port)))
    srv.listen(16)
    log(f"[*] capture proxy listening on {args.listen}  "
        f"pump={args.pump_ip}  upstream-port={args.upstream_port}")
    log("[*] waiting for the pump to connect (power-cycle it if needed)...")
    while True:
        cli, addr = srv.accept()
        threading.Thread(target=handle, args=(
            cli, addr, sslctx, log, args.pump_ip, args.upstream_port, override),
            daemon=True).start()


if __name__ == "__main__":
    main()
