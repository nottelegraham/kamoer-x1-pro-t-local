"""Minimal MQTT 3.1.1 packet decoder for logging a decrypted stream.

Not a full client. Given a byte buffer, it pulls out whole MQTT control
packets and returns human-readable one-liners plus the parsed pieces that
matter for the Kamoer work: CONNECT (clientId/username/password), SUBSCRIBE
topics, PUBLISH topic+payload. Partial trailing bytes are returned so the
caller can prepend them to the next chunk.
"""

MT = {1: "CONNECT", 2: "CONNACK", 3: "PUBLISH", 4: "PUBACK", 5: "PUBREC",
      6: "PUBREL", 7: "PUBCOMP", 8: "SUBSCRIBE", 9: "SUBACK",
      10: "UNSUBSCRIBE", 11: "UNSUBACK", 12: "PINGREQ", 13: "PINGRESP",
      14: "DISCONNECT"}


def _varint(buf, i):
    """Return (value, next_index) or (None, None) if incomplete."""
    mult = 1
    val = 0
    while i < len(buf):
        d = buf[i]
        val += (d & 0x7f) * mult
        i += 1
        if not (d & 0x80):
            return val, i
        mult *= 128
        if mult > 128 ** 4:
            return None, None
    return None, None


def _rdstr(b, p):
    if p + 2 > len(b):
        return None, p
    n = int.from_bytes(b[p:p + 2], "big")
    if p + 2 + n > len(b):
        return None, p
    return b[p + 2:p + 2 + n], p + 2 + n


def iter_packets(buf):
    """Yield (type, flags, body, raw) for each complete packet.

    Returns leftover bytes via the final yield of (None, None, None, rest).
    """
    i = 0
    while i < len(buf):
        if i + 1 > len(buf):
            break
        b0 = buf[i]
        typ = b0 >> 4
        flags = b0 & 0x0f
        rl, j = _varint(buf, i + 1)
        if rl is None:
            break  # incomplete length
        if j + rl > len(buf):
            break  # incomplete body
        body = buf[j:j + rl]
        raw = buf[i:j + rl]
        yield typ, flags, body, raw
        i = j + rl
    yield None, None, None, buf[i:]


def describe(typ, flags, body):
    name = MT.get(typ, f"?{typ}")
    info = {"type": name}
    try:
        if typ == 1:  # CONNECT
            proto, k = _rdstr(body, 0)
            level = body[k]
            cflags = body[k + 1]
            ka = int.from_bytes(body[k + 2:k + 4], "big")
            k += 4
            cid, k = _rdstr(body, k)
            user = pw = None
            # skip will topic/msg if present
            if cflags & 0x04:
                _, k = _rdstr(body, k)
                _, k = _rdstr(body, k)
            if cflags & 0x80:
                user, k = _rdstr(body, k)
            if cflags & 0x40:
                pw, k = _rdstr(body, k)
            info.update(keepalive=ka,
                        clientId=cid.decode("utf-8", "replace") if cid else None,
                        username=user.decode("utf-8", "replace") if user else None,
                        password=pw.decode("utf-8", "replace") if pw else None)
        elif typ == 3:  # PUBLISH
            topic, k = _rdstr(body, 0)
            if topic is None:
                raise ValueError("short publish")
            if flags & 0x06:  # QoS>0 has packet id
                k += 2
            payload = body[k:]
            info.update(topic=topic.decode("utf-8", "replace"),
                        payload=payload)
        elif typ in (8, 10):  # SUBSCRIBE / UNSUBSCRIBE
            p = 2
            tops = []
            while p < len(body):
                t, p = _rdstr(body, p)
                if t is None:
                    break
                if typ == 8:
                    p += 1  # requested QoS byte
                tops.append(t.decode("utf-8", "replace"))
            info.update(topics=tops)
    except Exception as e:
        info["parse_error"] = str(e)
    return info


def oneline(info):
    t = info.get("type")
    if t == "CONNECT":
        return (f"CONNECT keepalive={info.get('keepalive')} "
                f"clientId={info.get('clientId')!r} "
                f"username={info.get('username')!r} "
                f"password={info.get('password')!r}")
    if t == "PUBLISH":
        pl = info.get("payload", b"")
        shown = pl[:400].decode("utf-8", "replace")
        return f"PUBLISH {info.get('topic')!r}  payload<{len(pl)}B>: {shown}"
    if t in ("SUBSCRIBE", "UNSUBSCRIBE"):
        return f"{t} {info.get('topics')}"
    return t


class StreamLogger:
    """Feed decrypted bytes for one direction; get back log lines."""

    def __init__(self, tag, on_line):
        self.tag = tag
        self.buf = b""
        self.on_line = on_line

    def feed(self, data):
        self.buf += data
        leftover = self.buf
        for typ, flags, body, rest in iter_packets(self.buf):
            if typ is None:
                leftover = rest
                break
            info = describe(typ, flags, body)
            self.on_line(self.tag, info)
        self.buf = leftover
