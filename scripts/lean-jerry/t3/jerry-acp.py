"""Serve T3 conversation turns over ACP stdio on Jerry's host."""
import json
import pathlib
import re
import sys
import threading
import urllib.parse
import urllib.request
import uuid

config = json.loads((pathlib.Path.home() / "Library/Application Support/Lean Jerry/service.json").read_text())
base = "http://127.0.0.1:" + str(config["port"])
token = pathlib.Path(config["tokenFile"]).expanduser().read_text().strip()
sessions = set()
active = {}
output = threading.Lock()


def api(route, body=None):
    data = json.dumps(body).encode() if body is not None else None
    return urllib.request.urlopen(urllib.request.Request(base + route, data, headers={
        "Authorization": "Bearer " + token, "Content-Type": "application/json"}), timeout=90)


def emit(**fields):
    with output:
        print(json.dumps({"jsonrpc": "2.0", **fields}), flush=True)


def prompt(request_id, session, parts, cancel):
    turn = None
    try:
        if any(part["type"] != "text" for part in parts):
            raise ValueError("Jerry accepts text in T3.")
        message = "\n".join(part["text"] for part in parts)
        with api("/api/chat/turn", {"chatId": session, "message": message}) as response:
            turn = json.load(response)["turn_id"]
        query = urllib.parse.urlencode({"chatId": session, "turn_id": turn})
        # A separate waiter can interrupt even while the stream is waiting for its first token.
        finished = threading.Event()

        def stop():
            while not finished.wait(0.1):
                if cancel.is_set():
                    with api("/api/chat/stop-turn", {"chatId": session, "turn_id": turn}):
                        return

        threading.Thread(target=stop, daemon=True).start()
        try:
            with api("/api/chat/stream?" + query) as response:
                for line in response:
                    if not line.startswith(b"data: {"):
                        continue
                    frame = json.loads(line[6:])
                    if frame.get("kind") == "response_chunk":
                        emit(method="session/update", params={"sessionId": session, "update": {
                            "sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": frame["data"]["chunk"]}}})
                    if frame["type"] == "turn" and frame["status"] != "pending":
                        if frame["status"] not in ("complete", "stopped"):
                            raise ValueError(frame.get("error_message") or frame["status"])
                        emit(id=request_id, result={"stopReason": "cancelled" if frame["status"] == "stopped" else "end_turn"})
                        return
            raise IOError("Jerry stream ended before a terminal turn.")
        finally:
            finished.set()
    except Exception as error:
        emit(id=request_id, error={"code": -32603, "message": str(error)})
    finally:
        active.pop(session, None)


def replay(session):
    pages = []
    query = {"chatId": session, "limit": 500}
    while True:
        with api("/api/chat/transcript?" + urllib.parse.urlencode(query)) as response:
            page = json.load(response)
        pages.append(page["turns"])
        if page.get("nextBefore") is None:
            break
        query["before"] = page["nextBefore"]
    seen = set()
    for turns in reversed(pages):
        for turn in turns:
            for role, kind in (("user", "user_message_chunk"), ("assistant", "agent_message_chunk")):
                message = turn.get(role)
                if message and message["id"] not in seen:
                    seen.add(message["id"])
                    emit(method="session/update", params={"sessionId": session, "update": {
                        "sessionUpdate": kind, "content": {"type": "text", "text": message["text"]}}})


def dispatch(msg):
    method, params = msg["method"], msg.get("params", {})
    session = params.get("sessionId")
    if method == "initialize":
        return {"protocolVersion": 1, "agentCapabilities": {"loadSession": True, "sessionCapabilities": {"resume": {}}},
                "agentInfo": {"name": "Home23 Jerry", "version": "1.0.0"}, "authMethods": []}
    if method == "session/new":
        session = "t3-" + str(uuid.uuid4())
    if method in ("session/new", "session/load", "session/resume"):
        if not re.fullmatch(r"t3-(?:verify-)?[a-f0-9-]{36}", session or ""):
            raise ValueError("Invalid Jerry session.")
        if method == "session/load":
            replay(session)
        sessions.add(session)
        return {"sessionId": session, "modes": {"currentModeId": "ask", "availableModes": [
            {"id": key, "name": key} for key in ("ask", "auto")]}}
    if session not in sessions:
        raise ValueError("Unknown Jerry session.")
    if method == "session/prompt":
        if session in active:
            raise ValueError("Jerry is already answering.")
        active[session] = threading.Event()
        threading.Thread(target=prompt, args=(msg["id"], session, params["prompt"], active[session])).start()
        return None
    if method == "session/cancel":
        if session in active:
            active[session].set()
        return None
    if method == "session/set_mode":
        return {}
    if method == "session/set_config_option" and params.get("configId") == "mode":
        return {"configOptions": []}
    raise ValueError("Unsupported ACP method: " + method)


for line in sys.stdin:
    msg = {}
    try:
        msg = json.loads(line)
        result = dispatch(msg)
        if result is not None and "id" in msg:
            emit(id=msg["id"], result=result)
    except Exception as error:
        if "id" in msg:
            emit(id=msg["id"], error={"code": -32602, "message": str(error)})
for cancellation in list(active.values()):
    cancellation.set()
