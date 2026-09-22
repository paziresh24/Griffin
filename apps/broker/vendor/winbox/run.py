#!/usr/bin/env python3
"""One RouterOS console command over the Winbox protocol (TCP 8291).

Input  (stdin, JSON):  {"host","port","user","password","command","timeoutMs"}
Output (stdout, JSON): {"ok":true,"output":"..."} | {"ok":false,"error":"..."}

The credential is read from stdin on purpose: argv is world-readable in /proc.
Nothing is printed except the JSON line, so the caller never has to scrape a banner.
"""

import json
import sys
import time

sys.path.insert(0, __file__.rsplit("/", 1)[0])
from winbox_terminal_client import WinboxTerminalClient  # noqa: E402  (vendored, see README)

# RouterOS echoes the command, then the output, then a new prompt ("[user@identity] > ").
PROMPT_TAIL = "] > "


def drain(client, deadline, quiet_for=0.6):
    """Collect terminal output until the prompt comes back or the router goes quiet."""
    out = ""
    last = time.time()
    while time.time() < deadline:
        chunk = client.receive_terminal_output(timeout=0.2)
        if chunk:
            out += chunk.decode("utf-8", "replace")
            last = time.time()
            if out.rstrip().endswith(PROMPT_TAIL.strip()):
                break
        elif out and time.time() - last > quiet_for:
            break
    return out


def clean(text, command):
    """Strip the echoed command, the trailing prompt and ANSI noise."""
    import re

    text = re.sub(r"\x1b\[[0-9;?]*[a-zA-Z]", "", text).replace("\r", "")
    lines = [ln for ln in text.split("\n")]
    if lines and command.strip() and command.strip() in lines[0]:
        lines = lines[1:]
    while lines and PROMPT_TAIL.strip() in lines[-1]:
        lines.pop()
    return "\n".join(lines).strip()


def main():
    try:
        args = json.load(sys.stdin)
    except Exception as error:  # noqa: BLE001
        print(json.dumps({"ok": False, "error": f"bad input: {error}"}))
        return 1

    command = str(args.get("command") or "").strip()
    if not command:
        print(json.dumps({"ok": False, "error": "command is required"}))
        return 1
    deadline = time.time() + max(5, min(int(args.get("timeoutMs") or 30000), 120000) / 1000)

    client = WinboxTerminalClient(str(args["host"]), int(args.get("port") or 8291))
    try:
        client.connect()
        # authenticate() returns None on success and raises on failure — do not test its value.
        try:
            client.authenticate(str(args["user"]), str(args["password"]))
        except Exception as error:  # noqa: BLE001
            print(json.dumps({"ok": False, "error": f"winbox login failed: {error}"}))
            return 1
        if not client.open_terminal(str(args["password"])):
            print(json.dumps({"ok": False, "error": "winbox terminal session did not open"}))
            return 1
        client.send_ready_signal()
        drain(client, min(deadline, time.time() + 3))  # banner + first prompt
        client.send_terminal_input((command + "\r").encode())
        raw = drain(client, deadline)
        print(json.dumps({"ok": True, "output": clean(raw, command)}))
        return 0
    except Exception as error:  # noqa: BLE001
        print(json.dumps({"ok": False, "error": f"{type(error).__name__}: {error}"}))
        return 1
    finally:
        try:
            client.socket.close()
        except Exception:  # noqa: BLE001
            pass


if __name__ == "__main__":
    sys.exit(main())
