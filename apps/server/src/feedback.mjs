// «ارسال بازخورد» and «پشتیبانی» (profile menu, the button in a page corner):
// what the person wrote plus the details a fix needs — version, browser, page and chat, the last
// errors of the page and of the server, and a picture of the page. Every report is kept on this
// install (<data>/feedback.jsonl) and, when SUPPORT_AGENT names one, posted to the maintainer's install over the
// agents' network with the token that install gave this one. There it lands in its inbox
// (<data>/feedback-inbox, Settings → «بازخوردها»); a support request also goes to the owner's own
// Telegram (Saved Messages) at once.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { maskText } from "./redact.mjs";

const KINDS = { feedback: "بازخورد", support: "درخواست پشتیبانی", bug: "گزارش مشکل" };
const cut = (value, max) => maskText(String(value ?? "").slice(0, max * 2)).slice(0, max);

/** The stored report from the browser's body; null when nothing was written. */
export function feedbackReport(body, { commit = null, owner = "", install = "", serverErrors = [], now = new Date() } = {}) {
  const text = cut(body?.text, 4000).trim();
  if (!text) return null;
  return {
    at: now.toISOString(),
    kind: KINDS[body?.kind] ? body.kind : "feedback",
    text,
    install,
    owner,
    commit,
    client: {
      version: cut(body?.version, 40),
      browser: cut(body?.browser, 300),
      viewport: cut(body?.viewport, 20),
      page: cut(body?.page, 300),
      chatId: cut(body?.chatId, 64),
    },
    clientErrors: (Array.isArray(body?.errors) ? body.errors : []).slice(-15).map((e) => cut(e, 400)),
    serverErrors: serverErrors.slice(-10).map((e) => `${e.at} ${cut(e.line, 300)}${e.count > 1 ? ` ×${e.count}` : ""}`),
  };
}

/** The report as one plain message (the owner's Telegram): the details under the person's words. */
export function feedbackMessage(r) {
  const lines = [
    `${KINDS[r.kind]} از ${r.owner || "یک کاربر"} (${r.install || "نصب نامعلوم"})`,
    "",
    r.text,
    "",
    `نسخهٔ سرور: ${r.commit || "؟"} · نسخهٔ صفحه: ${r.client.version || "؟"}`,
    `مرورگر: ${r.client.browser || "؟"} (${r.client.viewport || "؟"})`,
    `صفحه: ${r.client.page || "؟"}${r.client.chatId ? ` · گفتگو: ${r.client.chatId}` : ""}`,
  ];
  if (r.clientErrors.length) lines.push("", "خطاهای اخیر صفحه:", ...r.clientErrors.map((e) => `- ${e}`));
  if (r.serverErrors.length) lines.push("", "خطاهای اخیر سرور:", ...r.serverErrors.map((e) => `- ${e}`));
  return lines.join("\n");
}

// A page picture from the browser (html-to-image): a JPEG/PNG/WebP data URL, at most 4 MB.
const SHOT = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/]+=*)$/;
const MAX_SHOT = 4 * 1024 * 1024;
export function shotOf(dataUrl) {
  const m = SHOT.exec(String(dataUrl || ""));
  if (!m) return null;
  const buf = Buffer.from(m[2], "base64");
  return buf.length && buf.length <= MAX_SHOT ? { ext: m[1] === "jpeg" ? "jpg" : m[1], buf } : null;
}

/** A report another install sent: every field cut again — it is someone else's data. */
export function cleanReport(r) {
  const base = feedbackReport(
    { text: r?.text, kind: r?.kind, version: r?.client?.version, browser: r?.client?.browser, viewport: r?.client?.viewport, page: r?.client?.page, chatId: r?.client?.chatId, errors: r?.clientErrors },
    { commit: cut(r?.commit, 40) || null, owner: cut(r?.owner, 80), install: cut(r?.install, 120) },
  );
  if (!base) return null;
  return { ...base, at: Number.isNaN(Date.parse(r?.at)) ? base.at : new Date(r.at).toISOString(), serverErrors: (Array.isArray(r?.serverErrors) ? r.serverErrors : []).slice(-10).map((e) => cut(e, 400)) };
}

const hostOf = (url) => {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return "";
  }
};
const ID = /^[0-9]{13}-[0-9a-f]{8}$/;

/**
 * network: createNetwork's { list, post } or null; supportHost / selfHost: the maintainer install's
 * host and this one's; notifyOwner(text, shot): the owner's Telegram, for a support request.
 */
export function createFeedback({ dataDir, network = null, supportHost = () => "", selfHost = () => "", context = () => ({}), notifyOwner = null, log = console }) {
  const file = path.join(dataDir, "feedback.jsonl");
  const inboxDir = path.join(dataDir, "feedback-inbox");
  let lastAt = 0;

  // Into this install's inbox: the report, its picture, and (support) the owner's Telegram.
  async function receive(rawReport, screenshot, from) {
    const report = cleanReport(rawReport);
    if (!report) return { ok: false, error: "empty report" };
    fs.mkdirSync(inboxDir, { recursive: true, mode: 0o700 });
    // Ids sort by arrival (the inbox lists newest first), two in one millisecond included.
    lastAt = Math.max(Date.now(), lastAt + 1);
    const id = `${lastAt}-${crypto.randomBytes(4).toString("hex")}`;
    const shot = shotOf(screenshot);
    if (shot) fs.writeFileSync(path.join(inboxDir, `${id}.${shot.ext}`), shot.buf, { mode: 0o600 });
    const item = { id, receivedAt: new Date().toISOString(), from: cut(from, 120), shot: shot ? `${id}.${shot.ext}` : null, ...report };
    fs.writeFileSync(path.join(inboxDir, `${id}.json`), JSON.stringify(item), { mode: 0o600 });
    let told = false;
    if (report.kind === "support" && notifyOwner) {
      try {
        // «🤖 » first: the assistant ignores its own marked lines in Saved Messages, so a colleague's text
        // never reads as the owner's request to it (telegram-account.mjs MARK).
        await notifyOwner(`🤖 ${feedbackMessage(report)}${item.from ? `\nفرستاده از: ${item.from}` : ""}`, shot?.buf || null);
        told = true;
      } catch (error) {
        log.error?.(`[feedback] support not sent to Telegram: ${error.message}`);
      }
    }
    return { ok: true, id, told };
  }

  async function submit(body) {
    const report = feedbackReport(body, context());
    if (!report) return { ok: false, error: "متن بازخورد خالی است" };
    const screenshot = shotOf(body?.screenshot) ? body.screenshot : null;
    fs.appendFileSync(file, `${JSON.stringify({ ...report, screenshot: Boolean(screenshot) })}\n`, { mode: 0o600 });
    const host = String(supportHost() || "").toLowerCase();
    // The maintainer's own install keeps it here.
    if (host && host === String(selfHost() || "").toLowerCase()) {
      const r = await receive(report, screenshot, report.owner);
      return { ok: true, sent: r.ok, told: r.told };
    }
    const agent = host ? network?.list?.().find((a) => a.connected && hostOf(a.url) === host) : null;
    if (!agent) return { ok: true, sent: false };
    try {
      const r = await network.post(agent.id, "/api/public/network/feedback", { report, screenshot });
      return { ok: true, sent: Boolean(r?.ok), told: Boolean(r?.told) };
    } catch (error) {
      log.error?.(`[feedback] not sent to ${host}: ${error.message}`);
      return { ok: true, sent: false };
    }
  }

  /** The inbox, newest first. */
  function inbox(limit = 200) {
    let names = [];
    try {
      names = fs.readdirSync(inboxDir).filter((n) => n.endsWith(".json")).sort().reverse().slice(0, limit);
    } catch {
      return [];
    }
    return names.flatMap((n) => {
      try {
        return [JSON.parse(fs.readFileSync(path.join(inboxDir, n), "utf8"))];
      } catch {
        return [];
      }
    });
  }
  /** An inbox picture's path, or null. */
  function shotFile(id) {
    if (!ID.test(String(id))) return null;
    for (const ext of ["jpg", "png", "webp"]) {
      const full = path.join(inboxDir, `${id}.${ext}`);
      if (fs.existsSync(full)) return { full, type: ext === "jpg" ? "image/jpeg" : `image/${ext}` };
    }
    return null;
  }

  /** POST /api/public/network/feedback: only a member of the agents' network, by the token this install gave it. */
  function routes(app, peerAuth) {
    app.post("/api/public/network/feedback", async (c) => {
      const who = peerAuth.authenticate(c.req.header("authorization"));
      if (who.error) return c.json({ error: who.error }, who.status);
      if (!String(who.userId).startsWith("net-")) return c.json({ error: "network members only" }, 403);
      if (Number(c.req.header("content-length") || 0) > 8 * 1024 * 1024) return c.json({ error: "too large" }, 413);
      const body = await c.req.json().catch(() => ({}));
      const r = await receive(body?.report, body?.screenshot, who.label);
      return c.json(r, r.ok ? 200 : 400);
    });
  }
  return { submit, receive, inbox, shotFile, routes };
}
