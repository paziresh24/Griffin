import { useEffect, useMemo, useRef, useState } from "react";
import { Popover } from "radix-ui";
import {
  AlarmClock, Radar, TerminalSquare, Archive, ArchiveRestore, ArrowDownAZ, ArrowUpDown, Bot, Check, ChevronDown, ChevronRight, ChevronUp,
  CircleHelp, Coins, ExternalLink, Filter, FolderInput, FolderPlus, FolderTree, LogOut, Mail, MailOpen, MessageCircle, MoreHorizontal, Pencil, Pin, PinOff, Plus, RotateCcw, Search,
  Settings2, Trash2, Users, X,
} from "lucide-react";
import { toast } from "sonner";
import { api, navigate } from "../api.js";
import { BRAND, agentMeta, readSetting, writeSetting } from "../brand.js";
import { textDir } from "../dir.js";
import { num, t } from "../i18n.js";
import { FILTERS, GROUPS, SORTS, ago, chatState, filterChats, groupChats, sortChats } from "../chat-list.js";
import { isUnreadChat, markSeen, markUnread, seenOf, useSeenVersion } from "../seen.js";
import { isPlainClick } from "../sidebar-width.js";
import { NAV_ITEMS, useNavPrefs } from "../sidebar-nav.js";
import { useSkin } from "../skin.js";
import { PROFILE_EVENT, ownerView } from "../profile.js";
import { AgentGlyph, AgentPicker } from "./Controls.jsx";
import { TelegramList } from "./Telegram.jsx";
import { SidebarNotes } from "./Notes.jsx";
import { UsageBadge } from "./Usage.jsx";
import { SidebarSuggestions } from "./ChatTools.jsx";
import { useInbox } from "../inbox.js";
import { exactTime } from "../elapsed.js";

const isUnread = (chat) => isUnreadChat(chat, seenOf(chat.id));

// A list choice kept across reloads; a stored value that is no longer offered falls back.
function useStored(key, initial, allowed) {
  const [value, setValue] = useState(() => {
    const saved = readSetting(key, initial);
    return allowed.some((item) => item.id === saved) ? saved : initial;
  });
  const set = (next) => {
    setValue(next);
    writeSetting(key, next);
  };
  return [value, set];
}

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

export function Sidebar({ chats, archived, groups = [], filter = "all", onFilter, onNewChat = null, activeId, activeSource = null, activePersonId = null, page = null, agent, onAgentChange, agentLocked = false, onClose }) {
  const section = sectionOfPage(page) || (!page && activeSource && SECTIONS[activeSource] ? activeSource : "manual");
  const karsara = useSkin() === "karsara";
  const inbox = useInbox(); // «جدید» counts what waits for the owner (the home-page board)
  const [query, setQuery] = useState("");
  const [sort, setSort] = useStored("griffin.sidebar.sort", "updated", SORTS);
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
    return next;
  });
  const [collapsed, setCollapsed] = useState(() => {
    try { return JSON.parse(readSetting("griffin.sidebar.collapsed", "{}")) || {}; } catch { return {}; }
  });
  const toggleGroup = (key) => setCollapsed((c) => {
    const next = { ...c, [key]: !c[key] };
    writeSetting("griffin.sidebar.collapsed", JSON.stringify(next));
    return next;
  });
  // A filter lasts this visit only: kept across reloads it hid chats with no sign that it was on. App
  // holds it, so it survives the phone drawer closing and a visit to Settings.
  const setFilter = (value) => onFilter?.(value);
  const [showArchived, setShowArchived] = useState(false);

  const list = useMemo(
    () => (showArchived ? archived : chats).filter((c) => sourceOf(c) === section),
    [showArchived, archived, chats, section],
  );
  const archivedHere = useMemo(() => archived.filter((c) => sourceOf(c) === section), [archived, section]);

  const prepared = useMemo(() => {
    const q = query.trim().toLowerCase();
    const items = q ? list.filter((c) => c.title.toLowerCase().includes(q)) : list;
    // The Telegram tab has no sort/filter controls, so a choice made on another tab must not apply here.
    return sortChats(filterChats(items, section === "telegram" ? "all" : filter, isUnread, { keepId: activeId }), section === "telegram" ? "updated" : sort, isUnread);
  }, [list, query, sort, filter, activeId, section, seenVersion]);

  const sections = useMemo(
    () =>
      groupChats(prepared, groupBy, {
        isUnread,
        agentLabel: (id) => agentMeta(id).label,
        groups,
        narrowed: Boolean(query.trim()) || filter !== "all" || showArchived,
        scope: section,
      }),
    [prepared, groupBy, groups, query, filter, showArchived, section, seenVersion],
  );

  const open = (id) => {
    navigate(id);
    onClose?.();
  };
  const otherThreads = section === "telegram" ? prepared.filter((c) => !c.mother && !c.global) : [];
  // A new chat, in a group when it comes from that group's «+».
  const startChat = (groupId = null) => {
    if (onNewChat) onNewChat(groupId);
    else navigate(null);
    onClose?.();
  };
  const go = (hash) => {
    window.location.hash = hash;
    onClose?.();
  };

  return (
    <aside className="g-sidebar flex h-full w-full flex-col bg-card">
      <div className={`flex min-w-0 items-center ${karsara ? "gap-2 px-2 pb-2 pt-[max(env(safe-area-inset-top),0.6rem)]" : "gap-3 px-3 pb-3 pt-[max(env(safe-area-inset-top),0.85rem)]"}`}>
        {karsara ? null : <img src="/icon.svg" alt={BRAND.name} className="size-10 shrink-0 rounded-xl" title={BRAND.name} />}
        <AgentPicker agent={agent} onChange={onAgentChange} locked={agentLocked} className={karsara ? "min-w-[10rem]" : "min-w-[11rem]"} />
        {onClose ? (
          <button type="button" onClick={onClose} className="rounded-lg p-2 hover:bg-muted md:hidden" aria-label={t("بستن")}>
            <X className="size-5" />
          </button>
        ) : null}
      </div>

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
            <SortMenu sort={sort} groupBy={groupBy} defaultGroupBy={defaultGroupBy} onSort={setSort} onGroupBy={setGroupBy} karsara={karsara} />
            <FilterMenu filter={filter} onFilter={setFilter} karsara={karsara} />
          </>}
        </label>
      </div>

      {/* Only "new" and the search stay fixed; everything else scrolls with the chat list.
          It stays under Telegram too: it is the way back to the owner's own chats. */}
      <div className="mt-2 px-2">
        <NavButton active={!page && !activeId} icon={Bot} href="#/" label={t("جدید")} onClick={() => startChat(null)} karsara={karsara} badge={inbox.count} />
      </div>

      <nav className="scrollbar-thin mt-0.5 min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {section === "manual" && !showArchived ? <SidebarNotes refreshKey={chats} onNavigate={onClose} /> : null}
        <SidebarSuggestions refreshKey={chats} onNavigate={onClose} />
        <SidebarNav section={section} go={go} karsara={karsara} />

        {karsara ? (
          <div className="mt-2" />
        ) : (
          <div className="my-4 flex items-center justify-center" aria-hidden>
            <span className="size-1 rounded-full bg-border" />
          </div>
        )}

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
                  karsara={karsara}
                />
              </div>
            ) : null}
          </>
        ) : (
          <>
          {karsara && !showArchived ? null : (
            <h2 className="truncate px-1 text-start text-xs font-medium text-muted-foreground">
              {showArchived ? t("بایگانی") : SECTIONS[section].label}
            </h2>
          )}
          <div className="mt-2" />
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
              groups={groups}
              activeId={activeId}
              onOpen={open}
              collapsible={item.collapsible}
              collapsed={item.collapsible && collapsed[item.key] && !item.chats.some((c) => c.id === activeId)}
              onToggle={() => toggleGroup(item.key)}
              onGroupCreated={() => setGroupBy("custom")}
              onNewChat={showArchived ? null : startChat}
              karsara={karsara}
            />
          ))}
          {groupBy === "custom" && !showArchived ? (
            <button type="button" onClick={() => newGroup()} className="mt-1 flex w-full items-center gap-2 rounded-lg px-3 py-2 text-xs text-muted-foreground hover:bg-muted">
              <FolderPlus className="size-3.5" />
              {t("گروه جدید")}
            </button>
          ) : null}
          {!prepared.length ? (
            <div className="px-3 py-6 text-center text-sm text-muted-foreground">
              <p>{t("گفتگویی نیست.")}</p>
              {filter !== "all" ? (
                <button type="button" onClick={() => setFilter("all")} className="mt-2 rounded-lg px-3 py-1 text-xs text-primary hover:bg-muted">
                  {t("نمایش همه")}
                </button>
              ) : null}
            </div>
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

      <UserBar onNavigate={onClose} karsara={karsara} />
    </aside>
  );
}

function SortMenu({ sort, groupBy, defaultGroupBy = "none", onSort, onGroupBy, karsara = false }) {
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

function FilterMenu({ filter, onFilter, karsara = false }) {
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

function UserBar({ onNavigate, karsara = false }) {
  const [open, setOpen] = useState(false);
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
  const go = (hash) => {
    setOpen(false);
    window.location.hash = hash;
    onNavigate?.();
  };
  // Settings opens on the section it last showed (Settings.jsx readSection).
  const goTokens = () => {
    writeSetting("griffin.settings.section", "tokens");
    go("/settings");
  };
  const logout = () => api("/api/auth/logout", { method: "POST" }).finally(() => window.location.reload());

  return (
    <div className="flex items-center gap-2 border-t px-2 py-2 pb-[max(env(safe-area-inset-bottom),0.5rem)]">
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Trigger asChild>
          <button
            type="button"
            className={`g-user-bar press flex min-w-0 flex-1 items-center text-start hover:bg-muted data-[state=open]:bg-muted ${
              karsara ? "min-h-11 gap-2 rounded-md px-2" : "gap-2.5 rounded-xl bg-muted/50 px-2 py-1.5"
            }`}
            aria-label={t("منوی کاربر")}
          >
            <img
              src={owner.photo}
              alt=""
              className={`${karsara ? "size-6" : "size-9"} shrink-0 rounded-full ${owner.isPhoto ? "object-cover" : ""}`}
              onError={owner.isPhoto ? onPhotoError : undefined}
            />
            <span className={`min-w-0 flex-1 truncate text-sm ${karsara ? "" : "font-medium"}`} dir="auto">{owner.name}</span>
            {setupMissing ? <span className="size-2 shrink-0 rounded-full bg-warn" role="img" aria-label={t("اتصالی ناقص است")} title={t("اتصالی ناقص است")} /> : null}
            <ChevronUp className={`size-3.5 shrink-0 text-muted-foreground transition-transform ${open ? "" : "opacity-70"}`} />
          </button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content
            side="top"
            align="start"
            sideOffset={8}
            avoidCollisions={false}
            className="g-menu pop z-50 w-[var(--radix-popover-trigger-width)] overflow-hidden rounded-xl border bg-card p-1 shadow-xl"
          >
            <MenuRow icon={Bot} label={t("ایجنت‌ها")} onClick={() => go("/agents")} />
            <MenuRow icon={Coins} label={t("مصرف توکن")} onClick={goTokens} />
            <UsageBadge />
            <MenuRow icon={Settings2} label={t("تنظیمات")} onClick={() => go("/settings")} warn={setupMissing} />
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
      <button
        type="button"
        onClick={logout}
        className="press flex size-11 shrink-0 items-center justify-center rounded-xl text-muted-foreground hover:bg-muted hover:text-foreground"
        title={t("خروج")}
        aria-label={t("خروج")}
      >
        <LogOut className="size-4 -scale-x-100" />
      </button>
    </div>
  );
}

function MenuRow({ icon: Icon, label, onClick, warn = false }) {
  return (
    <button type="button" onClick={onClick} className="g-menu-row flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2.5 text-sm hover:bg-muted">
      <Icon className="size-4 text-muted-foreground" />
      <span>{label}</span>
      {warn ? <span className="ms-auto size-2 rounded-full bg-warn" aria-hidden /> : null}
    </button>
  );
}

// A real link: middle-click, Ctrl+click and «Open in new tab» open the page in another tab; a
// plain click stays in this one. Under the Karsara skin a flat list row (g-nav-row).
// The top sections, as the owner set them in Settings → ظاهر (sidebar-nav.js): rows, or one row of
// icons; hidden ones under «بیشتر», and shown anyway while one of them is the open page.
const NAV_TARGETS = {
  telegram: { section: "telegram", icon: MessageCircle, path: "/telegram" },
  jobs: { section: "job", icon: AlarmClock, path: "/jobs" },
  incidents: { section: "ops", icon: Radar, path: "/incidents" },
  peers: { section: "peer", icon: Users, path: "/peers" },
  workbench: { section: "workbench", icon: TerminalSquare, path: "/workbench" },
};

function SidebarNav({ section, go, karsara = false }) {
  const prefs = useNavPrefs();
  const [more, setMore] = useState(false);
  const items = NAV_ITEMS.map((item) => ({ ...item, ...NAV_TARGETS[item.id] }));
  const shown = items.filter((item) => !prefs.hidden.includes(item.id) || section === item.section);
  const rest = items.filter((item) => !shown.includes(item));
  const icons = prefs.style === "icons";
  const openSettings = () => {
    setMore(false);
    writeSetting("griffin.settings.section", "appearance");
    go("/settings");
  };
  const moreMenu = rest.length || icons ? (
    <Popover.Root open={more} onOpenChange={setMore}>
      <Popover.Trigger asChild>
        <button
          type="button"
          title={t("بخش‌های دیگر")}
          aria-label={t("بخش‌های دیگر")}
          className={
            icons
              ? "g-icon-btn flex size-9 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground data-[state=open]:bg-muted"
              : `g-nav-row flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-muted-foreground hover:bg-muted/70 hover:text-foreground data-[state=open]:bg-muted ${karsara ? "min-h-9 px-2.5" : ""}`
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
            <Settings2 className="size-3.5 shrink-0" />
            {t("تنظیم بخش‌های منو…")}
          </button>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  ) : null;

  if (icons) {
    return (
      <div className="flex flex-wrap items-center gap-1 px-1">
        {shown.map(({ id, label, icon: Icon, path, section: target }) => (
          <a
            key={id}
            href={`#${path}`}
            title={label}
            aria-label={label}
            aria-current={section === target ? "page" : undefined}
            onClick={(event) => {
              if (!isPlainClick(event)) return;
              event.preventDefault();
              go(path);
            }}
            className={`g-icon-btn flex size-9 items-center justify-center rounded-lg transition-colors ${section === target ? "bg-primary/12 text-primary" : "text-muted-foreground hover:bg-muted hover:text-foreground"}`}
          >
            <Icon className="size-4" />
          </a>
        ))}
        {moreMenu}
      </div>
    );
  }
  return (
    <div className="space-y-0.5">
      {shown.map(({ id, label, icon, path, section: target }) => (
        <NavButton key={id} active={section === target} icon={icon} href={`#${path}`} label={label} onClick={() => go(path)} karsara={karsara} />
      ))}
      {moreMenu}
    </div>
  );
}

function NavButton({ active, icon: Icon, href, label, onClick, karsara = false, badge = 0 }) {
  return (
    <a
      href={href}
      onClick={(event) => {
        if (!isPlainClick(event)) return;
        event.preventDefault();
        onClick();
      }}
      aria-current={active ? "page" : undefined}
      className={`g-nav-row flex w-full items-center justify-start text-sm ${
        karsara
          ? `min-h-9 gap-2 rounded-md px-2.5 ${active ? "bg-muted text-foreground" : "text-foreground hover:bg-muted"}`
          : `gap-2.5 rounded-lg px-3 py-2 font-medium ${active ? "bg-primary/12 text-primary" : "text-foreground/80 hover:bg-muted/70 hover:text-foreground"}`
      }`}
    >
      <Icon className={`size-4 shrink-0 ${karsara ? "text-muted-foreground" : ""}`} />
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

function Section({ title, group = null, chats, groups, activeId, onOpen, collapsible = false, collapsed = false, onToggle, onGroupCreated, onNewChat, karsara = false }) {
  const [menu, setMenu] = useState(false);
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
    <div className="mb-2">
      {collapsible ? (
        <div className="group relative flex items-center">
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={!collapsed}
            className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-3 pb-1 pt-2 text-[11px] font-medium text-muted-foreground hover:text-foreground"
          >
            <ChevronDown className={`size-3 shrink-0 transition-transform ${collapsed ? "-rotate-90 rtl:rotate-90" : ""}`} />
            <span className="min-w-0 flex-1 truncate text-start" dir="auto">{title}</span>
            <span className="shrink-0 tabular-nums">{chats.length}</span>
          </button>
          {group && onNewChat ? (
            <button
              type="button"
              onClick={() => onNewChat(group.id)}
              className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground md:opacity-0 md:focus-visible:opacity-100 md:group-hover:opacity-100"
              title={t("گفتگوی جدید در «{name}»", { name: group.name })}
              aria-label={t("گفتگوی جدید در گروه {name}", { name: group.name })}
            >
              <Plus className="size-3.5" />
            </button>
          ) : null}
          {group ? (
            <button
              type="button"
              onClick={() => setMenu(!menu)}
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
      {collapsed ? null : <ul>
        {chats.map((chat) => (
          <ChatItem key={chat.id} chat={chat} active={chat.id === activeId} onOpen={onOpen} groups={groups} onGroupCreated={onGroupCreated} karsara={karsara} />
        ))}
      </ul>}
    </div>
  );
}

function ChatItem({ chat, active, onOpen, groups = [], onGroupCreated, karsara = false }) {
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
        className={`g-chat-row group flex items-center rounded-lg ${active ? "bg-muted" : "hover:bg-muted/60"}`}
        data-active={active ? "true" : undefined}
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
          {karsara ? null : <ChatAgentGlyphs agents={agents} />}
          <span className={`min-w-0 flex-1 truncate ${unread ? "font-semibold text-foreground" : ""}`} dir={textDir(chat.title)}>
            {chat.title}
          </span>
          {state.id === "ask" ? (
            <span className="shrink-0" title={state.label}><CircleHelp className="size-3.5 text-warn" aria-label={state.label} /></span>
          ) : state.id === "running" ? (
            karsara ? (
              <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-primary" title={state.label} />
            ) : (
              <span className="agent-dots shrink-0 text-primary" aria-hidden><i /><i /><i /></span>
            )
          ) : state.failed ? (
            <span className="size-1.5 shrink-0 rounded-full bg-bad" title={t("خطادار")} />
          ) : null}
          {unread ? <span className="size-2 shrink-0 rounded-full bg-primary ring-2 ring-primary/25" title={t("محتوای دیده‌نشده")} /> : null}
          <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground" title={exactTime(chat.updatedAt || chat.createdAt)}>{ago(chat.updatedAt || chat.createdAt)}</span>
        </a>
        <button
          type="button"
          onClick={() => (menu ? closeMenu() : setMenu(true))}
          className="me-1 rounded p-1 text-muted-foreground opacity-100 hover:bg-background md:opacity-0 md:focus-visible:opacity-100 md:group-hover:opacity-100"
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
            <ChatMenuItem icon={ExternalLink} onClick={() => { closeMenu(); window.open(`#/c/${chat.id}`, "_blank", "noopener"); }}>
              {t("باز کردن در تب جدید")}
            </ChatMenuItem>
            <ChatMenuItem icon={FolderInput} onClick={() => setMoving(true)}>{t("انتقال به گروه")}</ChatMenuItem>
          </div>
          )}
        </>
      ) : null}
    </li>
  );
}

const failed = (error) => toast.error(error?.status === 409 ? t("هنوز در حال کار است") : error?.message || t("انجام نشد"));

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
