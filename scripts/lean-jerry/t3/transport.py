"""Relay Jerry HTTP requests over SSH without exporting Jerry's bearer token."""
import contextlib
import json
import pathlib
import subprocess
import sys
import urllib.error
import urllib.request


def local_api(route, body=None):
    config = json.loads((pathlib.Path.home() / "Library/Application Support/Lean Jerry/service.json").read_text())
    if not route.startswith("/api/chat/"):
        raise ValueError("Expected a chat API route.")
    url = "http://127.0.0.1:" + str(config["port"]) + route
    token = pathlib.Path(config["tokenFile"]).read_text().strip()
    return urllib.request.urlopen(urllib.request.Request(url,
        json.dumps(body).encode() if body is not None else None,
        headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"}), timeout=330)


def relay():
    request = json.loads(sys.stdin.buffer.readline())
    try:
        response = local_api(request["route"], request["body"])
    except urllib.error.HTTPError as error:
        print(error.code, flush=True)
        return
    with response:
        print(response.status, flush=True)
        for line in response:
            sys.stdout.buffer.write(line)
            sys.stdout.buffer.flush()


@contextlib.contextmanager
def api(route, body=None):
    process = subprocess.Popen(["/usr/bin/ssh", "-T", "-o", "BatchMode=yes", "-o",
        "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=5", "-o", "ServerAliveInterval=15",
        "-o", "ServerAliveCountMax=2", "jtr@100.79.10.60",
        "exec /usr/bin/python3 ~/.local/lib/home23-t3/transport.py"],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE)
    try:
        process.stdin.write((json.dumps({"route":route, "body":body}) + "\n").encode())
        process.stdin.close()
        status = process.stdout.readline().strip()
        if status != b"200":
            raise IOError("Jerry request failed (HTTP " + (status.decode() or "unavailable") + ").")
        yield process.stdout
    finally:
        process.stdout.close()
        if process.poll() is None:
            process.terminate()
        process.wait()


if __name__ == "__main__":
    relay()
