"""Serve T3 conversation turns over ACP stdio in the T3 workspace."""
import json
import pathlib
import re
import sys
import threading
import urllib.parse
import uuid

from transport import api
from workspace import execute

sessions = {}
active = {}
permissions = {}
session_grants = {}
output = threading.Lock()


def emit(**fields):
    with output:
        print(json.dumps({"jsonrpc": "2.0", **fields}), flush=True)


def workspace_call(session, turn, action, cancel):
    call_id = action["callId"]
    command = action["command"]
    tool = {"toolCallId": call_id, "title": command, "kind": "execute",
            "status": "pending", "rawInput": {"command": command, "cwd": sessions[session]}}
    def update(kind, **fields):
        emit(method="session/update", params={"sessionId":session, "update":{
            **tool, "sessionUpdate":kind, **fields}})
    update("tool_call")
    ready = threading.Event()
    response = {}
    permissions[call_id] = (ready, response)
    try:
        grants = session_grants[session]
        grant = (sessions[session], command)
        allowed = grant in grants
        if not allowed:
            emit(id=call_id, method="session/request_permission", params={"sessionId":session,
                "toolCall":tool, "options":[
                    {"kind":"allow_once","name":"Run command","optionId":"allow"},
                    {"kind":"allow_always","name":"Allow this exact command in this session","optionId":"allow-session"},
                    {"kind":"reject_once","name":"Decline","optionId":"deny"}]})
            while not ready.wait(0.1):
                if cancel.is_set():
                    break
            outcome = response.get("result", {}).get("outcome", {})
            allowed = outcome.get("outcome") == "selected" and outcome.get("optionId") in ("allow","allow-session")
            if allowed and not cancel.is_set() and outcome["optionId"] == "allow-session":
                grants.add(grant)
        if not cancel.is_set() and allowed:
            with api("/api/chat/workspace-claim", {"turnId":turn,"callId":call_id}):
                pass
            update("tool_call_update", status="in_progress")
            receipt = execute(command, sessions[session], cancel)
        else:
            receipt = {"denied":True}
    except Exception as error:
        receipt = {"exitCode":None,"error":str(error)}
    finally:
        permissions.pop(call_id, None)
    update("tool_call_update", status="completed" if receipt.get("exitCode") == 0 else "failed",
           rawOutput=receipt, content=[{"type":"content","content":{"type":"text",
               "text":json.dumps(receipt,ensure_ascii=False)}}])
    with api("/api/chat/workspace-result", {"turnId":turn,"callId":call_id,"receipt":receipt}):
        pass


def prompt(request_id, session, parts, cancel):
    turn = None
    try:
        if any(part["type"] != "text" for part in parts):
            raise ValueError("Jerry accepts text in T3.")
        message = "\n".join(part["text"] for part in parts)
        # T3 wraps the composer text with instructions for coding agents.
        if message.startswith("<t3_code_instructions>"):
            prefix, separator, request = message.partition("</t3_code_instructions>\n\n<user_request>\n")
            body, end, suffix = request.rpartition("\n</user_request>")
            if not separator or not end:
                raise ValueError("Unrecognized T3 composer envelope.")
            message = body
        with api("/api/chat/turn", {"chatId": session, "message": message, "workspace": sessions[session]}) as response:
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
                delivered = ""
                for line in response:
                    if not line.startswith(b"data: {"):
                        continue
                    frame = json.loads(line[6:])
                    if frame.get("kind") == "workspace_command":
                        workspace_call(session, turn, frame["data"], cancel)
                    if frame.get("kind") == "response_chunk":
                        delivered += frame["data"]["chunk"]
                        emit(method="session/update", params={"sessionId": session, "update": {
                            "sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": frame["data"]["chunk"]}}})
                    if frame["type"] == "turn" and frame["status"] != "pending":
                        if frame["status"] not in ("complete", "stopped"):
                            raise ValueError(frame.get("error_message") or frame["status"])
                        final = frame.get("assistant_content") or ""
                        if final.startswith(delivered) and len(final) > len(delivered):
                            emit(method="session/update", params={"sessionId": session, "update": {
                                "sessionUpdate": "agent_message_chunk", "content": {
                                    "type": "text", "text": final[len(delivered):]}}})
                        emit(id=request_id, result={"stopReason": "cancelled" if frame["status"] == "stopped" else "end_turn"})
                        return
            raise IOError("Jerry stream ended before a terminal turn.")
        finally:
            finished.set()
    except Exception as error:
        # If the bridge fails after admission, release any pending workspace action.
        if turn is not None:
            try:
                with api("/api/chat/stop-turn", {"chatId": session, "turn_id": turn}):
                    pass
            except OSError:
                pass
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
        cwd = pathlib.Path(params["cwd"]).resolve(strict=True)
        if not cwd.is_dir():
            raise ValueError("Missing T3 project directory.")
        sessions[session] = str(cwd)
        session_grants[session] = set()
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
        session_grants[session].clear()
        return {}
    if method == "session/set_config_option" and params.get("configId") == "mode":
        session_grants[session].clear()
        return {"configOptions": []}
    raise ValueError("Unsupported ACP method: " + method)


for line in sys.stdin:
    msg = {}
    try:
        msg = json.loads(line)
        if "method" not in msg:
            pending = permissions.get(msg.get("id"))
            if pending:
                pending[1].update(msg)
                pending[0].set()
            continue
        result = dispatch(msg)
        if result is not None and "id" in msg:
            emit(id=msg["id"], result=result)
    except Exception as error:
        if "id" in msg:
            emit(id=msg["id"], error={"code": -32602, "message": str(error)})
for cancellation in list(active.values()):
    cancellation.set()
