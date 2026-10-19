import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { ChevronDown, ListChecks, Menu, Network, PanelRightOpen, Square, Wifi, WifiOff, Zap } from "lucide-react";
import { Popover } from "radix-ui";
import { api, navigate, useChats, usePageRoute, useRoute, useTelegramPerson, useTimeline } from "./api.js";
import { connectionNotice } from "./timeline-memo.js";
import { lastRun } from "@griffin/timeline";
import { tabTitle } from "./tab-title.js";
import { BRAND, STORAGE, agentMeta, applyAgentTheme, readSetting, writeSetting } from "./brand.js";
import { textDir } from "./dir.js";
import { num, t, isRtl, locale } from "./i18n.js";
import { AgentsPage } from "./components/Agents.jsx";
import { JobsPage } from "./components/Jobs.jsx";
import { IncidentsPage } from "./components/Incidents.jsx";
import { PeersPage } from "./components/Peers.jsx";
import { InboxPeoplePage } from "./components/InboxPeople.jsx";
import { peopleRoute } from "./inbox-people.js";
import { GlobalPanel, MotherPanel, TelegramRedirect, WatchPill } from "./components/Telegram.jsx";
import { motherName } from "./telegram.js";
import { SettingsPage } from "./components/Settings.jsx";
import { WorkbenchPage } from "./components/Workbench.jsx";
import { SetupPage, setupFlowFromHash } from "./components/Setup.jsx";
import { GriffinRuntime, unwrapResult } from "./runtime.jsx";
import { Sidebar } from "./components/Sidebar.jsx";
import { ServerDown } from "./components/ServerDown.jsx";
import { AgentGlyph, ThemeToggle } from "./components/Controls.jsx";
import { ShareButton } from "./components/Share.jsx";
import { Toaster, toast } from "sonner";
import { FeedbackButton, FeedbackDialogs } from "./components/Feedback.jsx";
import { DEFAULT_ENGINE_EVENT } from "./components/Providers.jsx";
import { Thread } from "./components/Thread.jsx";
import { ChatRecord } from "./components/ComposerAssist.jsx";
import { ChatChildrenContext } from "./components/Tool.jsx";
import { SideChatButton, SidePanel } from "./components/SideChat.jsx";
import { RepoChips } from "./components/RepoChips.jsx";
import { emptySide, sideReducer } from "./side.js";
import { loadUiPrefs, useFlag, useLook } from "./ui-prefs.js";
import { arriveAt, lookAt, seedSeen, syncSeen } from "./seen.js";
import { SIDEBAR_WIDTH, clampSidebarWidth, isSidebarToggle, loadSidebarHidden, loadSidebarWidth, saveSidebarHidden, saveSidebarWidth } from "./sidebar-width.js";
import { badgeText } from "./chat-tools.js";
import { useSuggestions } from "./components/ChatTools.jsx";
import { quoteStore, withQuotes } from "./quotes.js";
import { formatTokens } from "./tokens-format.js";
import { useTouchPrimary } from "./touch.js";
import { useInbox } from "./inbox.js";
import { hasBoard } from "./board.js";
import { NeedsYou, TaskLists } from "./components/Board.jsx";

// The thread's connection state in the header (timeline-memo.js connectionNotice). `wrap`: the
// phone's own row, where the whole sentence shows.
function ConnectionNotice({ notice, onRetry, className = "flex", wrap = false, hideTextOnPhone = false }) {
  const tone = notice.tone === "warn" ? "text-warn" : notice.tone === "ok" ? "text-ok" : "text-muted-foreground";
  return (
    <span className={`min-w-0 items-center gap-1 text-xs ${tone} ${className}`} title={t(notice.text)}>
      {notice.tone === "warn" ? <WifiOff className="size-3.5 shrink-0" aria-hidden /> : notice.tone === "ok" ? <Wifi className="size-3.5 shrink-0" aria-hidden /> : null}
      <span className={wrap ? "min-w-0" : hideTextOnPhone ? "hidden truncate sm:inline" : "truncate"}>{t(notice.text)}</span>
      {notice.action ? <button type="button" onClick={onRetry} className="press shrink-0 rounded-md px-1.5 py-0.5 underline hover:bg-muted">{t(notice.action)}</button> : null}
    </span>
  );
}

// «به چت جدید» from a selection: the quote, the owner's request under it, then a line naming the chat
// it came from, so the agent can read that chat when it needs more (chat_read).
function newChatContextNote(id, title = "") {
  const name = String(title || "").replace(/\s+/g, " ").trim();
  return name
    ? t("این بخش از گفتگوی «{name}» (شناسهٔ {id}) است؛ اگر زمینهٔ بیشتری لازم شد، آن گفتگو را با chat_read بخوان.", { name, id })
    : t("این بخش از گفتگوی (شناسهٔ {id}) است؛ اگر زمینهٔ بیشتری لازم شد، آن گفتگو را با chat_read بخوان.", { id });
}

export default function App() {
  const chatId = useRoute();
  const page = usePageRoute();
  const telegramPerson = useTelegramPerson();
  const { chats, archived, groups, sideChat, privateShare, loading: chatsLoading, failed: chatsFailed, retry: retryChats } = useChats();
  const { timeline, connection, reconnect } = useTimeline(chatId);
  const notice = connectionNotice(connection);
  const listed = useMemo(() => [...chats, ...archived].find((c) => c.id === chatId) || null, [chats, archived, chatId]);
  const [fetchedChat, setFetchedChat] = useState(null);
  // What the owner just changed (mode, model, effort…) shows at once: the PATCH answer sits over the
  // record until the next list reload or fetch brings the same values.
  const [changed, setChanged] = useState(null);
  const record = listed || (fetchedChat?.id === chatId ? fetchedChat : null);
  useEffect(() => setChanged(null), [listed, fetchedChat]);
  const chat = record && changed?.id === record.id ? { ...record, ...changed.fields } : record;
  // Token use is only on the chat's own record (GET /api/chats/:id), not on the list: read it when
  // the chat opens and again when a run starts or ends.
  const [chatUsage, setChatUsage] = useState(null);
  useEffect(() => {
    setChatUsage(null);
    if (!chatId) return undefined;
    let alive = true;
    api(`/api/chats/${chatId}`)
      .then((data) => alive && setChatUsage(data?.chat ? { usage: data.chat.usage || null, billed: data.chat.usageBilled || null } : null))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [chatId, chat?.runStatus]);
  // «سرصفحهٔ گفتگو مثل کارسرا»: the header counts everything billed, as Karsara's does (usageBilled).
  const headerCounts = useFlag("headerCounts");
  const billedHeader = headerCounts;
  const usageOfChat = (billedHeader ? chatUsage?.billed || chat?.usageBilled : chat?.usage || chatUsage?.usage) || null;


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
    // A chat outside the list (a sub-agent, a thread) is fetched again on every list reload — every
    // run start/finish and «حل شد» — so its state (the error bar, the header's stop) follows its run.
  }, [chatId, listed, listed ? null : chats]);
  // While a chat is the open route and the tab is visible, its content counts as seen (seen.js): a
  // run that finishes in a hidden tab, or after the owner moved on, leaves it unread.
  useEffect(() => {
    if (!chats.length) return;
    // The read state lives on the server (seen.js); only when it cannot be reached does this
    // browser's own baseline stand in.
    const all = [...chats, ...archived];
    syncSeen(all).then((ok) => {
      if (!ok) seedSeen(all);
    });
  }, [chats, archived]);
  const seenTarget = chat?.updatedAt;
  const seenState = useRef({ chat: null, pending: false });
  useEffect(() => {
    // Opening the chat clears a hand-made «خوانده‌نشده» mark; coming back to the tab does not.
    arriveAt(seenState.current, chatId);
    if (!chatId || !seenTarget) return undefined;
    const see = () => lookAt(seenState.current, chatId, seenTarget, document.visibilityState === "visible");
    see();
    document.addEventListener("visibilitychange", see);
    return () => document.removeEventListener("visibilitychange", see);
  }, [chatId, seenTarget]);
  // The look (appearance only): the header's icon buttons, the drawer and the list's starting width.
  const karsara = useLook() === "karsara";
  const SidebarView = Sidebar;
  // The owner's look and flags from the server; the first load after the update saves this browser's.
  useEffect(() => {
    loadUiPrefs();
  }, []);
  const openSuggestionCount = useSuggestions().open.length;
  // «کارهای دستیار»: what waits for the owner and what runs, on the home page (Board.jsx).
  const inbox = useInbox();
  const menuBadge = openSuggestionCount + inbox.count;
  const board = useMemo(
    () => (!chatId && hasBoard(inbox, chats, openSuggestionCount) ? { top: <NeedsYou inbox={inbox} />, bottom: <TaskLists chats={chats} inbox={inbox} />, count: inbox.count + openSuggestionCount } : null),
    [chatId, inbox, chats, openSuggestionCount],
  );

  // A sub-agent's chat is not in the sidebar (its parent shows it above the composer): the parent's
  // row stands for it there.
  const sidebarActive = !listed && chat?.parentChatId ? chat.parentChatId : chatId;
  // The tab a chat belongs to; a sub-agent chat belongs to its parent's tab.
  const activeSource = useMemo(() => {
    if (!chat) return null;
    if (chat.global || chat.mother) return "telegram"; // the desk is an owner chat, but it lives under Telegram
    if (chat.source) return chat.source;
    const parent = chat.parentChatId ? [...chats, ...archived].find((c) => c.id === chat.parentChatId) : null;
    return parent?.source || null;
  }, [chat, chats, archived]);
  const [drawer, setDrawer] = useState(false);
  // The desktop list can be hidden for a wide chat (button or Ctrl/⌘+B, from Karsara); on a phone the
  // same keys open and close the drawer. Only in a chat: the other pages have no header to bring it back.
  const [sidebarHidden, setSidebarHidden] = useState(() => loadSidebarHidden(browserStorage()));
  useEffect(() => saveSidebarHidden(browserStorage(), sidebarHidden), [sidebarHidden]);
  const listHidden = sidebarHidden && !page;
  useEffect(() => {
    if (page) return undefined;
    const onKey = (event) => {
      if (!isSidebarToggle(event)) return;
      event.preventDefault();
      if (window.matchMedia("(min-width: 768px)").matches) setSidebarHidden((hidden) => !hidden);
      else setDrawer((open) => !open);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [page]);
  // The sidebar's filter for this visit: held here so it outlives the phone drawer (which unmounts)
  // and a visit to Settings; a reload clears it.
  const [sidebarFilter, setSidebarFilter] = useState("all");
  // A Telegram chat's side panel opens as a bottom sheet on a phone.
  const [panelSheet, setPanelSheet] = useState(false);
  useEffect(() => setPanelSheet(false), [chatId]);
  const telegramChat = Boolean(chat?.mother || chat?.global);
  const touch = useTouchPrimary();
  const [error, setError] = useState(null);
  const [theme, setTheme] = useState(() => readSetting(STORAGE.theme, "dark"));
  const [draft, setDraft] = useState(() => ({
    mode: "agent", // plan is a choice for one chat, never the default: not kept between chats
    model: readSetting(STORAGE.model, ""),
    effort: readSetting(STORAGE.effort, ""),
    agent: readSetting(STORAGE.agent, "griffin"),
    repo: null, // null = the server's default repo; "" = none
    groupId: "", // the owner's group a chat from a group's «+» goes into; that one new chat only
  }));

  // «پیش‌فرض کن» on an engine: new chats stop carrying the model last picked here (Providers.jsx).
  useEffect(() => {
    const onDefault = () => {
      writeSetting(STORAGE.model, "");
      setDraft((d) => ({ ...d, model: "" }));
    };
    window.addEventListener(DEFAULT_ENGINE_EVENT, onDefault);
    return () => window.removeEventListener(DEFAULT_ENGINE_EVENT, onDefault);
  }, []);

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
    : { ...draft, groupId: groups.some((g) => g.id === draft.groupId) ? draft.groupId : "" };
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
  // The tab names the open chat or page (and settings section), brand last (tab-title.js).
  const [settingsSection, setSettingsSection] = useState("");
  const chatTitle = chat ? chat.title || "" : null; // null: the chat's record has not loaded yet
  useEffect(() => {
    document.title = tabTitle({ page, section: page === "settings" ? settingsSection : "", chatId, chat: chatTitle == null ? null : { title: chatTitle }, running, needs: inbox.count });
  }, [page, settingsSection, chatId, chatTitle, running, inbox.count]);
  // The login form replaces the app on a 401: the tab must not keep the last chat's name.
  useEffect(() => () => {
    document.title = BRAND.title;
  }, []);

  // The sidebar's "new" (no group) and a group heading's "+" (that group). The group is for the new
  // chat on screen: opening a chat or another page (jobs, settings…) lets it go.
  // A repository's «+» (sidebar grouped by repo) also picks the new chat's repository.
  const newChatIn = useCallback((groupId, { repo } = {}) => {
    setDraft((d) => ({ ...d, groupId: groupId || "", ...(repo ? { repo } : {}) }));
    navigate(null);
  }, []);
  useEffect(() => {
    if (chatId || page) setDraft((d) => (d.groupId || d.mode !== "agent" ? { ...d, groupId: "", mode: "agent" } : d));
  }, [chatId, page]);
  const draftGroup = chat ? null : groups.find((g) => g.id === settings.groupId) || null;

  // The composer shows a change at once (see `changed`): a chat outside the sidebar list (a Telegram
  // mother chat, a sub-agent's) is read only once, and the list reloads a moment after the PATCH.
  const patchChat = (body) =>
    api(`/api/chats/${chat.id}`, { method: "PATCH", body })
      .then((data) => {
        if (!data?.chat) return;
        const keys = ["mode", "model", "effort", "agent", "repo", "provider"];
        setChanged({ id: data.chat.id, fields: Object.fromEntries(keys.filter((k) => k in data.chat).map((k) => [k, data.chat[k]])) });
      })
      .catch(setError);

  const updateSettings = async (patch) => {
    // The repo: on an open chat until its worktree exists (after that RepoChips moves it with /folder), else the next chat's.
    if (patch.repo != null) {
      if (chat) await patchChat({ repo: patch.repo });
      else setDraft((d) => ({ ...d, repo: patch.repo }));
      return;
    }
    // Model and effort are per chat (any provider: "claude:haiku"); the agent's default model and
    // effort live on the agents page. A fresh composer remembers them for the next chat.
    if (patch.model != null || patch.effort != null) {
      if (chat) await patchChat(patch);
      setDraft((d) => ({ ...d, ...patch }));
      if (patch.model != null) writeSetting(STORAGE.model, patch.model || "");
      if (patch.effort != null) writeSetting(STORAGE.effort, patch.effort || "");
      return;
    }
    if (chat && (patch.mode != null || patch.agent != null)) {
      await patchChat(patch);
      if (patch.agent) {
        setDraft((d) => ({ ...d, agent: patch.agent }));
        writeSetting(STORAGE.agent, patch.agent);
      }
    } else if (!chat) {
      setDraft((d) => ({ ...d, ...patch }));
      for (const [key, value] of Object.entries(patch)) {
        if (key === "agent") writeSetting(STORAGE.agent, value);
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
  // Off with the SIDE_CHAT switch (config.mjs; it rides on the chat list).
  const sideParent = sideChat && chatId && chat && !chat.parentChatId && !chat.sideOf && (chat.caller || "owner") === "owner" ? chatId : null;
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
    if (!error) return;
    // A message that did not reach the server is back in the box (runtime.jsx sets keptText); say so.
    const kept = error.keptText ? t("پیام فرستاده نشد و در کادر پیام ماند.") : "";
    const line = (text) => (kept ? `${text} ${kept}` : text);
    if (error.status === 409) toast.error(line(t("ایجنت هنوز روی پیام قبلی کار می‌کند.")));
    else if (!error.status && (error instanceof TypeError || error.keptText)) toast.error(`${t("ارتباط با سرور {name} قطع است.", { name: BRAND.name })} ${kept || t("دوباره امتحان کنید.")}`);
    else toast.error(line(t("خطا: {message}", { message: error.message })));
  }, [error]);

  // «به چت جدید» in the selection toolbar (SelectionActions): a plain new chat starts at once with the
  // selection, the owner's request and a line naming this chat, in this chat's repo. If it cannot be
  // made, nothing is lost: all of it waits in a new chat's box.
  useEffect(() => {
    const onNewChat = async (event) => {
      const { text, chatId: from, request } = event.detail || {};
      if (!String(text || "").trim()) return;
      const title = from && from === chatId ? chatTitle : "";
      const context = from ? newChatContextNote(from, title) : "";
      const ask = String(request || "").trim();
      try {
        if (!ask) throw new Error(t("درخواستی نوشته نشد"));
        const { chat: created } = await api("/api/chats", {
          method: "POST",
          body: {
            text: withQuotes([{ text, note: ask }], context),
            mode: draft.mode,
            ...(chat?.model ? { model: chat.model } : {}),
            effort: draft.effort || undefined,
            agent: settings.agent || "griffin",
            ...(chat?.repo ? { repo: chat.repo } : {}),
          },
        });
        if (created?.id) navigate(created.id);
      } catch (e) {
        quoteStore.add(null, { text, note: [ask, context].filter(Boolean).join("\n\n") });
        setDraft((d) => ({ ...d, repo: chat ? chat.repo || "" : null, groupId: "" }));
        navigate(null);
        toast.error(t("گفتگوی تازه شروع نشد؛ متن در کادر گفتگوی تازه ماند: {message}", { message: e.message }));
      }
    };
    window.addEventListener("griffin:new-chat-insert", onNewChat);
    return () => window.removeEventListener("griffin:new-chat-insert", onNewChat);
  }, [chatId, chatTitle, chat, draft.mode, draft.effort, settings.agent]);

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
          ...(settings.groupId ? { groupId: settings.groupId } : {}),
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
        <SettingsPage onBack={() => navigate(null)} onSection={setSettingsSection} />
      ) : (
        <>
          <ResizableSidebar initial={karsara ? SIDEBAR_WIDTH.karsara : SIDEBAR_WIDTH.initial} hidden={listHidden}>
            <SidebarView
              chats={chats}
              archived={archived}
              groups={groups} loading={chatsLoading} failed={chatsFailed} onRetry={retryChats}
              filter={sidebarFilter}
              onFilter={setSidebarFilter}
              onNewChat={newChatIn}
              activeId={sidebarActive}
              activeSource={activeSource}
              activePersonId={telegramPerson || chat?.personId || null}
              page={page}
              agent={settings.agent}
              onAgentChange={selectAgent}
              agentLocked={chat?.runStatus === "running"}
              onHide={page ? undefined : () => setSidebarHidden(true)}
            />
          </ResizableSidebar>
          {drawer ? (
            <div className="fixed inset-0 z-40 md:hidden">
              <div className={`absolute inset-0 ${karsara ? "bg-black/40" : "bg-black/50"}`} onClick={() => setDrawer(false)} />
              <div className={`absolute inset-y-0 start-0 ${karsara ? "w-[86%] max-w-80 border-e" : "w-[90%] max-w-96 shadow-xl"}`}>
                <SidebarView
                  chats={chats}
                  archived={archived}
                  groups={groups} loading={chatsLoading} failed={chatsFailed} onRetry={retryChats}
                  filter={sidebarFilter}
                  onFilter={setSidebarFilter}
                  onNewChat={newChatIn}
                  activeId={sidebarActive}
                  activeSource={activeSource}
                  activePersonId={telegramPerson || chat?.personId || null}
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
            {page === "jobs" ? <JobsPage onBack={() => navigate(null)} /> : page === "incidents" ? <IncidentsPage onBack={() => navigate(null)} /> : page === "peers" ? <PeersPage onBack={() => navigate(null)} /> : page === "inbox" ? <InboxPeoplePage peerId={peopleRoute(window.location.hash)?.peerId || null} onBack={() => navigate(null)} /> : page === "telegram" ? <TelegramRedirect personId={telegramPerson} /> : page === "agents" ? <AgentsPage onBack={() => navigate(null)} /> : page === "workbench" ? <WorkbenchPage onBack={() => navigate(null)} /> : <GriffinRuntime key={chatId || "new"} chatId={chatId} timeline={timeline} settings={settings} kept={chat?.kept || []} onError={onError}>
              <ChatChildrenContext.Provider value={chat?.children || []}>
              <ChatRecord.Provider value={chat}>
              <Thread
                header={
                  <header className="border-b px-2 pb-2 pt-[max(env(safe-area-inset-top),0.5rem)] sm:px-4">
                    <div className="flex items-center gap-2">
                    <button type="button" onClick={() => setDrawer(true)} className={karsara ? "kc-icon-btn relative md:hidden" : "relative rounded-lg p-2 hover:bg-muted md:hidden"} aria-label={t("منو")}>
                      <Menu className={karsara ? undefined : "size-5"} />
                      {badgeText(menuBadge) ? (
                        <span className="g-badge absolute end-0.5 top-0.5 rounded-full bg-signal px-1 text-[10px] leading-4 text-signal-foreground" aria-label={`${menuBadge} مورد منتظر شما`}>{badgeText(menuBadge)}</span>
                      ) : null}
                    </button>
                    {listHidden ? (
                      <button type="button" onClick={() => setSidebarHidden(false)} className={karsara ? "kc-icon-btn hidden md:inline-flex" : "hidden shrink-0 rounded-lg p-2 text-muted-foreground hover:bg-muted hover:text-foreground md:inline-flex"} aria-label={t("نمایش فهرست گفتگوها")} title={t("نمایش فهرست گفتگوها (Ctrl+B یا ⌘B)")}>
                        <PanelRightOpen className={karsara ? undefined : "size-4"} />
                      </button>
                    ) : null}
                    {chat?.personId && chat.caller === "team" && !chat.parentChatId && !chat.mother ? (
                      <button
                        type="button"
                        onClick={() => { window.location.hash = `/telegram/${chat.personId}`; }}
                        className="shrink-0 rounded-lg px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
                        dir="auto"
                      >
                        ← {chat.ownerLabel || t("چت مادر")}
                      </button>
                    ) : null}
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
                    {chat?.mother && chat.personId ? <WatchPill personId={chat.personId} /> : null}
                    {telegramChat ? (
                      <button type="button" onClick={() => setPanelSheet(true)} className="press shrink-0 rounded-full border px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-muted md:hidden">
                        {chat.mother ? t("ترد‌ها ({n})", { n: num((chat.children || []).filter((c) => c.runStatus === "running").length) }) : t("پنل")}
                      </button>
                    ) : null}
                    {chatId && notice ? (
                      // «سرصفحهٔ گفتگو مثل کارسرا»: a lost connection moves to its own row on a phone (below).
                      <ConnectionNotice notice={notice} onRetry={reconnect} hideTextOnPhone={Boolean(notice.action)} className={headerCounts && notice.action ? "hidden sm:flex" : "flex"} />
                    ) : null}
                    {usageOfChat?.total ? (
                      <span
                        className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground"
                        title={(usageOfChat.byModel || []).map((m) => `${m.model} ${formatTokens(m.tokens)}`).join(" · ")}
                      >
                        <Zap className="size-3" aria-hidden />
                        <bdi className="ltr">{formatTokens(usageOfChat.total)}</bdi>
                        <span className="hidden sm:inline">{t("توکن")}</span>
                      </span>
                    ) : null}
                    {/* A Telegram chat says whose it is in its title; "requested by team" meant nothing. */}
                    {chat?.caller && chat.caller !== "owner" && chat.caller !== "team" ? (
                      <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground" dir="auto">
                        {t("به درخواست {caller}", { caller: ({ scheduler: t("زمان‌بند"), griffin: BRAND.name, "arvan-ban": t("آروان‌بان"), "nsin-ban": t("انسین‌بان"), "platform": t("پلتفرم‌بان"), task: t("زیرایجنت") })[chat.caller] || chat.caller })}
                      </span>
                    ) : null}
                    {headerCounts && chat?.limitResumeAt ? <LimitResumeChip chat={chat} className="hidden sm:flex" /> : null}
                    {sideParent ? <SideChatButton open={side.open} count={side.sides.length} onClick={() => sideDispatch({ type: "toggle" })} /> : null}
                    {chat?.parentChatId && chat.runStatus === "running" ? (
                      <button type="button" onClick={() => stopChat(chat.id)} className="press inline-flex items-center gap-1 rounded-lg border px-2 py-1 text-xs text-bad hover:bg-bad/10">
                        <Square className="size-3.5" /> {t("توقف")}
                      </button>
                    ) : null}
                    <ShareButton chatId={chatId} privateShare={privateShare} />
                    <ThemeToggle theme={theme} onChange={setTheme} />
                    </div>
                    {headerCounts && chat?.limitResumeAt ? <LimitResumeChip chat={chat} className="mt-2 flex w-fit sm:hidden" /> : null}
                    {headerCounts && chatId && notice?.action ? <ConnectionNotice notice={notice} onRetry={reconnect} className="mt-2 flex sm:hidden" wrap /> : null}
                    {/* One live region that stays in the page, so a screen reader hears each change once. */}
                    <span className="sr-only" role="status" aria-live="polite">{chatId && notice && notice.tone !== "muted" && notice.text ? t(notice.text) : ""}</span>
                  </header>
                }
                runInfo={<>{chat?.mother ? null : <SubagentsBar chat={chat} />}<TodoProgress timeline={timeline} /></>}
                readOnly={chat?.caller === "task" || Boolean(chat?.parentChatId)}
                canSide={Boolean(sideParent)}
                agentLabel={agentMeta(settings.agent).label}
                agent={settings.agent}
                fresh={!chatId}
                board={board}
                recentTitles={recentTitles}
                placeholder={
                  // A phone's box is a few words wide: the short form there (the panel says the rest).
                  chat?.mother
                    ? touch ? t("فقط به {name} می‌رسد", { name: BRAND.name }) : t("به {name} بگویید — برای {person} فرستاده نمی‌شود", { name: BRAND.name, person: motherName(chat) })
                    : chat?.global
                      ? touch ? t("به {name} بگویید…", { name: BRAND.name }) : t("به {name} بگویید… (مثلاً: جواب خانم رضایی را بده)", { name: BRAND.name })
                      : ""
                }
                onSuggestion={quickSend}
                mode={settings.mode}
                model={settings.model}
                effort={settings.effort}
                chatId={chatId}
                onModeChange={(mode) => updateSettings({ mode })}
                onModelChange={(model) => updateSettings({ model })}
                onEffortChange={(effort) => updateSettings({ effort })}
                composerTop={
                  chat && ((chat.caller || "owner") !== "owner" || chat.global) ? null : (
                    <RepoChips
                      chatId={chat?.id || null}
                      repo={settings.repo}
                      locked={Boolean(chat?.worktreePath)}
                      branch={chat?.branch || null}
                      worktreePath={chat?.worktreePath || null}
                      onRepoChange={(repo) => updateSettings({ repo })}
                      group={draftGroup ? { name: draftGroup.name, onClear: () => setDraft((d) => ({ ...d, groupId: "" })) } : null}
                    />
                  )
                }
              />
              </ChatRecord.Provider>
              </ChatChildrenContext.Provider>
            </GriffinRuntime>}
          </main>
          {!page && chat?.mother ? <MotherPanel key={chat.id} chat={chat} sheet={panelSheet} onCloseSheet={() => setPanelSheet(false)} /> : null}
          {!page && chat?.global ? <GlobalPanel key={chat.id} chat={chat} sheet={panelSheet} onCloseSheet={() => setPanelSheet(false)} /> : null}
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

      <Toaster position="top-center" theme={theme} dir="rtl" closeButton toastOptions={{ className: "font-sans" }} />
      <ServerDown />
      <FeedbackDialogs />
      {chatId && !page ? <FeedbackButton /> : null}
    </div>
  );
}

function TodoProgress({ timeline }) {
  const [open, setOpen] = useState(false);
  const todos = useMemo(() => {
    // The whole run: a steered message splits it, and the list may sit in an earlier piece.
    const message = lastRun(timeline.messages);
    if (!message || message.status !== "running") return null;
    for (let j = message.parts.length - 1; j >= 0; j -= 1) {
      const part = message.parts[j];
      // Cursor's updateTodos, Claude's TodoWrite, the openai engine's todo_write.
      if (part.type === "tool" && /^(updateTodos|TodoWrite|todo_write)$/.test(part.name)) {
        return unwrapResult(part).result?.todos || part.args?.todos || null;
      }
    }
    return null;
  }, [timeline]);
  if (!todos?.length) return null;
  const closed = (t) => /complete|done|cancel/i.test(t.status);
  const done = todos.filter(closed).length;
  if (done === todos.length) return null;
  const current = todos.find((t) => /progress/i.test(t.status)) || todos.find((t) => !closed(t));
  return (
    <div className="g-box mb-2 rounded-xl border bg-card text-sm">
      <button type="button" onClick={() => setOpen(!open)} className="flex w-full items-center gap-2 px-3 py-2">
        <ListChecks className="size-4 text-primary" />
        <span className="ltr text-xs text-muted-foreground">{done}/{todos.length}</span>
        <span className="truncate" dir="auto">{current?.content}</span>
        <ChevronDown className={`ms-auto size-4 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open ? (
        <ul className="space-y-1 border-t px-3 py-2">
          {todos.map((t, i) => (
            <li key={i} className={closed(t) ? "text-muted-foreground line-through" : ""} dir="auto">{t.content}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

// Sub-agents this chat started, as a count above the composer; the list opens on demand.
// Stops one sub-agent chat (and whatever it delegated further); the parent keeps going.
function stopChat(id) {
  return api(`/api/chats/${id}/cancel`, { method: "POST" }).then(() => toast.success(t("متوقف شد")), (e) => toast.error(e.message));
}

function SubagentsBar({ chat }) {
  const [open, setOpen] = useState(false);
  const children = chat?.children || [];
  if (!children.length) return null;
  const running = children.filter((c) => c.runStatus === "running").length;
  const count = chat.childCount || children.length;
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button type="button" className="g-box press mb-2 flex items-center gap-2 rounded-xl border bg-card px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground data-[state=open]:text-foreground">
          <Network className="size-3.5 text-primary" />
          <span>{count} زیرایجنت</span>
          {running ? <span className="flex items-center gap-1 text-signal"><span className="agent-dots" aria-hidden><i /><i /><i /></span>{running} در حال کار</span> : null}
          <ChevronDown className={`size-3.5 transition-transform ${open ? "rotate-180" : ""}`} />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content side="top" align="start" sideOffset={6} className="pop z-50 max-h-80 w-80 overflow-y-auto rounded-xl border bg-card p-1 text-sm shadow-xl">
          {running > 1 ? (
            <button type="button" onClick={() => Promise.all(children.filter((c) => c.runStatus === "running").map((c) => stopChat(c.id)))} className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs text-bad hover:bg-bad/10">
              <Square className="size-3.5" /> {t("توقف همهٔ زیرایجنت‌ها")}
            </button>
          ) : null}
          {children.map((child) => (
            <div key={child.id} className="flex items-center rounded-lg hover:bg-muted">
              <button
                type="button"
                onClick={() => { setOpen(false); navigate(child.id); }}
                className="flex min-w-0 flex-1 items-center gap-2 px-2.5 py-2 text-start"
              >
                <AgentGlyph id={child.agent} className="size-4 shrink-0" />
                <span className="min-w-0 flex-1 truncate" dir={textDir(child.title)}>{child.title}</span>
                {child.runStatus === "running" ? (
                  <span className="agent-dots shrink-0 text-signal" aria-hidden><i /><i /><i /></span>
                ) : child.runStatus === "error" || child.runStatus === "cancelled" ? (
                  <span className="size-1.5 shrink-0 rounded-full bg-bad" title={t("خطا")} />
                ) : null}
              </button>
              {child.runStatus === "running" ? (
                <button type="button" onClick={() => stopChat(child.id)} className="press me-1 rounded-md p-1.5 text-muted-foreground hover:bg-bad/10 hover:text-bad" title={t("توقف این زیرایجنت")} aria-label={t("توقف این زیرایجنت")}>
                  <Square className="size-3.5" />
                </button>
              ) : null}
            </div>
          ))}
          {count > children.length ? <p className="px-2.5 py-1.5 text-xs text-muted-foreground">{t("و {n} مورد قدیمی‌تر", { n: num(count - children.length) })}</p> : null}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function LimitResumeChip({ chat, className = "" }) {
  const at = new Date(chat.limitResumeAt).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit", hour12: false });
  return (
    <span className={`${className} shrink-0 items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground`} title={t("این گفتگو به سقف مصرف خورد و بعد از بازشدن سقف خودش ادامه می‌دهد")}>
      {t("ادامهٔ خودکار ساعت {at}", { at })}
      <button
        type="button"
        className="rounded-full px-1 hover:bg-background hover:text-foreground"
        title={t("لغو ادامهٔ خودکار")}
        aria-label={t("لغو ادامهٔ خودکار")}
        onClick={() => api(`/api/chats/${chat.id}/limit-resume`, { method: "DELETE" }).catch((e) => toast.error(e.message))}
      >
        ×
      </button>
    </span>
  );
}

// The desktop sidebar with a draggable edge. The width is written straight to the
// element while dragging (the app does not re-render per pixel) and kept in the browser on release.
// The sidebar sits at the start of the RTL row, so its free edge is the inline end.
function browserStorage() {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function ResizableSidebar({ initial, hidden = false, children }) {
  const box = useRef(null);
  const [width, setWidth] = useState(() => loadSidebarWidth(browserStorage(), window.innerWidth, initial));
  const [dragging, setDragging] = useState(false);
  const rtl = () => getComputedStyle(box.current).direction === "rtl";
  const commit = (next) => {
    setWidth(next);
    saveSidebarWidth(browserStorage(), next);
  };
  const onPointerDown = (event) => {
    if (event.button) return;
    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    const rect = box.current.getBoundingClientRect();
    const fromRight = rtl();
    let latest = width;
    setDragging(true);
    document.body.style.userSelect = "none";
    const move = (e) => {
      latest = clampSidebarWidth(fromRight ? rect.right - e.clientX : e.clientX - rect.left, window.innerWidth);
      box.current.style.width = `${latest}px`;
    };
    const done = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", done);
      handle.removeEventListener("pointercancel", done);
      handle.removeEventListener("lostpointercapture", done);
      document.body.style.userSelect = "";
      setDragging(false);
      commit(latest);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", done);
    handle.addEventListener("pointercancel", done);
    handle.addEventListener("lostpointercapture", done);
  };
  const onKeyDown = (event) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const outward = (event.key === "ArrowLeft") === rtl(); // towards the chat: wider
    commit(clampSidebarWidth(width + (outward ? 16 : -16), window.innerWidth));
  };
  return (
    <div ref={box} className="relative hidden shrink-0 border-e md:block" style={{ width, display: hidden ? "none" : undefined }}>
      {children}
      <div
        className="absolute inset-y-0 -end-1 z-10 w-2 cursor-col-resize touch-none outline-none hover:bg-primary/25 focus-visible:bg-primary/40 data-[dragging=true]:bg-primary/40"
        role="separator"
        aria-orientation="vertical"
        aria-label={t("تغییر پهنای فهرست گفتگوها")}
        aria-valuemin={SIDEBAR_WIDTH.min}
        aria-valuemax={SIDEBAR_WIDTH.max}
        aria-valuenow={width}
        tabIndex={0}
        title={t("بکشید تا پهنا عوض شود؛ دو بار کلیک: پهنای معمول")}
        data-dragging={dragging ? "true" : undefined}
        onPointerDown={onPointerDown}
        onDoubleClick={() => commit(initial)}
        onKeyDown={onKeyDown}
      />
    </div>
  );
}
