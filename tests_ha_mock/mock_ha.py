#!/usr/bin/env python3
# © 2026 Daniel Partel – SIRIUS Assistant. Tous droits réservés. Toute reproduction, modification, distribution ou utilisation non autorisée est strictement interdite. Logiciel protégé par le droit d'auteur (Code de la propriété intellectuelle – France).
"""Minimal Home Assistant REST mock for KERAUNOS integration tests."""
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

TOKEN = "testtoken123"
CALLS = []
STATES = [
    {
        "entity_id": "light.salon",
        "state": "on",
        "attributes": {"friendly_name": "Salon", "brightness": 180},
    },
    {
        "entity_id": "switch.prise_tv",
        "state": "off",
        "attributes": {"friendly_name": "Prise TV"},
    },
    {
        "entity_id": "sensor.temperature",
        "state": "21.5",
        "attributes": {
            "friendly_name": "Température",
            "unit_of_measurement": "°C",
        },
    },
    {
        "entity_id": "scene.soiree",
        "state": "scening",
        "attributes": {"friendly_name": "Soirée"},
    },
]


class Handler(BaseHTTPRequestHandler):
    def _json(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _authorized(self):
        if self.headers.get("Authorization") != f"Bearer {TOKEN}":
            self._json(401, {"message": "Unauthorized"})
            return False
        return True

    def do_GET(self):
        if self.path == "/__calls":
            self._json(200, {"calls": CALLS})
            return
        if not self._authorized():
            return
        if self.path == "/api/":
            self._json(200, {"message": "API running."})
        elif self.path == "/api/states":
            self._json(200, STATES)
        else:
            self._json(404, {"message": "Not found"})

    def do_POST(self):
        if not self._authorized():
            return
        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length) if length else b"{}"
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError:
            payload = None
        CALLS.append({"method": "POST", "path": self.path, "json": payload})
        if self.path.startswith("/api/services/"):
            self._json(200, [])
        else:
            self._json(404, {"message": "Not found"})

    def log_message(self, fmt, *args):
        return


if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", 8199), Handler).serve_forever()
