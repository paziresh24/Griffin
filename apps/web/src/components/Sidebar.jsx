import { useEffect, useMemo, useRef, useState } from "react";
import { Popover } from "radix-ui";
import {
  Archive, ArchiveRestore, ArrowDownAZ, ArrowUpDown, Bot, Check, ChevronDown, ChevronRight,
  BellRing, CircleHelp, ExternalLink, Filter, FolderInput, FolderPlus, FolderTree, Mail, MailOpen, MoreHorizontal, Pencil, Pin, PinOff, Plus, RotateCcw, Search,
  Box, Inbox, LayoutDashboard, PanelRightClose, Server, Settings2, Store, Trash2, Users, X,
} from "lucide-react";
import { toast } from "sonner";
import { api, navigate, usePolling } from "../api.js";
import { BRAND, agentMeta, iconUrl, readSetting, writeSetting } from "../brand.js";
import { PROFILE_EVENT, ownerView } from "../profile.js";
import { textDir } from "../dir.js";
import { FILTERS, GROUPS, SORTS, ago, chatState, filterChats, groupChats, reminderLabel, searchChats, sortChats } from "../chat-list.js";
import { isUnreadChat, markSeen, markUnread, seenOf, useSeenVersion } from "../seen.js";
import { isPlainClick } from "../sidebar-width.js";
import { setUiPrefs, useFlag, useUiPrefs } from "../ui-prefs.js";
import { AgentGlyph, AgentPicker } from "./Controls.jsx";
import { TelegramList } from "./Telegram.jsx";
import { SidebarSuggestions } from "./ChatTools.jsx";
import { useInbox } from "../inbox.js";
import { peoplePath } from "../inbox-people.js";
import { exactTime } from "../elapsed.js";
import { inboxRow, shortAgo } from "../karsara-shell.js";
import { OneList, RepoNewChat, UserMenu } from "./SidebarOneList.jsx";
import { UpdateNotice, useUpdateDot } from "./UpdateNotice.jsx";
import { HostNotice } from "./HostNotice.jsx";
import { TwoStepNotice } from "./TwoStepNotice.jsx";
import { ListStatus } from "./ListStatus.jsx";
import { FeedbackBarButton, PROFILE_ITEMS, profileAction } from "./Feedback.jsx";
import { useListChoice, useSectionOrder } from "../list-prefs.js";
import { groupOrder, sectionDrag } from "../drag.js";
import { chatDragProps, groupDragProps, useSectionDrop } from "./SidebarDrag.jsx";
import { NavLauncher, NavSlot, PaletteKey, PinnedRow, SectionMenuFoot, SectionMenuItems, navStyleOf, useSections } from "./SectionNav.jsx";
import { t, isRtl } from "../i18n.js";

const isUnread = (chat) => isUnreadChat(chat, seenOf(chat.id));

// Each tab lists only its own threads: «گفتگو» is what the owner started by hand; Telegram-born,
// peer, ops-room and job threads live under their tabs. Sub-agent chats never appear here: the parent
// chat shows them above the composer (SubagentsBar) and in its tool cards.
const SECTIONS = {
  manual: { page: null, label: t("گفتگوهای اخیر") },
  telegram: { page: "telegram", label: t("چت‌های تلگرام") },
  peer: { page: "peers", label: t("کارهای ایجنت‌های همکاران") },
  ops: { page: "incidents", label: t("اتاق‌های عملیات") },
  workbench: { page: "workbench", label: t("میز کار") },
  job: { page: "jobs", label: t("اجراهای جاب") },
};
// The Telegram desk («🌐 … — همه») is an owner chat but belongs under Telegram, pinned there.
const sourceOf = (chat) => (chat.global ? "telegram" : chat.source || "manual");
const sectionOfPage = (page) => Object.keys(SECTIONS).find((k) => SECTIONS[k].page === page && page) || null;

export function Sidebar({ chats, archived, groups = [], looseAt = null, loading = false, failed = false, onRetry = null, filter = "all", onFilter, onNewChat = null, activeId, activeSource = null, activePersonId = null, page = null, agent, onAgentChange, onClose, onHide }) {
  const { look, flags } = useUiPrefs();
  const k = look === "karsara";
  // «یک فهرست برای همه»: the owner's chats, the job runs and the peers' chats share one list, which stays
  // on screen when a job run or a peer chat is open (and on the jobs and peers pages).
  const listSource = flags.oneList && (activeSource === "job" || activeSource === "peer") ? "manual" : activeSource;
  const section = sectionOfPage(page) || (!page && listSource && SECTIONS[listSource] ? listSource : "manual");
  const oneList = flags.oneList && (section === "manual" || section === "job" || section === "peer");
  const inbox = useInbox(); // «جدید» counts what waits for the owner (the home-page board)

  // A new chat, in a group when it comes from that group's «+».
  const startChat = (groupId = null, options = {}) => {
    if (onNewChat) onNewChat(groupId, options);
    else navigate(null);
    onClose?.();
  };
  const go = (hash) => {
    window.location.hash = hash;
    onClose?.();
  };
  // «فضای کار» and the top sections (which sections: «بازارچه»; how: Settings → «ظاهر»), the same in both
  // lists. «فضای کار» (was «جدید» with a robot, a colleague 2026-10-24) and its «+» both open the home page:
  // what waits for the owner above, a new chat's box below.
  const nav = {
    top: (
      <div className="mt-2 flex items-center gap-1 px-2">
        <div className="min-w-0 flex-1">
          <NavButton k={k} active={!page && !activeId} icon={LayoutDashboard} href="#/" label={t("فضای کار")} onClick={() => startChat(null)} badge={flags.homeBoard ? inbox.count : 0} />
        </div>
        <a
          href="#/"
          onClick={(event) => {
            if (!isPlainClick(event)) return;
            event.preventDefault();
            startChat(null);
          }}
          className={k ? "kc-icon-btn shrink-0" : "press flex size-9 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground"}
          title={t("گفتگوی جدید")}
          aria-label={t("گفتگوی جدید")}
        >
          <Plus className="size-4" />
        </a>
      </div>
    ),
    // The one list marks a section by the page alone (an open job run keeps «جاب» unmarked, as Karsara does).
    sections: <SidebarNav section={oneList ? sectionOfPage(page) : section} go={go} k={k} flags={flags} />,
  };

  return (
    <aside className={k ? "flex h-full w-full flex-col bg-background" : "g-sidebar flex h-full w-full flex-col bg-card"}>
      <div className={`flex min-w-0 items-center ${k ? "gap-2 px-2 pb-2 pt-[max(env(safe-area-inset-top),0.6rem)]" : "gap-3 px-3 pb-3 pt-[max(env(safe-area-inset-top),0.85rem)]"}`}>
        {/* The logo goes home, to a new chat (a colleague 2026-10-24: «لوگوهای بالا به صفحهٔ جدید هدایت نمی‌کنند»). */}
        {k ? null : (
          <a
            href="#/"
            onClick={(event) => {
              if (!isPlainClick(event)) return;
              event.preventDefault();
              startChat(null);
            }}
            className="press shrink-0 rounded-xl"
            title={t("{name} — فضای کار", { name: BRAND.name })}
            aria-label={t("فضای کار")}
          >
            <img src={iconUrl()} alt={BRAND.name} className="size-10 rounded-xl" />
          </a>
        )}
        <AgentPicker agent={agent} onChange={(id) => (onAgentChange?.(id), onClose?.())} onAdd={() => go("/agents/new")} className={k ? "min-w-[10rem]" : "min-w-[11rem]"} />
        {navStyleOf(flags) === "launcher" ? <NavLauncher go={go} activeSection={oneList ? sectionOfPage(page) : section} /> : null}
        {onHide ? (
          <button type="button" onClick={onHide} className={k ? "kc-icon-btn ms-auto hidden shrink-0 md:inline-flex" : "ms-auto hidden shrink-0 rounded-lg p-2 text-muted-foreground hover:bg-muted hover:text-foreground md:inline-flex"} aria-label={t("پنهان کردن فهرست گفتگوها")} title={t("پنهان کردن فهرست گفتگوها (Ctrl+B یا ⌘B)")}>
            <PanelRightClose className={k ? undefined : "size-4"} />
          </button>
        ) : null}
        {onClose ? (
          <button type="button" onClick={onClose} className={k ? "kc-icon-btn md:hidden" : "rounded-lg p-2 hover:bg-muted md:hidden"} aria-label={t("بستن")}>
            <X className={k ? undefined : "size-5"} />
          </button>
        ) : null}
      </div>

      {oneList ? (
        <OneList chats={chats} archived={archived} groups={groups} looseAt={looseAt} loading={loading} failed={failed} onRetry={onRetry} onNewChat={onNewChat} activeId={activeId} onClose={onClose} nav={nav} karsara={k} />
      ) : (
        <TabList
          section={section}
          chats={chats}
          archived={archived}
          groups={groups}
          looseAt={looseAt}
          filter={filter}
          onFilter={onFilter}
          loading={loading}
          failed={failed}
          onRetry={onRetry}
          activeId={activeId}
          activePersonId={activePersonId}
          nav={nav}
          startChat={startChat}
          onClose={onClose}
          k={k}
          inboxOn={flags.inboxRow}
        />
      )}

      <HostNotice />
      <TwoStepNotice />
      <UpdateNotice />
      {flags.userMenu ? <UserMenu onNavigate={onClose} /> : <UserBar onNavigate={onClose} k={k} />}
    </aside>
  );
}

// Each tab's own list (the one list off): «گفتگو» is what the owner started by hand; Telegram-born,
// peer, ops-room and job threads live under their tabs.
function TabList({ section, chats, archived, groups, looseAt, loading, failed, onRetry, filter, onFilter, activeId, activePersonId, nav, startChat, onClose, k, inboxOn }) {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useListChoice("sort", "griffin.sidebar.sort", "updated", SORTS);
  const [sectionOrders, setSectionOrder] = useSectionOrder(); // sections dragged into the owner's order (drag.js)
  const seenVersion = useSeenVersion(); // read state re-shapes the list (unread filter, sort, groups)
  // Telegram and peer threads group by whose they are by default, so one person's threads can be
  // folded away while another's stay open. The choice is kept, so the owner's groups stay up.
  const [groupChoice, setGroupChoice] = useState(() => {
    try { return JSON.parse(readSetting("griffin.sidebar.groupBy", "{}")) || {}; } catch { return {}; }
  });
  const defaultGroupBy = section === "telegram" || section === "peer" ? "owner" : "none";
  const groupBy = (GROUPS.some((g) => g.id === groupChoice[section]) && groupChoice[section]) || defaultGroupBy;
  const setGroupBy = (value) => setGroupChoice((g) => {
    const next = { ...g, [section]: value };
    writeSetting("griffin.sidebar.groupBy", JSON.stringify(next));
    api("/api/list-prefs", { method: "PUT", body: { groupBy: value, section } }).catch(() => {});
    return next;
  });
  // The server keeps the grouping so every device shows the same list (from Karsara).
  useEffect(() => {
    api("/api/list-prefs").then((prefs) => {
      if (!prefs?.sections || !Object.keys(prefs.sections).length) return;
      setGroupChoice((g) => {
        const next = { ...g, ...prefs.sections };
        writeSetting("griffin.sidebar.groupBy", JSON.stringify(next));
        return next;
      });
    }, () => {});
  }, []);
  const [collapsed, setCollapsed] = useState(() => {
    try { return JSON.parse(readSetting("griffin.sidebar.collapsed", "{}")) || {}; } catch { return {}; }
  });
  const toggleGroup = (key) => setCollapsed((c) => {
    const next = { ...c, [key]: !c[key] };
    writeSetting("griffin.sidebar.collapsed", JSON.stringify(next));
    return next;
  });
  // «بیشتر» of a section stays open until the owner closes it (owner 2026-10-19): the Section comes and
  // goes with a tab, the group-by choice, Settings and a reload, so what is open is kept here and in
  // storage, per tab, not in the Section itself.
  const [expanded, setExpanded] = useState(() => {
    try { return JSON.parse(readSetting("griffin.sidebar.expanded", "{}")) || {}; } catch { return {}; }
  });
  const toggleMore = (key) => setExpanded((e) => {
    const next = { ...e };
    if (next[key]) delete next[key]; else next[key] = true;
    writeSetting("griffin.sidebar.expanded", JSON.stringify(next));
    return next;
  });
  // A filter lasts this visit only: kept across reloads it hid chats with no sign that it was on. App
  // holds it, so it survives the phone drawer closing and a visit to Settings.
  const setFilter = (value) => onFilter?.(value);
  const [showArchived, setShowArchived] = useState(false);

  // «ردیف صندوق تلگرام»: the inbox chat on its own row above the owner's list.
  const inboxStatus = usePolling(inboxOn && section === "manual" ? "/api/telegram-inbox/status" : null, 15_000);
  const inboxChat = inboxOn && section === "manual" && !showArchived ? inboxRow(inboxStatus) : null;
  const list = useMemo(
    () => (showArchived ? archived : chats).filter((c) => sourceOf(c) === section && c.id !== inboxChat?.chatId),
    [showArchived, archived, chats, section, inboxChat?.chatId],
  );
  const archivedHere = useMemo(() => archived.filter((c) => sourceOf(c) === section), [archived, section]);

  // Words inside messages too, not only titles (from Karsara): the server's full-text index answers
  // a third of a second after the last key; until then (or offline) the titles still match. With
  // CHAT_SEARCH_MESSAGES off the server says so ({ on: false }) and the sidebar stops asking for a
  // minute, so an install that keeps it off sends nothing per keystroke.
  const [bodyHits, setBodyHits] = useState({ q: "", ids: null });
  const searchOffUntil = useRef(0);
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2 || Date.now() < searchOffUntil.current) return undefined;
    let alive = true;
    const timer = setTimeout(() => {
      api(`/api/chats/search?q=${encodeURIComponent(q)}`)
        .then((out) => {
          if (out?.on === false) searchOffUntil.current = Date.now() + 60_000;
          if (alive) setBodyHits({ q, ids: new Set(out?.ids || []) });
        })
        .catch(() => {});
    }, 300);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [query]);
  const prepared = useMemo(() => {
    const items = searchChats(list, query, bodyHits.q === query.trim() ? bodyHits.ids : null);
    // The Telegram tab has no sort/filter controls, so a choice made on another tab must not apply here.
    return sortChats(filterChats(items, section === "telegram" ? "all" : filter, isUnread, { keepId: activeId }), section === "telegram" ? "updated" : sort, isUnread);
  }, [list, query, bodyHits, sort, filter, activeId, section, seenVersion]);

  const sections = useMemo(
    () =>
      groupChats(prepared, groupBy, {
        isUnread,
        agentLabel: (id) => agentMeta(id).label,
        groups,
        looseAt,
        sectionOrder: sectionOrders[groupBy],
        narrowed: Boolean(query.trim()) || filter !== "all" || showArchived,
        scope: section,
      }),
    [prepared, groupBy, groups, looseAt, sectionOrders, query, filter, showArchived, section, seenVersion],
  );

  const open = (id) => {
    navigate(id);
    onClose?.();
  };
  const order = useMemo(() => groupOrder(groups, looseAt), [groups, looseAt]); // drag and drop (drag.js)
  // The ungrouped sections (by repository, …) in the order they show, for dragging their headings.
  const sectionKeys = sections.filter((s) => s.loose).map((s) => s.key);
  const dragOf = (item) =>
    showArchived
      ? { handle: null, slots: [] }
      : sectionDrag(item, { groupBy, groupsOrder: order, hasGroups: section === "manual" && groups.length > 0, sectionKeys, onOrder: (keys) => setSectionOrder(groupBy, keys) });
  const otherThreads = section === "telegram" ? prepared.filter((c) => !c.mother && !c.global) : [];

  return (
    <>
      <div className="px-2">
        <label className="g-sidebar-search flex items-center gap-1 rounded-lg bg-muted py-0.5 pe-0.5 ps-2.5">
          <Search className="size-4 shrink-0 text-muted-foreground" />
          <input
            data-reload-safe=""
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setQuery("");
            }}
            placeholder={t("جستجوی گفتگوها")}
            className="w-full min-w-0 bg-transparent py-1 text-sm outline-none placeholder:text-muted-foreground"
          />
          {query ? (
            <button type="button" className="rounded p-0.5 text-muted-foreground hover:bg-background" aria-label={t("پاک کردن جستجو")} onClick={() => setQuery("")}>
              <X className="size-3.5" />
            </button>
          ) : null}
          {section === "telegram" ? null : <>
            <PaletteKey />
            <SortMenu sort={sort} groupBy={groupBy} defaultGroupBy={defaultGroupBy} onSort={setSort} onGroupBy={setGroupBy} k={k} />
            <FilterMenu filter={filter} onFilter={setFilter} k={k} />
          </>}
        </label>
      </div>

      {/* Only "new" and the search stay fixed; everything else scrolls with the chat list.
          It stays under Telegram too: it is the way back to the owner's own chats. */}
      {nav.top}

      <nav className="scrollbar-thin mt-0.5 min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        <SidebarSuggestions refreshKey={chats} onNavigate={onClose} karsara={k} />
        {nav.sections}

        <div className="my-4 flex items-center justify-center" aria-hidden>
          <span className="size-1 rounded-full bg-border" />
        </div>

        {section === "telegram" ? (
          <>
            <TelegramList query={query} activeId={activeId} activePersonId={activePersonId} onNavigate={onClose} />
            {/* Telegram-born threads that are no person's mother chat (a colleague bot's thread, an old
                thread): the people list above does not show them, so they would be out of reach. */}
            {otherThreads.length ? (
              <div className="mt-3">
                <Section
                  title={t("رشته‌های دیگر")}
                  chats={otherThreads}
                  groups={groups}
                  activeId={activeId}
                  onOpen={open}
                  collapsible
                  collapsed={!collapsed["telegram:others:open"] && !otherThreads.some((c) => c.id === activeId)}
                  onToggle={() => toggleGroup("telegram:others:open")}
                />
              </div>
            ) : null}
          </>
        ) : (
          <>
          <h2 className="truncate px-1 text-start text-xs font-medium text-muted-foreground">
            {showArchived ? t("بایگانی") : SECTIONS[section].label}
          </h2>
          <div className="mt-2" />
          {inboxChat ? <InboxRow row={inboxChat} active={inboxChat.chatId === activeId} onOpen={open} /> : null}
          {filter !== "all" ? (
            <button
              type="button"
              onClick={() => setFilter("all")}
              className="g-filter-chip mb-2 inline-flex max-w-full items-center gap-1 rounded-full bg-muted px-2.5 py-0.5 text-[11px] text-muted-foreground hover:text-foreground"
              title={t("برداشتن فیلتر")}
            >
              <Filter className="size-3 shrink-0" />
              <span className="truncate">{t("فیلتر: {name} ✕", { name: FILTERS.find((f) => f.id === filter)?.label || filter })}</span>
            </button>
          ) : null}
          {sections.map((item) => (
            <Section
              key={item.key || item.title || "recent"}
              title={item.title}
              group={item.groupId ? groups.find((g) => g.id === item.groupId) : null}
              chats={item.chats}
              repo={item.repo}
              groups={groups}
              activeId={activeId}
              onOpen={open}
              dropTarget={showArchived ? null : item.key === "pinned" ? { kind: "pinned" } : item.groupId ? { kind: "group", id: item.groupId } : item.loose ? { kind: "loose" } : null}
              drag={dragOf(item)}
              collapsible={item.collapsible || Boolean(item.title)}
              collapsed={(item.collapsible || Boolean(item.title)) && Boolean(collapsed[item.key])}
              limit={item.title ? SECTION_LIMIT : 0}
              more={Boolean(expanded[`${section}/${item.key}`])}
              onMore={() => toggleMore(`${section}/${item.key}`)}
              onToggle={() => toggleGroup(item.key)}
              onGroupCreated={() => setGroupBy("custom")}
              onNewChat={showArchived ? null : startChat}
            />
          ))}
          {groupBy === "custom" && !showArchived ? (
            <button type="button" onClick={() => newGroup()} className="mt-1 flex w-full items-center gap-2 rounded-lg px-3 py-2 text-xs text-muted-foreground hover:bg-muted">
              <FolderPlus className="size-3.5" />
              {t("گروه جدید")}
            </button>
          ) : null}
          {/* Not «گفتگویی نیست» while the list is still being read: loading and a failed read say so. */}
          <ListStatus loading={loading && !chats.length} failed={failed} onRetry={onRetry} empty={!prepared.length} k={k}>
            <div className="px-3 py-6 text-center text-sm text-muted-foreground">
              <p>{t("گفتگویی نیست.")}</p>
              {filter !== "all" ? (
                <button type="button" onClick={() => setFilter("all")} className="mt-2 rounded-lg px-3 py-1 text-xs text-primary hover:bg-muted">
                  {t("نمایش همه")}
                </button>
              ) : null}
            </div>
          </ListStatus>
          {showArchived && archivedHere.length > 0 ? (
            <button
              type="button"
              onClick={() => deleteAllArchived(archivedHere.map((c) => c.id))}
              className="mt-2 flex w-full items-center gap-2 rounded-lg px-3 py-2 text-xs text-muted-foreground hover:bg-muted"
            >
              <Trash2 className="size-3.5" />
              {t("حذف دائم همه بایگانی ({length})", { length: archivedHere.length })}
            </button>
          ) : null}
          {archivedHere.length > 0 || showArchived ? (
            <button
              type="button"
              onClick={() => setShowArchived(!showArchived)}
              className="mt-2 flex w-full items-center gap-2 rounded-lg px-3 py-2 text-xs text-muted-foreground hover:bg-muted"
            >
              <Archive className="size-3.5" />
              {showArchived ? t("بازگشت") : t("بایگانی ({n})", { n: num(archivedHere.length) })}
            </button>
          ) : null}
          </>
        )}
      </nav>
    </>
  );
}

function SortMenu({ sort, groupBy, defaultGroupBy = "none", onSort, onGroupBy, k: karsara = false }) {
  const [open, setOpen] = useState(false);
  const active = sort !== "updated" || groupBy !== defaultGroupBy;
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          title={t("مرتب‌سازی")}
          aria-label={t("مرتب‌سازی")}
          className={`press flex items-center justify-center rounded-lg ${
            karsara
              ? `size-7 hover:bg-muted ${active ? "text-primary" : "text-muted-foreground hover:text-foreground"}`
              : `size-8 ${active || open ? "bg-primary/12 text-primary" : "text-muted-foreground hover:bg-muted hover:text-foreground"}`
          }`}
        >
          <ArrowUpDown className={karsara ? "size-3.5" : "size-4"} />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="start" sideOffset={6} className="g-menu pop z-50 w-52 overflow-hidden rounded-xl border bg-card p-1 text-sm shadow-xl">
          <p className="px-2.5 py-1.5 text-[11px] font-medium text-muted-foreground">{t("مرتب‌سازی")}</p>
          {SORTS.map((item) => (
            <MenuPick key={item.id} icon={item.id === "title" ? ArrowDownAZ : ArrowUpDown} label={item.label} selected={sort === item.id} onClick={() => { onSort(item.id); setOpen(false); }} />
          ))}
          <div className="my-1 border-t" />
          <p className="flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] font-medium text-muted-foreground">
            <FolderTree className="size-3" /> {t("گروه‌بندی")}
          </p>
          {GROUPS.map((item) => (
            <MenuPick key={item.id} label={item.label} selected={groupBy === item.id} onClick={() => { onGroupBy(item.id); setOpen(false); }} />
          ))}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function FilterMenu({ filter, onFilter, k: karsara = false }) {
  const [open, setOpen] = useState(false);
  const active = filter !== "all";
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          title={t("فیلتر")}
          aria-label={t("فیلتر")}
          className={`press flex items-center justify-center rounded-lg ${
            karsara
              ? `size-7 hover:bg-muted ${active ? "text-primary" : "text-muted-foreground hover:text-foreground"}`
              : `size-8 ${active || open ? "bg-primary/12 text-primary" : "text-muted-foreground hover:bg-muted hover:text-foreground"}`
          }`}
        >
          <Filter className={karsara ? "size-3.5" : "size-4"} />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="start" sideOffset={6} className="g-menu pop z-50 w-44 overflow-hidden rounded-xl border bg-card p-1 text-sm shadow-xl">
          {FILTERS.map((item) => (
            <MenuPick key={item.id} label={item.label} selected={filter === item.id} onClick={() => { onFilter(item.id); setOpen(false); }} />
          ))}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function MenuPick({ icon: Icon, label, selected, onClick }) {
  return (
    <button type="button" onClick={onClick} className="g-menu-row flex w-full items-center gap-2 rounded-lg px-2.5 py-2 hover:bg-muted">
      {Icon ? <Icon className="size-3.5 text-muted-foreground" /> : null}
      <span className="flex-1 text-start">{label}</span>
      {selected ? <Check className="size-3.5 text-primary" /> : null}
    </button>
  );
}

// The bottom of the sidebar (owner, 2026-10-14: «منوی پایین رو حذف کن همه چی بره تو تنظیمات، آیکون
// تنظیمات بمونه فقط و خروج», then «چرا پروفایل رفت؟»): his name and photo (opens Settings → حساب), the
// Settings icon and log out; agents, token usage and the rest live in Settings.
function UserBar({ onNavigate, k: karsara = false }) {
  const updateDot = useUpdateDot(); // «آپدیت فقط در تنظیمات»: a new release waits there
  // Something to connect (no engine with a working key): marked here, so it is seen without opening Settings.
  const [setupMissing, setSetupMissing] = useState(false);
  useEffect(() => {
    let live = true;
    api("/api/setup").then((r) => live && setSetupMissing(Boolean(r?.needsEngine)), () => {});
    return () => {
      live = false;
    };
  }, []);
  // The owner's name and photo (profile.js). The server waits up to 3 s for a Telegram photo on its
  // way, so a first answer with Telegram's name and no photo is asked once more a little later;
  // asked again now and then so a later Telegram connection shows up.
  const [profile, setProfile] = useState(null);
  const [photoFailed, setPhotoFailed] = useState(false);
  useEffect(() => {
    let live = true;
    let timer = null;
    const ask = (again) =>
      api("/api/profile").then(
        (p) => {
          if (!live) return;
          setProfile(p);
          setPhotoFailed(false);
          if (again && p.telegramName && !p.photo) timer = setTimeout(() => ask(false), 8_000);
        },
        () => live && again && (timer = setTimeout(() => ask(false), 8_000)),
      );
    ask(true);
    const every = setInterval(() => ask(false), 15 * 60_000);
    return () => {
      live = false;
      clearTimeout(timer);
      clearInterval(every);
    };
  }, []);
  useEffect(() => {
    const onChange = (event) => (setProfile(event.detail), setPhotoFailed(false));
    window.addEventListener(PROFILE_EVENT, onChange);
    return () => window.removeEventListener(PROFILE_EVENT, onChange);
  }, []);
  const owner = ownerView(photoFailed ? { ...profile, photo: null } : profile);
  // A photo changed in Telegram retires its old address: ask once for the new one before giving up.
  const photoRetried = useRef(null);
  const onPhotoError = () => {
    if (photoRetried.current === profile?.photo) return setPhotoFailed(true);
    photoRetried.current = profile?.photo;
    api("/api/profile").then((p) => (p.photo && p.photo !== profile?.photo ? setProfile(p) : setPhotoFailed(true)), () => setPhotoFailed(true));
  };
  const openSettings = (section = null) => {
    if (section) writeSetting("griffin.settings.section", section);
    window.location.hash = "/settings";
    onNavigate?.();
  };
  const [menu, setMenu] = useState(false);
  const button = "press relative flex size-11 shrink-0 items-center justify-center rounded-xl text-muted-foreground hover:bg-muted hover:text-foreground";

  return (
    <div className="flex items-center gap-1 border-t px-2 py-2 pb-[max(env(safe-area-inset-bottom),0.5rem)]">
      {/* The profile opens its own menu (owner 2026-10-18: profile and settings went to one place). */}
      <Popover.Root open={menu} onOpenChange={setMenu}>
        <Popover.Trigger asChild>
          <button
            type="button"
            className={`g-user-bar press flex min-w-0 flex-1 items-center text-start hover:bg-muted data-[state=open]:bg-muted ${karsara ? "min-h-11 gap-2 rounded-md px-2" : "gap-2.5 rounded-xl bg-muted/50 px-2 py-1.5"}`}
            title={t("پروفایل")}
            aria-label={t("منوی پروفایل")}
          >
            <img
              src={owner.photo}
              alt=""
              className={`${karsara ? "size-6" : "size-9"} shrink-0 rounded-full ${owner.isPhoto ? "object-cover" : ""}`}
              onError={owner.isPhoto ? onPhotoError : undefined}
            />
            <span className={`min-w-0 flex-1 truncate text-sm ${karsara ? "" : "font-medium"}`} dir="auto">{owner.name}</span>
          </button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content side="top" align="start" sideOffset={8} collisionPadding={8} className="g-menu pop z-50 w-56 overflow-hidden rounded-xl border bg-card p-1 text-sm shadow-lg" dir={isRtl ? "rtl" : "ltr"}>
            {/* «جای بخش‌ها: منوی کاربر»: the sections first (SectionNav.jsx); nothing otherwise. */}
            <SectionMenuItems onPick={() => { setMenu(false); onNavigate?.(); }} rowClass="press flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-start hover:bg-muted" />
            {PROFILE_ITEMS.map(({ id, icon: Icon, label, rule }) => (
              <div key={id}>
                {rule ? <div className="my-1 border-t" /> : null}
                <button type="button" className="press flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-start hover:bg-muted" onClick={() => { setMenu(false); profileAction(id, { editProfile: () => openSettings("account") }); }}>
                  <Icon className={`size-4 text-muted-foreground ${id === "logout" ? "-scale-x-100" : ""}`} />
                  <span>{label}</span>
                </button>
              </div>
            ))}
            <SectionMenuFoot />
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
      <button type="button" onClick={() => openSettings(updateDot ? "health" : undefined)} className={button} title={updateDot ? t("تنظیمات · نسخهٔ تازه آماده است") : t("تنظیمات")} aria-label={t("تنظیمات")}>
        <Settings2 className="size-4" />
        {updateDot && !setupMissing ? <span className="absolute end-2 top-2 size-2 rounded-full bg-primary" role="img" aria-label={t("نسخهٔ تازه آماده است")} /> : null}
        {setupMissing ? <span className="absolute end-2 top-2 size-2 rounded-full bg-warn" role="img" aria-label={t("اتصالی ناقص است")} title={t("اتصالی ناقص است")} /> : null}
      </button>
      <FeedbackBarButton className={button} />
    </div>
  );
}

// A real link: middle-click, Ctrl+click and «Open in new tab» open the page in another tab; a
// plain click stays in this one. Under the Karsara skin a flat list row (g-nav-row).
// The top sections, as the owner set them in Settings → ظاهر (sidebar-nav.js): rows, or one row of
// icons; hidden ones under «بیشتر», and shown anyway while one of them is the open page.

function SidebarNav({ section, go, k: karsara = false, flags }) {
  const [more, setMore] = useState(false);
  // Every section that is on, in the order the owner dragged them into (SectionNav.jsx).
  const { items, ids, hidden, moduleSection, reorder } = useSections();
  const activeSection = moduleSection || section;
  const style = navStyleOf(flags);
  const shown = items.filter((item) => !hidden.includes(item.id) || activeSection === item.section);
  const rest = items.filter((item) => !shown.includes(item));
  const icons = flags.navIcons;
  // «جای بخش‌ها» (Settings → ظاهر): the launcher keeps only the pinned rows here (its grid is in the
  // header), the menu none (the user menu and Ctrl+K have them), the rail none on a computer (the rows
  // stay on a phone, where there is no rail).
  if (style === "menu") return null;
  if (style === "launcher") {
    const pinned = items.filter((item) => !hidden.includes(item.id));
    return pinned.length ? (
      <div className="space-y-0.5">
        {pinned.map((item) => (
          <NavSlot key={item.id} id={item.id} ids={ids} onOrder={reorder}>
            <PinnedRow item={item} active={activeSection === item.section} onGo={go} onUnpin={(id) => setUiPrefs({ flags: { navHidden: [...hidden, id] } })} />
          </NavSlot>
        ))}
      </div>
    ) : null;
  }
  if (style === "rail") {
    return (
      <div className={`md:hidden ${karsara ? "" : "space-y-0.5"}`}>
        {items.map(({ id, label, icon, path, section: target }) => (
          <NavButton key={id} active={activeSection === target} icon={icon} href={`#${path}`} label={label} onClick={() => go(path)} k={karsara} />
        ))}
      </div>
    );
  }
  const openSettings = () => {
    setMore(false);
    writeSetting("griffin.settings.section", "market");
    go("/settings");
  };
  // Always in sight, so a module that is off (the MR list …) can be found without knowing «بیشتر» exists.
  const storeLink = icons ? (
    <button type="button" data-tip={t("بازارچه · بخش‌های بیشتر")} aria-label={t("بازارچه: بخش‌های بیشتر")} onClick={openSettings} className="g-icon-btn g-sn-tip g-sn-tip-below flex size-9 items-center justify-center rounded-lg text-muted-foreground opacity-60 hover:bg-muted hover:text-foreground hover:opacity-100">
      <Store className="size-4" />
    </button>
  ) : (
    <NavButton active={false} icon={Store} href="#/settings" label={t("بازارچه · بخش‌های بیشتر")} onClick={openSettings} k={karsara} />
  );
  // «ردیف «بیشتر»» off: hidden sections are not offered at all (Karsara's list).
  const moreMenu = flags.navMore && (rest.length || icons) ? (
    <Popover.Root open={more} onOpenChange={setMore}>
      <Popover.Trigger asChild>
        <button
          type="button"
          title={t("بخش‌های دیگر")}
          aria-label={t("بخش‌های دیگر")}
          className={
            icons
              ? "g-icon-btn flex size-9 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground data-[state=open]:bg-muted"
              : karsara
                ? "kc-list-row w-full justify-start"
                : "g-nav-row flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-muted-foreground hover:bg-muted/70 hover:text-foreground data-[state=open]:bg-muted"
          }
        >
          <MoreHorizontal className="size-4 shrink-0" />
          {icons ? null : <span>{t("بیشتر")}</span>}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content side="bottom" align="start" sideOffset={6} collisionPadding={12} className="g-menu pop z-50 w-56 rounded-xl border bg-card p-1 text-sm shadow-xl">
          {rest.map(({ id, label, icon: Icon, path }) => (
            <button
              key={id}
              type="button"
              onClick={() => {
                setMore(false);
                go(path);
              }}
              className="g-menu-row flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-start hover:bg-muted"
            >
              <Icon className="size-4 shrink-0 text-muted-foreground" />
              {label}
            </button>
          ))}
          {rest.length ? <div className="my-1 h-px bg-border" /> : null}
          <button type="button" onClick={openSettings} className="g-menu-row flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-start text-xs text-muted-foreground hover:bg-muted hover:text-foreground">
            <Store className="size-3.5 shrink-0" />
            {t("بازارچه: بخش‌ها و منو…")}
          </button>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  ) : null;

  if (icons) {
    return (
      <div className="flex flex-wrap items-center gap-1 px-1">
        {shown.map(({ id, label, icon: Icon, path, section: target }) => (
          <NavSlot key={id} id={id} ids={ids} onOrder={reorder} horizontal>
          <a
            href={`#${path}`}
            data-tip={label}
            aria-label={label}
            aria-current={activeSection === target ? "page" : undefined}
            onClick={(event) => {
              if (!isPlainClick(event)) return;
              event.preventDefault();
              go(path);
            }}
            className={`g-icon-btn g-sn-tip g-sn-tip-below flex size-9 items-center justify-center rounded-lg transition-colors ${activeSection === target ? "bg-primary/12 text-primary" : "text-muted-foreground hover:bg-muted hover:text-foreground"}`}
          >
            <Icon className="size-4" />
          </a>
          </NavSlot>
        ))}
        {moreMenu}
        <span className="mx-1 h-[18px] w-px bg-border" aria-hidden />
        {storeLink}
      </div>
    );
  }
  return (
    <div className={karsara ? undefined : "space-y-0.5"}>
      {shown.map(({ id, label, icon, path, section: target }) => (
        <NavSlot key={id} id={id} ids={ids} onOrder={reorder}>
          <NavButton active={activeSection === target} icon={icon} href={`#${path}`} label={label} onClick={() => go(path)} k={karsara} />
        </NavSlot>
      ))}
      {moreMenu}
      {storeLink}
    </div>
  );
}

function NavButton({ active, icon: Icon, href, label, onClick, k = false, badge = 0 }) {
  return (
    <a
      href={href}
      onClick={(event) => {
        if (!isPlainClick(event)) return;
        event.preventDefault();
        onClick();
      }}
      aria-current={active ? "page" : undefined}
      className={k ? "kc-list-row w-full justify-start" : `g-nav-row flex w-full items-center justify-start gap-2.5 rounded-lg px-3 py-2 text-sm font-medium ${active ? "bg-primary/12 text-primary" : "text-foreground/80 hover:bg-muted/70 hover:text-foreground"}`}
    >
      <Icon className={k ? "size-4 shrink-0 kc-muted" : "size-4 shrink-0"} />
      <span>{label}</span>
      {badge > 0 ? (
        <span className="g-badge ms-auto rounded-full bg-warn px-1.5 text-[10px] leading-4 text-background" aria-label={t("{n} مورد منتظر شما", { n: num(badge) })}>{num(badge)}</span>
      ) : null}
    </a>
  );
}

// The owner's groups: created from the list or from a chat's «انتقال به گروه», renamed and deleted
// from the group's heading. Deleting a group never touches its chats; they become ungrouped.
async function newGroup() {
  const name = window.prompt(t("نام گروه جدید"))?.trim();
  if (!name) return null;
  const { group } = await api("/api/groups", { method: "POST", body: { name } }).catch(groupFailed);
  return group || null;
}
const groupFailed = () => {
  toast.error(t("کار روی گروه انجام نشد؛ دوباره امتحان کنید."));
  return {};
};

// A titled section shows its first few chats and «بیشتر» for the rest (owner 2026-10-16); the open
// chat always shows. Folding the whole section is its title's chevron.
const SECTION_LIMIT = 5;

function Section({ title, group = null, repo = null, chats, groups, activeId, onOpen, dropTarget = null, drag = null, collapsible = false, collapsed = false, onToggle, onGroupCreated, onNewChat, limit = 0, more = false, onMore }) {
  const [menu, setMenu] = useState(false);
  const drop = useSectionDrop({ target: dropTarget, slots: drag?.slots || [] });
  const handle = drag?.handle ? groupDragProps(drag.handle.id, drag.handle.scope) : {};
  // Folded, the open chat alone stays in sight (owner 2026-10-17: the folder holding the open chat
  // would not fold at all).
  const shown = collapsed
    ? chats.filter((chat) => chat.id === activeId)
    : limit && !more ? chats.filter((chat, i) => i < limit || chat.id === activeId) : chats;
  // An empty group of the owner's still shows (a new one must show up to be used).
  if (!chats.length && !group) return null;
  const rename = () => {
    setMenu(false);
    const name = window.prompt(t("نام گروه"), group.name)?.trim();
    if (name && name !== group.name) api(`/api/groups/${group.id}`, { method: "PATCH", body: { name } }).catch(groupFailed);
  };
  const remove = () => {
    setMenu(false);
    if (window.confirm(t("گروه «{name}» حذف شود؟ گفتگوهایش سر جایشان می‌مانند و فقط بی‌گروه می‌شوند.", { name: group.name }))) {
      api(`/api/groups/${group.id}`, { method: "DELETE" }).catch(groupFailed);
    }
  };
  return (
    <div className="g-drop mb-2 rounded-lg" {...drop}>
      {collapsible ? (
        <div className="group relative flex items-center" {...handle} title={drag?.handle ? t("برای جابه‌جایی بکشید") : undefined}>
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={!collapsed}
            className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-3 pb-1 pt-2 text-[11px] font-medium text-muted-foreground hover:text-foreground"
          >
            <ChevronDown className={`size-3 shrink-0 transition-transform ${collapsed ? "-rotate-90 rtl:rotate-90" : ""}`} />
            <span className="min-w-0 truncate text-start" dir="auto">{title}</span>
            {/* The count right after the title, in Persian digits: «griffin-private (۳۹)» (owner 2026-10-19). */}
            <span className="shrink-0 tabular-nums">({chats.length.toLocaleString("fa-IR")})</span>
            <span className="flex-1" />
          </button>
          {group && onNewChat ? (
            <button
              type="button"
              onClick={() => onNewChat(group.id)}
              data-no-drag=""
              className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground md:opacity-0 md:focus-visible:opacity-100 md:group-hover:opacity-100"
              title={t("گفتگوی جدید در «{name}»", { name: group.name })}
              aria-label={t("گفتگوی جدید در گروه {name}", { name: group.name })}
            >
              <Plus className="size-3.5" />
            </button>
          ) : null}
          {repo && onNewChat ? <RepoNewChat repo={repo} onNewChat={onNewChat} className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground" /> : null}
          {group ? (
            <button
              type="button"
              onClick={() => setMenu(!menu)}
              data-no-drag=""
              className="me-1 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground md:opacity-0 md:focus-visible:opacity-100 md:group-hover:opacity-100"
              aria-label={t("گزینه‌های گروه {name}", { name: group.name })}
            >
              <MoreHorizontal className="size-3.5" />
            </button>
          ) : null}
          {menu ? (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setMenu(false)} />
              <div className="g-menu absolute end-2 top-8 z-20 w-44 overflow-hidden rounded-lg border bg-card text-sm shadow-lg">
                <ChatMenuItem icon={Pencil} onClick={rename}>{t("تغییر نام گروه")}</ChatMenuItem>
                <ChatMenuItem icon={Trash2} onClick={remove}>{t("حذف گروه")}</ChatMenuItem>
              </div>
            </>
          ) : null}
        </div>
      ) : title ? <p className="px-3 pb-1 pt-2 text-[11px] font-medium text-muted-foreground">{title}</p> : <div className="pt-1" />}
      {collapsed && !shown.length ? null : <ul>
        {shown.map((chat) => (
          <ChatItem key={chat.id} chat={chat} active={chat.id === activeId} onOpen={onOpen} groups={groups} onGroupCreated={onGroupCreated} />
        ))}
        {limit && !collapsed && chats.length > limit ? (
          <li>
            <button type="button" onClick={onMore} className="flex w-full items-center gap-1.5 rounded-md px-3 py-1 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground">
              <ChevronDown className={`size-3 transition-transform ${more ? "rotate-180" : ""}`} />
              {more ? t("کمتر") : t("بیشتر ({toLocaleString})", { toLocaleString: (chats.length - shown.length).toLocaleString("fa-IR") })}
            </button>
          </li>
        ) : null}
      </ul>}
    </div>
  );
}

function ChatItem({ chat, active, onOpen, groups = [], onGroupCreated }) {
  const timeAgo = useFlag("timeAgo");
  const logos = useFlag("agentLogos"); // «لوگوی ایجنت‌ها کنار هر گفتگو» (ui-prefs.js)
  const [menu, setMenu] = useState(false);
  const [moving, setMoving] = useState(false); // the menu shows the group list instead
  const closeMenu = () => {
    setMenu(false);
    setMoving(false);
  };
  useSeenVersion(); // a markSeen elsewhere (opening this chat) clears the badge live
  const unread = isUnread(chat);
  const state = chatState(chat, isUnread);
  const agents = chatAgents(chat);
  const patch = (body) => api(`/api/chats/${chat.id}`, { method: "PATCH", body }).catch(() => {});
  const moveTo = (groupId) => {
    closeMenu();
    if (groupId !== (chat.groupId || null)) patch({ groupId });
  };
  const moveToNew = async () => {
    closeMenu();
    const group = await newGroup();
    if (!group) return;
    await patch({ groupId: group.id });
    onGroupCreated?.();
  };
  const rename = () => {
    closeMenu();
    const title = window.prompt(t("عنوان جدید"), chat.title);
    if (title?.trim()) patch({ title });
  };
  return (
    <li className="relative">
      <div
        className={`g-chat-row group relative flex items-center rounded-lg ${active ? "bg-muted" : "hover:bg-muted/60"}`}
        data-active={active ? "true" : undefined}
        {...chatDragProps(chat)}
        onContextMenu={(event) => {
          // Right click = the «گزینه‌ها» menu. Shift+right click keeps the browser's own menu.
          if (event.shiftKey) return;
          event.preventDefault();
          setMenu(true);
        }}
      >
        {/* A real link: middle-click, Ctrl+click and the browser's «Open in new tab» work. */}
        <a
          href={`#/c/${chat.id}`}
          onClick={(event) => {
            if (!isPlainClick(event)) return;
            event.preventDefault();
            markSeen(chat.id, chat.updatedAt); // also the open chat, after «علامت خوانده‌نشده»
            onOpen(chat.id);
          }}
          className="flex min-w-0 flex-1 items-center gap-2 px-3 py-2 text-start text-sm"
        >
          {logos ? <ChatAgentGlyphs agents={agents} /> : null}
          <span className={`min-w-0 flex-1 truncate ${unread ? "font-semibold text-foreground" : ""}`} dir={textDir(chat.title)}>
            {chat.title}
          </span>
          {state.id === "ask" ? (
            <span className="shrink-0" title={state.label}><CircleHelp className="size-3.5 text-warn" aria-label={state.label} /></span>
          ) : state.id === "running" ? (
            <span className="agent-dots shrink-0 text-signal" aria-hidden><i /><i /><i /></span>
          ) : state.failed ? (
            <span className="size-1.5 shrink-0 rounded-full bg-bad" title={t("خطادار")} />
          ) : null}
          {chat.reminderAt ? <span className="shrink-0" title={reminderLabel(chat.reminderAt)}><BellRing className="size-3.5 text-muted-foreground" aria-label={reminderLabel(chat.reminderAt)} /></span> : null}
          {unread ? <span className="size-2 shrink-0 rounded-full bg-signal ring-2 ring-signal/25" title={t("محتوای دیده‌نشده")} /> : null}
          <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground md:group-focus-within:invisible md:group-hover:invisible" title={exactTime(chat.updatedAt || chat.createdAt)}>
            {timeAgo ? shortAgo(chat.updatedAt || chat.createdAt) : ago(chat.updatedAt || chat.createdAt)}
          </span>
        </a>
        <button
          type="button"
          onClick={() => (menu ? closeMenu() : setMenu(true))}
          data-no-drag=""
          className="me-1 rounded p-1 text-muted-foreground opacity-100 hover:bg-background md:absolute md:end-2 md:top-1/2 md:me-0 md:-translate-y-1/2 md:opacity-0 md:focus-visible:opacity-100 md:group-hover:opacity-100"
          aria-label={t("گزینه‌ها")}
        >
          <MoreHorizontal className="size-4" />
        </button>
      </div>
      {menu ? (
        <>
          <div
            className="fixed inset-0 z-10"
            onClick={closeMenu}
            onContextMenu={(event) => {
              event.preventDefault();
              closeMenu();
            }}
          />
          {moving ? (
            <div className="g-menu scrollbar-thin absolute end-2 top-9 z-20 max-h-80 w-56 overflow-y-auto rounded-lg border bg-card text-sm shadow-lg">
              <ChatMenuItem icon={ChevronRight} onClick={() => setMoving(false)}>{t("انتقال به گروه")}</ChatMenuItem>
              <div className="my-1 border-t" />
              {groups.map((g) => (
                <button key={g.id} type="button" onClick={() => moveTo(g.id)} className="g-menu-row flex w-full items-center gap-2 px-3 py-2 hover:bg-muted">
                  <span className="min-w-0 flex-1 truncate text-start" dir="auto">{g.name}</span>
                  {chat.groupId === g.id ? <Check className="size-3.5 text-primary" /> : null}
                </button>
              ))}
              {groups.length ? <div className="my-1 border-t" /> : null}
              <button type="button" onClick={() => moveTo(null)} className="g-menu-row flex w-full items-center gap-2 px-3 py-2 hover:bg-muted">
                <span className="flex-1 text-start">{t("بدون گروه")}</span>
                {!groups.some((g) => g.id === chat.groupId) ? <Check className="size-3.5 text-primary" /> : null}
              </button>
              <ChatMenuItem icon={FolderPlus} onClick={moveToNew}>{t("گروه جدید…")}</ChatMenuItem>
            </div>
          ) : (
          <div className="g-menu absolute end-2 top-9 z-20 w-48 overflow-hidden rounded-lg border bg-card text-sm shadow-lg">
            {/* A chat that ended in an error: send it again, call it done, or close it (archive, below). */}
            {state.failed || chat.kept?.length ? (
              <>
                <ChatMenuItem icon={RotateCcw} onClick={() => { closeMenu(); api(`/api/chats/${chat.id}/retry`, { method: "POST" }).catch(failed); }}>
                  {t("دوباره")}
                </ChatMenuItem>
                <ChatMenuItem icon={Check} onClick={() => { closeMenu(); api(`/api/chats/${chat.id}/resolve`, { method: "POST" }).then(() => toast.success(t("حل شد")), failed); }}>
                  {t("حل شد")}
                </ChatMenuItem>
                <div className="my-1 border-t" />
              </>
            ) : null}
            <ChatMenuItem icon={chat.pinned ? PinOff : Pin} onClick={() => { closeMenu(); patch({ pinned: !chat.pinned }); }}>
              {chat.pinned ? t("برداشتن سنجاق") : t("سنجاق")}
            </ChatMenuItem>
            <ChatMenuItem icon={Pencil} onClick={rename}>{t("تغییر نام")}</ChatMenuItem>
            {chat.runStatus === "running" ? null : (
              <ChatMenuItem
                icon={unread ? MailOpen : Mail}
                onClick={() => {
                  closeMenu();
                  if (unread) markSeen(chat.id, chat.updatedAt);
                  else markUnread(chat.id);
                }}
              >
                {unread ? t("علامت خوانده‌شده") : t("علامت خوانده‌نشده")}
              </ChatMenuItem>
            )}
            <ChatMenuItem icon={chat.archived ? ArchiveRestore : Archive} onClick={() => { closeMenu(); patch({ archived: !chat.archived }); }}>
              {chat.archived ? t("خروج از بایگانی") : t("بایگانی")}
            </ChatMenuItem>
            {chat.archived ? <ChatMenuItem icon={Trash2} onClick={() => { closeMenu(); deleteForGood(chat); }}>{t("حذف دائم")}</ChatMenuItem> : null}
            <ChatMenuItem icon={ExternalLink} onClick={() => { closeMenu(); window.open(`#/c/${chat.id}`, "_blank", "noopener"); }}>
              {t("باز کردن در تب جدید")}
            </ChatMenuItem>
            <ChatMenuItem icon={FolderInput} onClick={() => setMoving(true)}>{t("انتقال به گروه")}</ChatMenuItem>
            {/* Where this chat's full Claude Code runs (config CLAUDE_HOST; owner 2026-10-16: «per chat بشه دسترسی رو مشخص کرد»). */}
            {chat.runsOn ? (
              <>
                <div className="my-1 border-t" />
                <div className="px-3 pb-1 pt-1.5 text-[11px] text-muted-foreground">{t("ترمینال این گفتگو")}</div>
                {/* «بدون پرسیدن» always runs as the owner's own user (host-spawn.mjs runsOnHost). */}
                {chat.runsOn.bypass ? (
                  <div className="flex items-start gap-2 px-3 py-2 text-xs text-muted-foreground">
                    <Server className="mt-0.5 size-3.5 shrink-0" />
                    <span>{t("در حالت «خودکار» و «بدون پرسیدن» با کاربر خود شما روی سرور اجرا می‌شود")}</span>
                  </div>
                ) : RUNS_ON.map(([id, label, Icon]) => (
                  <button key={id} type="button" onClick={() => { closeMenu(); patch({ runsOn: id === chat.runsOn.default ? null : id }); }} className="g-menu-row flex w-full items-center gap-2 px-3 py-2 hover:bg-muted">
                    <Icon className="size-3.5 text-muted-foreground" />
                    <span className="flex-1 text-start">{label}{!chat.runsOn.chosen && id === chat.runsOn.default ? t(" (پیش‌فرض)") : ""}</span>
                    {(chat.runsOn.chosen || chat.runsOn.default) === id ? <Check className="size-3.5 text-primary" /> : null}
                  </button>
                ))}
              </>
            ) : null}
          </div>
          )}
        </>
      ) : null}
    </li>
  );
}

// host = on the server as the owner (his ssh keys, kubectl, git); container = inside Griffin, without them.
const RUNS_ON = [["host", t("روی سرور، با دسترسی کامل شما"), Server], ["container", t("داخل کانتینر، بدون کلیدهای شما"), Box]];
// Permanent delete of archived chats (owner 2026-10-20): one chat from its menu, or the whole archive.
function deleteForGood(chat) {
  if (!window.confirm(t("گفتگوی «{title}» برای همیشه حذف شود؟ برگشتی ندارد.", { title: chat.title }))) return;
  api(`/api/chats/${chat.id}`, { method: "DELETE" }).then(() => toast.success(t("حذف شد")), failed);
}
function deleteAllArchived(ids) {
  if (!window.confirm(t("همه {length} گفتگوی بایگانی برای همیشه حذف شوند؟ برگشتی ندارد.", { length: ids.length }))) return;
  api("/api/chats/delete-archived", { method: "POST", body: { ids } }).then(
    (r) => toast.success(r.skipped?.length ? t("{length} حذف شد؛ {length2} در حال کار بود", { length: r.deleted.length, length2: r.skipped.length }) : t("{length} حذف شد", { length: r.deleted.length })),
    failed,
  );
}

const failed = (error) => toast.error(error?.status === 409 ? t("هنوز در حال کار است") : error?.message || t("انجام نشد"));

// «ردیف صندوق تلگرام» (flag inboxRow): above the owner's list while the install's DM mode is "inbox".
function InboxRow({ row, active, onOpen }) {
  return (
    <div className="mb-1 flex min-w-0 items-center gap-1">
    <a
      href={`#/c/${row.chatId}`}
      onClick={(event) => {
        if (!isPlainClick(event)) return;
        event.preventDefault();
        onOpen(row.chatId);
      }}
      data-active={active ? "true" : undefined}
      className={`g-chat-row flex min-w-0 flex-1 items-center gap-2 rounded-lg px-3 py-2 text-sm ${active ? "bg-muted" : "hover:bg-muted/60"}`}
    >
      <Inbox className="size-4 shrink-0 text-sky-500" />
      <span className="ltr min-w-0 flex-1 truncate text-start">{row.title}</span>
      {row.badge ? <span className="shrink-0 rounded-full bg-signal px-1.5 py-0.5 text-[11px] font-medium leading-none text-signal-foreground" aria-label={t("{badge} در صف", { badge: row.badge })}>{row.badge}</span> : null}
    </a>
      {/* The same inbox by sender, as Telegram lists it (InboxPeople.jsx). */}
      <a href={peoplePath()} title={t("به تفکیک فرستنده")} aria-label={t("به تفکیک فرستنده")} className="press flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground">
        <Users className="size-4" />
      </a>
    </div>
  );
}

function chatAgents(chat) {
  if (Array.isArray(chat.agents) && chat.agents.length) return chat.agents;
  const id = chat.agent || chat.agent_id || "griffin";
  return id ? [id] : [];
}

function ChatAgentGlyphs({ agents }) {
  if (!agents.length) return null;
  const shown = agents.slice(0, 4);
  const labels = shown.map((id) => agentMeta(id).label).join(t("، "));
  if (shown.length === 1) {
    return (
      <span className="shrink-0" title={labels}>
        <AgentGlyph id={shown[0]} className="size-4 opacity-90" />
      </span>
    );
  }
  return (
    <span className="flex shrink-0 items-center -space-x-1.5 rtl:space-x-reverse" title={labels}>
      {shown.map((id) => (
        <AgentGlyph key={id} id={id} className="size-3.5 ring-1 ring-card" />
      ))}
    </span>
  );
}

function ChatMenuItem({ icon: Icon, children, onClick }) {
  return (
    <button type="button" onClick={onClick} className="g-menu-row flex w-full items-center gap-2 px-3 py-2 hover:bg-muted">
      <Icon className="size-4 text-muted-foreground" />
      {children}
    </button>
  );
}
