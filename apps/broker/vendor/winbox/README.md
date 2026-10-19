# Winbox terminal transport (vendored)

`winbox_terminal_client.py` is the MIT-licensed pure-Python implementation of MikroTik's Winbox
(TCP 8291) terminal protocol from https://github.com/subixonfire/winbox-terminal-protocol
(EC-SRP5 authentication + AES-128-CBC, the same protocol the Winbox app itself speaks).
`LICENSE` is that project's license, kept verbatim. One local patch: `M2.encode_uint` sends the terminal session id as u32 once it passes 255 (the upstream u8 encoding truncated it and the router ignored all input).

Why it is here: some routers deliberately keep the RouterOS **API** service off, and enabling a
service just so an agent can read the config is the wrong trade. This gives Griffin the same door a
person uses: a real RouterOS console over 8291, with nothing extra opened on the router.

`run.py` is ours: it takes `{host, port, user, password, command}` as JSON **on stdin** (never in
argv, so the credential is not visible in the process list), runs one console command, and prints
`{ok, output}`. Credentials come from the vault or the secret manager inside the broker and never reach
the agent.
