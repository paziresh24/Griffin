"""Self-check for run.py output capture: python3 vendor/winbox/test_run.py"""
import sys
import time
import types

sys.path.insert(0, __file__.rsplit("/", 1)[0])
sys.modules["winbox_terminal_client"] = types.SimpleNamespace(WinboxTerminalClient=None)
import run  # noqa: E402

cmd = "/ip route print where dst-address=172.16.103.0/24 or dst-address=172.16.106.0/24"
raw = cmd[:50] + "\r\n" + cmd[50:] + "Yazd] > " + cmd + "\r\nFlags: A - ACTIVE\r\n0 As 172.16.103.0/24\r\n[u@SepehrYazd] > "
assert run.clean(raw, cmd) == "Flags: A - ACTIVE\n0 As 172.16.103.0/24"  # wrapped echo is cut
live = cmd[:48] + " \n" + cmd[48:] + cmd + "\nFlags: A - ACTIVE\n0 As 172.16.103.0/24"  # seen on .46
assert run.clean(live, cmd) == "Flags: A - ACTIVE\n0 As 172.16.103.0/24"
assert run.clean("/ppp/active/print\r\n0 name=x\r\n[u@Y] > ", "/ppp/active/print") == "0 name=x"


class Slow:  # router answers after 1.5 s of silence (big table)
    def __init__(self, chunks):
        self.chunks = list(chunks)

    def receive_terminal_output(self, timeout):
        time.sleep(0.05)
        return self.chunks.pop(0) if self.chunks else None


slow = Slow([b"/ip route print\r\n"] + [None] * 30 + [b"0 As 10.0.0.0/8\r\n", b"[u@Y] > "])
assert "10.0.0.0/8" in run.drain(slow, time.time() + 10, quiet_for=15)
print("ok")
