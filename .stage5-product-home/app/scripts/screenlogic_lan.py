#!/usr/bin/env python3
"""House-only ScreenLogic phone front. Bind *:5024 -> 127.0.0.1:5023. No WAN."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import urllib.error
import urllib.request

UPSTREAM = "http://127.0.0.1:5023"
HOST = "0.0.0.0"
PORT = 5024

HOP_HEADERS = {"host", "transfer-encoding", "connection", "content-length"}

class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _proxy(self):
        url = UPSTREAM + self.path
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else None
        req = urllib.request.Request(url, data=body, method=self.command)
        for key, value in self.headers.items():
            if key.lower() not in HOP_HEADERS:
                req.add_header(key, value)
        try:
            with urllib.request.urlopen(req, timeout=25) as resp:
                payload = resp.read()
                self.send_response(resp.status)
                for key, value in resp.headers.items():
                    if key.lower() not in ("transfer-encoding", "connection"):
                        self.send_header(key, value)
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
        except urllib.error.HTTPError as err:
            payload = err.read()
            self.send_response(err.code)
            self.send_header("Content-Type", err.headers.get("Content-Type", "text/plain"))
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
        except Exception as err:
            msg = str(err).encode("utf-8", "replace")
            self.send_response(502)
            self.send_header("Content-Type", "text/plain")
            self.send_header("Content-Length", str(len(msg)))
            self.end_headers()
            self.wfile.write(msg)

    do_GET = do_POST = do_PUT = do_DELETE = do_PATCH = do_OPTIONS = _proxy

    def log_message(self, fmt, *args):
        return

if __name__ == "__main__":
    httpd = ThreadingHTTPServer((HOST, PORT), Handler)
    httpd.serve_forever()
