# Interfaces

The core is the product: agents, their tools, the quotas that bind them, and the runs those produce.
Everything you look at is a surface over that core, and the best surface is the one you never have to
open — Griffin should meet you where you already are, and come to you when something matters.

So the web UI is optional, and so is every other surface. They all drive the same API and see the
same chats.

## Terminal

```bash
griffin "why did last night's job fail?"     # ask, watch the tools run, get the answer
griffin -i                                   # keep talking in the same chat
griffin agents                               # who exists and what they may use
griffin agents new reviewer --instructions-file ./reviewer.md
griffin jobs run nightly-report
griffin health
```

`bin/griffin.mjs` finds the owner token by itself (`GRIFFIN_TOKEN`, or `<data>/owner.token` when it
runs on the same machine) and talks to `GRIFFIN_URL` (default `http://127.0.0.1:3100`). `--json`
gives you machine-readable output for scripts; `--quiet` prints the answer alone, which makes
`griffin -q "…" | tee report.md` a reasonable thing to do.

## Headless

```bash
GRIFFIN_WEB=off node apps/server/src/index.mjs
```

No static files are served; the API, the MCP endpoint, the messengers and the scheduler are
untouched. Use it when the box has no business serving a web app.

## HTTP API

Every route under `/api` takes `Authorization: Bearer <owner token>` as well as the browser session
cookie, so a script is as first-class as the UI:

```bash
curl -sX POST localhost:3100/api/chats -H "authorization: Bearer $GRIFFIN_TOKEN" \
     -H 'content-type: application/json' -d '{"text":"disk on the build host?"}'
curl -sN "localhost:3100/api/chats/$ID/stream" -H "authorization: Bearer $GRIFFIN_TOKEN"
```

The stream is Server-Sent Events: text deltas, tool starts and results, and `run.finished` at the
end — the same events the UI renders.

## Other agents (MCP)

`/mcp` is a Model Context Protocol endpoint. Another agent — Claude Code, for instance — connects
with its own token and gets task-shaped tools: send, wait, reply, cancel. That agent's identity is a
peer user with its own quota, so what it can reach is decided here, not by what it asks for.

```bash
claude mcp add --transport http griffin https://griffin.example.com/mcp \
  --header "Authorization: Bearer grf_…"
```

## Messengers

A Telegram or Bale bot, or a Telegram account bridge, makes the chat you already have with yourself
the interface. Jobs deliver there too, charts arrive as images, and a question from an agent becomes
buttons you tap. This is the closest thing to no interface at all: you never open Griffin, it
answers where you were already typing.

## Scheduled work

A job is a prompt, a trigger and a delivery target. Nobody watches it; it runs, and the result
arrives wherever you said. The whole run is a normal (hidden) chat, so when something looks wrong you
read it like any other conversation instead of digging through logs.

## What this means for new surfaces

If you add one, add it as a client of the API — not as a second brain. Rules, quotas, guards and
history stay in the core; a surface may choose what to show, never what is allowed.
