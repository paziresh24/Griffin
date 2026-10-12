import { useCallback, useEffect, useMemo, useReducer, useState } from "react";
import { ChevronDown, ListChecks, Menu, Network, WifiOff } from "lucide-react";
import { Popover } from "radix-ui";
import { api, navigate, useChats, usePageRoute, useRoute, useTimeline } from "./api.js";
import { connectionNotice } from "./timeline-memo.js";
import { BRAND, STORAGE, agentMeta, applyAgentTheme, readSetting, writeSetting } from "./brand.js";
import { textDir } from "./dir.js";
import { num, t, isRtl } from "./i18n.js";
import { AgentsPage } from "./components/Agents.jsx";
import { JobsPage } from "./components/Jobs.jsx";
import { IncidentsPage } from "./components/Incidents.jsx";
import { PeersPage } from "./components/Peers.jsx";
import { TelegramPage } from "./components/Telegram.jsx";
import { SettingsPage } from "./components/Settings.jsx";
import { WorkbenchPage } from "./components/Workbench.jsx";
import { SetupPage, setupFlowFromHash } from "./components/Setup.jsx";
import { GriffinRuntime, unwrapResult } from "./runtime.jsx";
import { Sidebar } from "./components/Sidebar.jsx";
import { AgentGlyph, ThemeToggle } from "./components/Controls.jsx";
import { ShareButton } from "./components/Share.jsx";
import { UsageBadge } from "./components/Usage.jsx";
import { Toaster, toast } from "sonner";
import { Thread } from "./components/Thread.jsx";
import { ChatChildrenContext } from "./components/Tool.jsx";
import { SideChatButton, SidePanel } from "./components/SideChat.jsx";
import { RepoChips } from "./components/RepoChips.jsx";
import { emptySide, sideReducer } from "./side.js";

export default function App() {
  const chatId = useRoute();
  const page = usePageRoute();
  const { chats, archived } = useChats();
  const { timeline, connection } = useTimeline(chatId);
  const notice = connectionNotice(connection);
  const listed = useMemo(() => [...chats, ...archived].find((c) => c.id === chatId) || null, [chats, archived, chatId]);
  const [fetchedChat, setFetchedChat] = useState(null);
  const chat = listed || (fetchedChat?.id === chatId ? fetchedChat : null);

  useEffect(() => {
    if (!chatId || listed) {
      setFetchedChat(null);
      return undefined;
    }
    let alive = true;
    api(`/api/chats/${chatId}`)
      .then((data) => {
        if (alive && data?.chat) setFetchedChat(data.chat);
      })
      .catch(() => {
        if (alive) setFetchedChat(null);
      });
    return () => {
      alive = false;
    };
  }, [chatId, listed]);
  // The tab a chat belongs to; a sub-agent chat belongs to its parent's tab.
  const activeSource = useMemo(() => {
    if (!chat) return null;
    if (chat.source) return chat.source;
    const parent = chat.parentChatId ? [...chats, ...archived].find((c) => c.id === chat.parentChatId) : null;
    return parent?.source || null;
  }, [chat, chats, archived]);
  const [drawer, setDrawer] = useState(false);
  const [error, setError] = useState(null);
  const [theme, setTheme] = useState(() => readSetting(STORAGE.theme, "dark"));
  const [draft, setDraft] = useState(() => ({
    mode: readSetting(STORAGE.mode, "agent"),
    model: readSetting(STORAGE.model, ""),
    effort: readSetting(STORAGE.effort, ""),
    agent: readSetting(STORAGE.agent, "griffin"),
    repo: null, // null = the server's default repo; "" = none
  }));

  // First run (no engine key, wizard never finished): open the setup wizard once.
  useEffect(() => {
    api("/api/setup")
      .then((r) => {
        if (!r.done && r.needsEngine && !window.location.hash.startsWith("#/setup")) window.location.hash = "/setup/first";
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    writeSetting(STORAGE.theme, theme);
  }, [theme]);

  const settings = chat
    ? {
        mode: chat.mode,
        model: chat.model || draft.model || "",
        effort: chat.effort || "",
        agent: chat.agent || draft.agent || "griffin",
        repo: chat.repo || "",
      }
    : draft;
  useEffect(() => {
    applyAgentTheme(settings.agent);
  }, [settings.agent]);

  // Composer model follows the active agent profile when chat has no override.
  useEffect(() => {
    let alive = true;
    api(`/api/agents/${settings.agent}`)
      .then((body) => {
        if (!alive || !body?.agent) return;
        const model = body.agent.model || "";
        if (!chat) {
          setDraft((d) => (d.model === model ? d : { ...d, model }));
          writeSetting(STORAGE.model, model);
        }
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [settings.agent, chat]);

  const running = chats.some((c) => c.runStatus === "running");
  useEffect(() => {
    document.title = running ? `● ${BRAND.name}` : BRAND.name;
  }, [running]);

  const updateSettings = async (patch) => {
    // The repo: on an open chat until its worktree exists (the server refuses after), else the next chat's.
    if (patch.repo != null) {
      if (chat) await api(`/api/chats/${chat.id}`, { method: "PATCH", body: { repo: patch.repo } }).catch(setError);
      else setDraft((d) => ({ ...d, repo: patch.repo }));
      return;
    }
    // Model and effort are per chat (any provider: "claude:haiku"); the agent's default model and
    // effort live on the agents page. A fresh composer remembers them for the next chat.
    if (patch.model != null || patch.effort != null) {
      if (chat) await api(`/api/chats/${chat.id}`, { method: "PATCH", body: patch }).catch(setError);
      setDraft((d) => ({ ...d, ...patch }));
      if (patch.model != null) writeSetting(STORAGE.model, patch.model || "");
      if (patch.effort != null) writeSetting(STORAGE.effort, patch.effort || "");
      return;
    }
    if (chat && (patch.mode != null || patch.agent != null)) {
      await api(`/api/chats/${chat.id}`, { method: "PATCH", body: patch }).catch(setError);
      if (patch.agent) {
        setDraft((d) => ({ ...d, agent: patch.agent }));
        writeSetting(STORAGE.agent, patch.agent);
      }
    } else if (!chat) {
      setDraft((d) => ({ ...d, ...patch }));
      for (const [key, value] of Object.entries(patch)) {
        if (key === "agent") writeSetting(STORAGE.agent, value);
        else if (key === "mode") writeSetting(STORAGE.mode, value);
        else if (key === "model") writeSetting(STORAGE.model, value);
      }
    }
  };

  // Open chat: PATCH persona in place. Fresh composer: remember default for next chat.
  const selectAgent = (agent) => {
    if (chatId) updateSettings({ agent });
    else {
      setDraft((d) => ({ ...d, agent }));
      writeSetting(STORAGE.agent, agent);
    }
  };

  const onError = useCallback((e) => setError(e), []);

  // Side chat of the open chat: state per parent; a quote from «به چت کناری» opens it seeded.
  const [side, sideDispatch] = useReducer(sideReducer, emptySide());
  const [sideSeed, setSideSeed] = useState(null);
  const sideParent = chatId && chat && !chat.parentChatId && !chat.sideOf && (chat.caller || "owner") === "owner" ? chatId : null;
  useEffect(() => {
    sideDispatch({ type: "parent", id: sideParent });
    setSideSeed(null);
  }, [sideParent]);
  useEffect(() => {
    const onInsert = (event) => {
      if (!sideParent || !event.detail?.text) return;
      setSideSeed(event.detail.text);
      sideDispatch({ type: "open" });
    };
    window.addEventListener("griffin:side-insert", onInsert);
    return () => window.removeEventListener("griffin:side-insert", onInsert);
  }, [sideParent]);
  const clearSideSeed = useCallback(() => setSideSeed(null), []);
  useEffect(() => {
    if (error) toast.error(error.status === 409 ? t("ایجنت هنوز روی پیام قبلی کار می‌کند.") : t("خطا: {message}", { message: error.message }));
  }, [error]);

  const quickSend = async (prompt) => {
    try {
      const { chat: created } = await api("/api/chats", {
        method: "POST",
        body: {
          text: prompt,
          mode: draft.mode,
          model: draft.model,
          effort: draft.effort || undefined,
          agent: draft.agent || "griffin",
        },
      });
      navigate(created.id);
    } catch (e) {
      setError(e);
    }
  };

  const recentTitles = useMemo(() => chats.filter((c) => (c.source || "manual") === "manual").slice(0, 8).map((c) => c.title).filter(Boolean), [chats]);

  return (
    <div className="flex h-dvh overflow-hidden">
      {page === "setup" ? (
        <SetupPage key={setupFlowFromHash()} flow={setupFlowFromHash() || "first"} onClose={() => navigate(null)} />
      ) : page === "settings" ? (
        <SettingsPage onBack={() => navigate(null)} />
      ) : (
        <>
          <div className="hidden w-80 shrink-0 border-e md:block">
            <Sidebar
              chats={chats}
              archived={archived}
              activeId={chatId}
              activeSource={activeSource}
              page={page}
              agent={settings.agent}
              onAgentChange={selectAgent}
              agentLocked={chat?.runStatus === "running"}
            />
          </div>
          {drawer ? (
            <div className="fixed inset-0 z-40 md:hidden">
              <div className="absolute inset-0 bg-black/50" onClick={() => setDrawer(false)} />
              <div className="absolute inset-y-0 start-0 w-[90%] max-w-96 shadow-xl">
                <Sidebar
                  chats={chats}
                  archived={archived}
                  activeId={chatId}
                  activeSource={activeSource}
                  page={page}
                  agent={settings.agent}
                  onAgentChange={selectAgent}
                  agentLocked={chat?.runStatus === "running"}
                  onClose={() => setDrawer(false)}
                />
              </div>
            </div>
          ) : null}

          <main className="flex min-w-0 flex-1 flex-col">
            {page === "jobs" ? <JobsPage onBack={() => navigate(null)} /> : page === "incidents" ? <IncidentsPage onBack={() => navigate(null)} /> : page === "peers" ? <PeersPage onBack={() => navigate(null)} /> : page === "telegram" ? <TelegramPage onBack={() => navigate(null)} /> : page === "agents" ? <AgentsPage onBack={() => navigate(null)} /> : page === "workbench" ? <WorkbenchPage onBack={() => navigate(null)} /> : <GriffinRuntime key={chatId || "new"} chatId={chatId} timeline={timeline} settings={settings} kept={chat?.kept || []} onError={onError}>
              <ChatChildrenContext.Provider value={chat?.children || []}>
              <Thread
                header={
                  <header className="flex items-center gap-2 border-b px-2 pb-2 pt-[max(env(safe-area-inset-top),0.5rem)] sm:px-4">
                    <button type="button" onClick={() => setDrawer(true)} className="rounded-lg p-2 hover:bg-muted md:hidden" aria-label={t("منو")}>
                      <Menu className="size-5" />
                    </button>
                    {chat?.parentChatId ? (
                      <button
                        type="button"
                        onClick={() => navigate(chat.parentChatId)}
                        className="rounded-lg px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
                      >
                        {t("← بازگشت")}
                      </button>
                    ) : null}
                    <h1 className="min-w-0 flex-1 truncate text-sm font-medium" dir={textDir(chat?.title || t("گفتگوی جدید"))}>{chat?.title || t("گفتگوی جدید")}</h1>
                    {chatId && notice ? (
                      <span className={`flex items-center gap-1 text-xs ${notice.tone === "warn" ? "text-warn" : "text-muted-foreground"}`} title={connection}>
                        {notice.tone === "warn" ? <WifiOff className="size-3.5" /> : null} {t(notice.text)}
                      </span>
                    ) : null}
                    {chat?.caller && chat.caller !== "owner" ? (
                      <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground" dir="auto">
                        {t("به درخواست {caller}", { caller: ({ scheduler: t("زمان‌بند"), griffin: BRAND.name, "arvan-ban": t("آروان‌بان"), "nsin-ban": t("انسین‌بان"), "platform": t("پلتفرم‌بان"), task: t("زیرایجنت") })[chat.caller] || chat.caller })}
                      </span>
                    ) : null}
                    {sideParent ? <SideChatButton open={side.open} onClick={() => sideDispatch({ type: "toggle" })} /> : null}
                    <UsageBadge />
                    <ShareButton chatId={chatId} />
                    <ThemeToggle theme={theme} onChange={setTheme} />
                  </header>
                }
                runInfo={<><SubagentsBar chat={chat} /><TodoProgress timeline={timeline} /></>}
                readOnly={chat?.caller === "task" || Boolean(chat?.parentChatId)}
                agentLabel={agentMeta(settings.agent).label}
                agent={settings.agent}
                fresh={!chatId}
                recentTitles={recentTitles}
                onSuggestion={quickSend}
                mode={settings.mode}
                model={settings.model}
                effort={settings.effort}
                chatId={chatId}
                onModeChange={(mode) => updateSettings({ mode })}
                onModelChange={(model) => updateSettings({ model })}
                onEffortChange={(effort) => updateSettings({ effort })}
                composerTop={
                  chat && (chat.caller || "owner") !== "owner" ? null : (
                    <RepoChips
                      repo={settings.repo}
                      locked={Boolean(chat?.worktreePath)}
                      branch={chat?.branch || null}
                      worktreePath={chat?.worktreePath || null}
                      onRepoChange={(repo) => updateSettings({ repo })}
                    />
                  )
                }
              />
              </ChatChildrenContext.Provider>
            </GriffinRuntime>}
          </main>
          {page ? null : (
            <SidePanel
              parentId={sideParent}
              state={side}
              dispatch={sideDispatch}
              settings={settings}
              agentLabel={agentMeta(settings.agent).label}
              onError={onError}
              seed={sideSeed}
              onSeedConsumed={clearSideSeed}
            />
          )}
        </>
      )}

      <Toaster position="top-center" theme={theme} dir={isRtl ? "rtl" : "ltr"} toastOptions={{ className: "font-sans" }} />
    </div>
  );
}

function TodoProgress({ timeline }) {
  const [open, setOpen] = useState(false);
  const todos = useMemo(() => {
    for (let i = timeline.messages.length - 1; i >= 0; i -= 1) {
      const message = timeline.messages[i];
      if (message.role !== "assistant") continue;
      if (message.status !== "running") return null;
      for (let j = message.parts.length - 1; j >= 0; j -= 1) {
        const part = message.parts[j];
        if (part.type === "tool" && part.name === "updateTodos") {
          return unwrapResult(part).result?.todos || part.args?.todos || null;
        }
      }
      return null;
    }
    return null;
  }, [timeline]);
  if (!todos?.length) return null;
  const done = todos.filter((t) => /complete|done/i.test(t.status)).length;
  if (done === todos.length) return null;
  const current = todos.find((t) => /progress/i.test(t.status)) || todos.find((t) => !/complete|done/i.test(t.status));
  return (
    <div className="mb-2 rounded-xl border bg-card text-sm">
      <button type="button" onClick={() => setOpen(!open)} className="flex w-full items-center gap-2 px-3 py-2">
        <ListChecks className="size-4 text-primary" />
        <span className="ltr text-xs text-muted-foreground">{done}/{todos.length}</span>
        <span className="truncate" dir="auto">{current?.content}</span>
        <ChevronDown className={`ms-auto size-4 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open ? (
        <ul className="space-y-1 border-t px-3 py-2">
          {todos.map((t, i) => (
            <li key={i} className={/complete|done/i.test(t.status) ? "text-muted-foreground line-through" : ""} dir="auto">{t.content}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

// Sub-agents this chat started, as a count above the composer; the list opens on demand.
function SubagentsBar({ chat }) {
  const [open, setOpen] = useState(false);
  const children = chat?.children || [];
  if (!children.length) return null;
  const running = children.filter((c) => c.runStatus === "running").length;
  const count = chat.childCount || children.length;
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button type="button" className="press mb-2 flex items-center gap-2 rounded-xl border bg-card px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground data-[state=open]:text-foreground">
          <Network className="size-3.5 text-primary" />
          <span>{t("{n} زیرایجنت", { n: num(count) })}</span>
          {running ? <span className="flex items-center gap-1 text-primary"><span className="agent-dots" aria-hidden><i /><i /><i /></span>{t("{n} در حال کار", { n: num(running) })}</span> : null}
          <ChevronDown className={`size-3.5 transition-transform ${open ? "rotate-180" : ""}`} />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content side="top" align="start" sideOffset={6} className="pop z-50 max-h-80 w-80 overflow-y-auto rounded-xl border bg-card p-1 text-sm shadow-xl">
          {children.map((child) => (
            <button
              key={child.id}
              type="button"
              onClick={() => { setOpen(false); navigate(child.id); }}
              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-start hover:bg-muted"
            >
              <AgentGlyph id={child.agent} className="size-4 shrink-0" />
              <span className="min-w-0 flex-1 truncate" dir={textDir(child.title)}>{child.title}</span>
              {child.runStatus === "running" ? (
                <span className="agent-dots shrink-0 text-primary" aria-hidden><i /><i /><i /></span>
              ) : child.runStatus === "error" || child.runStatus === "cancelled" ? (
                <span className="size-1.5 shrink-0 rounded-full bg-bad" title={t("خطا")} />
              ) : null}
            </button>
          ))}
          {count > children.length ? <p className="px-2.5 py-1.5 text-xs text-muted-foreground">{t("و {n} مورد قدیمی‌تر", { n: num(count - children.length) })}</p> : null}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
