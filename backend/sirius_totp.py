"""Minimal RFC 6238 TOTP implementation used by the packaged backend."""

import base64
import hashlib
import hmac
import struct
import time
from urllib.parse import quote


_DIGITS = 6
_PERIOD = 30


def random_base32():
    import secrets
    return base64.b32encode(secrets.token_bytes(20)).decode("ascii").rstrip("=")


class TOTP:
    def __init__(self, secret, interval=_PERIOD, digits=_DIGITS):
        self.secret = secret
        self.interval = interval
        self.digits = digits

    def _code(self, timestamp):
        padded = self.secret.upper() + "=" * (-len(self.secret) % 8)
        key = base64.b32decode(padded)
        counter = int(timestamp // self.interval)
        digest = hmac.new(key, struct.pack(">Q", counter), hashlib.sha1).digest()
        offset = digest[-1] & 0x0F
        value = struct.unpack(">I", digest[offset:offset + 4])[0] & 0x7FFFFFFF
        return str(value % (10 ** self.digits)).zfill(self.digits)

    def now(self):
        return self._code(time.time())

    def verify(self, code, valid_window=0):
        if not str(code or "").isdigit() or len(str(code)) != self.digits:
            return False
        current = int(time.time() // self.interval)
        return any(hmac.compare_digest(self._code((current + shift) * self.interval), str(code)) for shift in range(-valid_window, valid_window + 1))

    def provisioning_uri(self, name, issuer_name="SIRIUS"):
        return "otpauth://totp/{label}?secret={secret}&issuer={issuer}&algorithm=SHA1&digits={digits}&period={period}".format(
            label=quote(f"{issuer_name}:{name}"),
            secret=self.secret,
            issuer=quote(issuer_name),
            digits=self.digits,
            period=self.interval,
        )
