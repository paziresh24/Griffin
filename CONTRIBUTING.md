# Contributing to Griffin

Thanks for helping. Griffin is small on purpose; the best contributions keep it that way.

## Run it locally

```bash
npm ci
npm test            # all workspaces
npm run build       # the web UI
GRIFFIN_DEMO=1 GRIFFIN_AUTH=off GRIFFIN_DATA=./data GRIFFIN_WORKSPACE=./workspace \
  PORT=3100 node apps/server/src/index.mjs
```

`GRIFFIN_DEMO=1` replaces the model with a scripted stand-in, so you can work on the UI and the
runtime without an API key.

## Where things live

| Path | What |
|---|---|
| `apps/server/` | agent runtime, providers, chats, jobs, messengers, MCP, auth |
| `apps/broker/` | credentials and typed tools, one module per tool pack |
| `apps/web/` | the UI |
| `packages/timeline/` | folds stored events into messages (server and UI) |
| `examples/agents/` | importable agent profiles |
| `docs/` | documentation and the website |

## Good first contributions

- A new example agent in `examples/agents/` (a JSON profile; see [docs/agents.md](docs/agents.md)).
- A new tool pack in `apps/broker/src/` — one module with schemas, guards in code, and a test.
- Docs: anything that confused you while setting Griffin up is worth a fix.
- Look for issues labelled [`good first issue`](https://github.com/paziresh24/Griffin/labels/good%20first%20issue).

## Pull requests

- One change per PR, with a test when it touches behaviour (`node --test`, no extra frameworks).
- Keep secrets out of code, tests and fixtures; build token-shaped fixtures at runtime.
- Write tool and permission changes so they are enforced in code, not only described in a prompt.
- `npm test` and `npm run build` must pass; CI runs both plus a quick-start smoke test.

## Reporting security issues

Please don't open a public issue — see [SECURITY.md](SECURITY.md).
