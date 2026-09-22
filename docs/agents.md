# Agents

An agent in Griffin is a row in a table, not a class in the code. It has an id, a label, a line
about what it does, its own instructions, a model, a list of tools, and a list of who may call it
and with what. You create one from **#/agents → ایجنت جدید**, from the API, or by importing a JSON
profile. Nothing about agents requires a deploy.

A fresh install has exactly one agent (`griffin`) with the tools that exist everywhere — asking,
delegating, charts, files, notes, jobs, messengers. Everything else you add.

## What an agent is made of

| Field | What it decides |
|---|---|
| `id` | the handle other agents use (`delegate {agent: "release-manager"}`), and its workspace directory |
| `label`, `domain` | how it appears in the UI and in `list_agents`, so peers know what it is for |
| `instructions` | the agent's own brief, appended to the shared core rules on every run |
| `provider`, `model` | Cursor or Claude, and which model |
| `tools` / `allTools` | what it may use at all: a named list, or everything this install has |
| `callers` | who may call it, and which subset of its tools they get |

The prompt an agent actually receives is assembled per run:

```
core rules (honesty, tools over memory, delegation, asking)   ← shared, in code
its own instructions                                          ← yours, editable
who is calling now + that caller's tool list                  ← when it is not the owner
"a missing tool is not a result"                              ← shared
live peers it can delegate to                                 ← from the other agents
reviewed knowledge notes                                      ← notes the owner approved
```

## Access: authority belongs to the caller

Every run has a caller: the **owner** (you, in the UI), another **agent** (through `delegate` /
`ask_agent`), the **scheduler** (a job), the **ops room**, a person through a **messenger bridge**
(`team`), or an external **peer** connected over MCP (`peer:<user>`).

The agent's `callers` table says what each of them gets. The rules are deliberately blunt:

- The owner gets the agent's full tool list.
- Any other caller gets exactly the tools in its row — and a caller with **no row gets nothing**.
- Self-management tools (`agent_tools_*`, `list_agents`) are never given to a non-owner, whatever a
  row says: an agent that could widen its own quota has no quota.
- Filtering happens where tools are handed to the model, so a tool outside the quota does not exist
  for that run. Prompt text cannot argue its way around it.

On top of that, irreversible calls (merging, writing to a database, DNS, deletes, router writes) go
through the approval gate: with a human at the root of the chain the owner is asked and the run
waits; in an unattended chain (a job, the ops room) it is refused. Every decision lands in the
`approvals` table.

## Create one

From the UI: **#/agents → ایجنت جدید**, then set its tools and callers on the detail page.

From the API:

```bash
curl -sX POST localhost:3100/api/agents -H 'content-type: application/json' -d '{
  "id": "release-manager",
  "label": "Release manager",
  "domain": "prepares and checks releases",
  "instructions": "You prepare releases. You never merge without an explicit approval.",
  "tools": ["ask_owner", "ask_requester", "show_media", "knowledge_list"],
  "callers": { "owner": { "tools": "*" }, "griffin": { "tools": ["show_media"] } }
}'
```

Or import one of the ready-made profiles in [`examples/agents/`](../examples/agents):

```bash
curl -sX POST localhost:3100/api/agents -H 'content-type: application/json' \
  --data-binary @examples/agents/researcher.json
```

| Example | What it shows |
|---|---|
| `researcher.json` | a pure reading/summarising agent — no infrastructure at all |
| `platform.json` | an infrastructure agent that may hold every tool, with narrow quotas for its callers |
| `cdn-arvan.json`, `cdn-nsin.json` | vendor-scoped agents that hand cluster questions back to the platform agent |

They are examples, not defaults: import them only if they fit your world, and edit the instructions
to match it.

## Writing instructions that hold up

The core rules already cover honesty, using tools instead of memory, delegating, and asking before
irreversible actions — do not repeat them. Spend the instructions on what is specific:

- **Who it is and what it owns**, in one or two lines.
- **How it should decide**: what to check first, what proves an answer in this domain.
- **What it must never do**, in the imperative ("never merge without approval", "read-only").
- **Where its facts come from** when that is not obvious from the tool list.

Keep it short. An instruction the model cannot act on is decoration, and a tool it does not have is
not a rule — take the tool away instead.

## Delegation between agents

`delegate {agent, request}` starts a subtask and returns immediately; the result arrives in the
calling chat when it lands. `ask_agent` is the blocking variant for a quick read. `subtasks` lists,
steers or cancels what is running. A child runs with **the calling agent's quota** on the target, so
delegation can never be used to reach a tool the caller was not given.

`list_agents` is how an agent discovers who exists — ids, labels and domains come from the same
table you edit, so a new agent is immediately visible to the others.
