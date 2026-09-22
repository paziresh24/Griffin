# Egress proxy (Xray) — optional

Griffin needs a stable HTTPS path to its model provider (Cursor and/or Anthropic). Where that path
is blocked or unreliable, `compose.yaml`'s `infra` profile runs [Xray](https://xtls.github.io/) from
`$GRIFFIN_XRAY_DIR` and the app sends provider traffic through it.

`config.template.json` is the shape we run, with every secret replaced by a placeholder:
`<ID>`, `<ADDRESS>`, `<PASSWORD>`, `<SERVERNAME>`, `<PATH>`, `<HOST>`. Fill in your own outbounds.

What matters in it:

- **`burstObservatory`** probes each `proxy-*` outbound (interval 30s, 6 samples, timeout 8s) against
  the provider's own endpoint — not a generic reachability URL, which would pick a node that is up but
  blocked for the provider.
- **Balancer `leastLoad`** (`expected: 2`, `maxRTT: 3s`, `tolerance: 0.34`, plus baselines) with a
  fallback outbound. Switching happens per new connection, so no restart is needed. An earlier
  home-grown timer rewrote the config and restarted Xray every minute, which killed live agent
  streams; do not go back to that.
- **Route the provider domains through the balancer, never to `direct`.** One stale
  `full:api.cursor.com → direct` rule is enough to get `permission_denied … region` back while every
  other domain still works over the proxy.
- The `probe-*` inbounds pin one outbound each, so a single node can be tested by hand.

Only the inbound ports matter to Griffin: an HTTP proxy (`GRIFFIN_PROXY`) and, if the Telegram
account integration is used, a SOCKS inbound (`GRIFFIN_TELEGRAM_SOCKS`) — MTProto needs SOCKS.

## Apply a change

```bash
sudo cp -p /etc/xray/config.json /etc/xray/config.json.bak-$(date -u +%Y%m%dT%H%M%S)
sudo xray run -test -c /path/to/new.json
sudo install -m 640 /path/to/new.json /etc/xray/config.json
sudo systemctl restart xray   # or: docker compose -f deploy/compose.yaml restart xray
```

Test a new config as a second instance on another port before switching over. If other tools on the
host share this Xray, remember that every restart drops their connections too.
