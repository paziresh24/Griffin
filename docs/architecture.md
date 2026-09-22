# Architecture

Griffin is two processes and one socket.

```
browser / Telegram / MCP client
            │
     ┌──────▼───────────────────────────────┐
     │ app  (apps/server)                   │   Hono + SQLite + SSE
     │  chats, runs, jobs, incidents        │   agent runtime (Cursor or Claude SDK)
     │  owner auth, peer tokens, MCP        │   holds the model key — no infra credentials
     └──────┬───────────────────────────────┘
            │ unix socket, typed JSON tools
     ┌──────▼───────────────────────────────┐
     │ broker (apps/broker)                 │   holds every credential
     │  kube, metrics, grafana, pg, s3,     │   guards enforced in code
     │  gitlab, secrets, routers, CDN, net  │   public API first, emergency SSH second
     └──────────────────────────────────────┘
```

**Why the split.** The agent process never holds an infrastructure credential, and it has no shell
tool. Everything it can do to the outside world is a named tool with a schema, executed by the broker,
which decides what the arguments are allowed to be. A prompt rule is a hint; the broker is the control.

**Why the emergency path.** Every cluster tool tries the public API first and falls back to SSH on a
node. The answer carries `source`, so you always know which path produced it. An agent that only works
while the platform is healthy is useless exactly when it is needed.

## The pieces

| Path | What it is |
|---|---|
| `apps/server/src/runner.mjs` | one live run per chat, queue/steer/cancel, resume after restart |
| `apps/server/src/providers/` | Cursor Agent SDK and Claude Agent SDK behind one interface |
| `apps/server/src/agents/` | agent profiles: which tools an agent owns, and which of them each caller gets |
| `apps/server/src/guard.mjs` | irreversible-action classifier: ask the owner, or refuse in an unattended chain |
| `apps/server/src/peers.mjs` | `delegate` / `ask_agent` / `subtasks` — agents handing work to agents |
| `apps/server/src/peer-auth.mjs`, `mcp.mjs` | external agents connect over MCP with their own token and quota |
| `apps/server/src/incidents/` | Alertmanager (and an optional business signal) → grouped incidents → ops room |
| `apps/server/src/integrations/` | Telegram/Bale bots and a Telegram account bridge |
| `apps/broker/src/` | the typed tools and every credential |
| `packages/timeline/` | folds stored events into messages; shared by server and UI |
| `apps/web/` | assistant-ui + streamdown, RTL, PWA |

## Authority model

Authority is a property of **who is calling**, not of the agent.

- Each agent declares the tools it owns, and per caller (`owner`, another agent, `scheduler`, `ops`,
  a peer user) the subset that caller gets. A missing row fails closed.
- Filtering happens where the tools are handed to the model (`filterTools`), so a tool outside the
  quota does not exist for that run — prompt text cannot talk its way around it.
- Irreversible work (merging, writing to a database, DNS, deleting, router writes) goes through
  `guard.mjs`: with a human at the root of the chain it asks the owner and waits; in an unattended
  chain (a scheduled job, the ops room) it refuses rather than guessing.
- `ask_owner` always reaches the owner, never whoever started the chain — a requester never approves
  their own request. `ask_requester` is the separate channel for "what did you mean?".

## Data

SQLite on the data volume, one file. Chats keep their raw event stream, which is folded into messages
by `packages/timeline`; a reconnecting client replays from `Last-Event-ID` instead of refetching. The
agent's own notes live in a plain git repository under the workspace, and only notes the owner has
reviewed are injected into the prompt — an unreviewed note is never treated as fact.
