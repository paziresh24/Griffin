import { useCallback, useEffect, useState } from "react";
import { Switch } from "radix-ui";
import { Globe, Loader2, LogIn, Plus, Plug, RefreshCw, Terminal, Trash2 } from "lucide-react";
import { mcpCheckLine } from "../mcp.js";
import { MCP_PRESETS, mcpSourceLine, mcpStatus, missingPresets, presetForm, presetKeyMissing } from "../mcp.js";
import { toast } from "sonner";
import { api } from "../api.js";
import { Group, Item } from "./SettingsParts.jsx";
import { t } from "../i18n.js";

// Settings → MCP servers: the owner's user-scope servers in ~/.claude.json on the server
// (GET/PUT/DELETE /api/mcp-servers). Env and header values come back masked; leaving a mask as it
// is keeps the stored value.
const toLines = (map) => Object.entries(map || {}).map(([k, v]) => `${k}=${v}`).join("\n");
const fromLines = (text) =>
  Object.fromEntries(
    text.split("\n").map((line) => line.trim()).filter(Boolean).map((line) => {
      const at = line.search(/[=:]/);
      return at < 0 ? [line, ""] : [line.slice(0, at).trim(), line.slice(at + 1).trim()];
    }),
  );

// «ورود» only where OAuth can apply: an http/sse server that already has its own Authorization header (a fixed token) is not offered it.
const canLogin = (s) => s.type !== "stdio" && (Boolean(s.login?.signedIn) || !Object.keys(s.headers || {}).some((k) => k.toLowerCase() === "authorization"));

export function McpServersSection() {
  const [data, setData] = useState(null);
  const [form, setForm] = useState(null);
  const load = () => api("/api/mcp-servers").then(setData).catch((e) => { toast.error(e.message); setData({ servers: [], error: e.message }); });
  useEffect(() => { load(); }, []);
  // «بررسی اتصال»: Griffin itself calls each http/sse server; the result sits under its name.
  const [checks, setChecks] = useState({});
  const check = async (name) => {
    setChecks((c) => ({ ...c, [name]: { busy: true } }));
    try {
      const r = await api(`/api/mcp-servers/${encodeURIComponent(name)}/check`, { method: "POST" });
      setChecks((c) => ({ ...c, [name]: r }));
    } catch (e) {
      setChecks((c) => ({ ...c, [name]: { checked: true, ok: false, reason: e.message } }));
    }
  };
  useEffect(() => { for (const s of data?.servers || []) if (s.type !== "stdio") check(s.name); }, [data]);

  const remove = async (name) => {
    if (!window.confirm(t("سرور «{name}» پاک شود؟", { name }))) return;
    try {
      await api(`/api/mcp-servers/${encodeURIComponent(name)}`, { method: "DELETE" });
      load();
    } catch (e) {
      toast.error(e.message);
    }
  };

  // OAuth sign-in: the server's own page opens; it ends on Griffin's callback page.
  const login = async (name) => {
    try {
      const { url } = await api(`/api/mcp-servers/${encodeURIComponent(name)}/login`, { method: "POST", body: { origin: window.location.origin } });
      window.open(url, "_blank", "noopener");
      toast.message(t("صفحه‌ی ورود باز شد؛ بعد از ورود، اینجا «تازه‌سازی» کنید."));
    } catch (e) {
      toast.error(e.message);
    }
  };

  if (!data) return <div className="flex justify-center py-10 text-muted-foreground"><Loader2 className="size-5 animate-spin" /></div>;
  return (
    <div className="space-y-6">
      <p className={`rounded-xl border px-3 py-2 text-xs leading-6 ${data.claudeCode ? "text-muted-foreground" : "border-warn/40 bg-warn/10"}`}>
        {t("این سرورها فقط وقتی «Claude Code کامل» (CLAUDE_CODE) در پیکربندی روشن است، در گفتگوهای خود شما با موتور Claude بار می‌شوند؛ گفتگوی همکاران و جاب‌ها هرگز.{v} تغییر از گفتگوی بعدی اثر می‌کند.", { v: data.claudeCode ? "" : t(" الان خاموش است.") })}
      </p>
      {form ? <McpForm initial={form} onDone={() => { setForm(null); load(); }} /> : null}
      <McpLive />
      <Group
        title={<span dir="ltr">{data.file || "~/.claude.json"}</span>}
        action={<button type="button" onClick={() => setForm({ type: "stdio" })} className="press inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-muted-foreground hover:bg-muted"><Plus className="size-3.5" /> {t("افزودن")}</button>}
      >
        {data.servers.length ? data.servers.map((s) => (
          <Item
            key={s.name}
            icon={s.type === "stdio" ? Terminal : Globe}
            title={s.name}
            subtitle={
              <>
                {s.type === "stdio" ? [s.command, ...s.args].join(" ") : `${s.type} · ${s.url}${s.login?.signedIn ? t(" · وارد شده") : ""}`}
                {checks[s.name] ? <McpCheckLine result={checks[s.name]} /> : null}
              </>
            }
            trailing={
              <>
                {canLogin(s) ? <button type="button" onClick={() => login(s.name)} className="press inline-flex items-center gap-1 rounded-lg border px-2 py-1 text-xs"><LogIn className="size-3.5" /> {s.login?.signedIn ? t("ورود دوباره") : t("ورود")}</button> : null}
                {s.type !== "stdio" ? <button type="button" disabled={checks[s.name]?.busy} onClick={() => check(s.name)} className="press rounded-lg border px-2 py-1 text-xs disabled:opacity-50">{t("بررسی اتصال")}</button> : null}
                <button type="button" onClick={() => setForm({ ...s, previous: s.name })} className="press rounded-lg border px-2 py-1 text-xs">{t("ویرایش")}</button>
                <button type="button" onClick={() => remove(s.name)} className="press rounded-lg p-1.5 text-muted-foreground hover:bg-bad/10 hover:text-bad" aria-label={t("حذف")}><Trash2 className="size-4" /></button>
              </>
            }
          />
        )) : <Item title={data.error ? t("فایل خوانده نشد") : t("هنوز سروری نیست")} subtitle={data.error || t("با «افزودن» یک سرور MCP بگذارید.")} />}
      </Group>
      {missingPresets(data.servers).length ? (
        <Group title={t("پیشنهادی")}>
          {missingPresets(data.servers).map((p) => (
            <Item
              key={p.id}
              icon={Plug}
              title={p.title}
              subtitle={p.summary}
              trailing={<button type="button" onClick={() => setForm(presetForm(p))} className="press inline-flex items-center gap-1 rounded-lg border px-2 py-1 text-xs"><Plus className="size-3.5" /> {t("افزودن")}</button>}
            />
          ))}
        </Group>
      ) : null}
    </div>
  );
}

function McpForm({ initial, onDone }) {
  const [name, setName] = useState(initial.name || "");
  const [type, setType] = useState(initial.type || "stdio");
  const [command, setCommand] = useState(initial.command || "");
  const [args, setArgs] = useState((initial.args || []).join("\n"));
  const [url, setUrl] = useState(initial.url || "");
  const [pairs, setPairs] = useState(toLines(initial.type === "stdio" ? initial.env : initial.headers));
  const [busy, setBusy] = useState(false);
  const field = "w-full rounded-lg border bg-background px-3 py-2 text-sm";
  const stdio = type === "stdio";
  // A preset (mcp.js MCP_PRESETS) whose key line is still empty cannot be saved yet.
  const preset = MCP_PRESETS.find((p) => p.name === initial.name && !initial.previous && p.url === initial.url);
  const keyMissing = presetKeyMissing(preset, pairs);
  const save = async () => {
    setBusy(true);
    try {
      const server = stdio
        ? { type, command, args: args.split("\n").map((a) => a.trim()).filter(Boolean), env: fromLines(pairs) }
        : { type, url, headers: fromLines(pairs) };
      await api("/api/mcp-servers", { method: "PUT", body: { name: name.trim(), previous: initial.previous, server } });
      toast.success(t("ذخیره شد"));
      onDone();
    } catch (e) {
      toast.error(e.message);
      setBusy(false);
    }
  };
  return (
    <div className="space-y-3 rounded-2xl border bg-card p-4">
      <p className="text-sm font-medium">{initial.previous ? t("ویرایش «{previous}»", { previous: initial.previous }) : t("سرور MCP تازه")}</p>
      <input className={field} dir="ltr" value={name} onChange={(e) => setName(e.target.value)} placeholder="name (e.g. github)" />
      <div className="flex gap-1.5">
        {["stdio", "http", "sse"].map((t) => (
          <button key={t} type="button" onClick={() => setType(t)} className={`press rounded-lg border px-3 py-1.5 text-xs ${type === t ? "border-primary/40 bg-primary/10 font-medium" : "text-muted-foreground"}`} dir="ltr">{t}</button>
        ))}
      </div>
      {stdio ? (
        <>
          <input className={`${field} font-mono`} dir="ltr" value={command} onChange={(e) => setCommand(e.target.value)} placeholder="command (e.g. npx)" />
          <textarea className={`${field} min-h-16 font-mono`} dir="ltr" value={args} onChange={(e) => setArgs(e.target.value)} placeholder={"args, one per line\n-y\n@modelcontextprotocol/server-github"} spellCheck={false} />
        </>
      ) : (
        <input className={`${field} font-mono`} dir="ltr" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…/mcp" />
      )}
      <textarea className={`${field} min-h-16 font-mono`} dir="ltr" value={pairs} onChange={(e) => setPairs(e.target.value)} placeholder={stdio ? "env, one per line: KEY=value" : "headers, one per line: Authorization=Bearer …"} autoComplete="off" spellCheck={false} />
      {initial.hint ? <p className="text-xs leading-6 text-muted-foreground">{initial.hint}</p> : null}
      <p className="text-xs text-muted-foreground">{t("مقدارهای {v} پنهان نشان داده می‌شوند؛ اگر دست نخورند همان مقدار قبلی می‌ماند.", { v: stdio ? "env" : t("هدر") })}</p>
      <div className="flex gap-2">
        <button type="button" onClick={save} disabled={busy || keyMissing || !name.trim() || !(stdio ? command.trim() : url.trim())} className="press inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-60">
          {busy ? <Loader2 className="size-4 animate-spin" /> : null} {t("ذخیره")}
        </button>
        <button type="button" onClick={onDone} className="press rounded-lg border px-3 py-2 text-sm">{t("انصراف")}</button>
      </div>
    </div>
  );
}

function McpCheckLine({ result }) {
  if (result.busy) return <span className="block text-muted-foreground"><Loader2 className="inline size-3 animate-spin" /> {t("در حال بررسی…")}</span>;
  const line = mcpCheckLine(result);
  return line ? <span className={`block ${TONE[line.tone]}`}>{line.text}</span> : null;
}

const TONE = { ok: "text-ok", bad: "text-bad", warn: "text-warn", muted: "text-muted-foreground" };

// What the open Claude Code process actually has (from Karsara): each server's state, its tool
// count, an on/off and «اتصال دوباره». A server's live state exists only inside a running process.
function McpLive() {
  const [view, setView] = useState(null);
  const [busy, setBusy] = useState(null);
  const load = useCallback(() => api("/api/mcp").then(setView, (e) => setView({ available: false, reason: e.message })), []);
  useEffect(() => { load(); }, [load]);
  const act = async (name, body) => {
    setBusy(name);
    try {
      setView(await api("/api/mcp", { method: "POST", body: { name, ...body } }));
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(null);
    }
  };
  const servers = view?.available ? view.servers || [] : [];
  return (
    <Group
      title={t("وضعیت زنده")}
      action={<button type="button" onClick={load} className="press inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-muted-foreground hover:bg-muted"><RefreshCw className="size-3.5" /> {t("تازه کردن")}</button>}
    >
      {!view ? <Item title={t("در حال خواندن…")} /> : !servers.length ? <Item icon={Plug} title={view.available ? t("سرور MCPی بار نشده") : t("در دسترس نیست")} subtitle={mcpSourceLine(view)} /> : null}
      {servers.map((server) => {
        const status = mcpStatus(server.status);
        const enabled = server.status !== "disabled";
        return (
          <Item
            key={server.name}
            icon={Plug}
            title={<span dir="ltr">{server.name}</span>}
            subtitle={
              <>
                <span className={TONE[status.tone]}>{status.label}</span>
                {server.tools != null ? t(" · {toLocaleString} ابزار", { toLocaleString: Number(server.tools).toLocaleString("fa-IR") }) : ""}
                {server.error ? <span className="block break-words text-bad" dir="ltr">{server.error}</span> : null}
              </>
            }
            trailing={
              <>
                {enabled ? (
                  <button type="button" disabled={busy === server.name} onClick={() => act(server.name, { action: "reconnect" })} className="press rounded-lg border px-2 py-1 text-xs disabled:opacity-50">
                    {busy === server.name ? <Loader2 className="size-3.5 animate-spin" /> : t("اتصال دوباره")}
                  </button>
                ) : null}
                <Switch.Root
                  checked={enabled}
                  disabled={busy === server.name}
                  onCheckedChange={(value) => act(server.name, { action: "toggle", enabled: value })}
                  dir="ltr"
                  className="relative h-6 w-11 shrink-0 rounded-full bg-muted transition-colors data-[state=checked]:bg-primary"
                  aria-label={t("روشن یا خاموش کردن {name}", { name: server.name })}
                >
                  <Switch.Thumb className="block size-5 translate-x-0.5 rounded-full bg-background shadow transition-transform duration-200 data-[state=checked]:translate-x-[1.375rem]" />
                </Switch.Root>
              </>
            }
          />
        );
      })}
      {view?.available && servers.length ? <p className="px-4 py-2 text-xs text-muted-foreground" dir="auto">{mcpSourceLine(view)}</p> : null}
    </Group>
  );
}
