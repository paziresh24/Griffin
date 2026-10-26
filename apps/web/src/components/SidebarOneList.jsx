import { useEffect, useMemo, useRef, useState } from "react";
import { Popover } from "radix-ui";
import {
  AlarmClock, Archive, BellRing, ArchiveRestore, ArrowDownAZ, ArrowUpDown, Bot, Check, ChevronDown, ChevronUp,
  ChevronRight, ExternalLink, Filter, FolderInput, FolderPlus, FolderTree, Inbox, LogOut, Mail, MailOpen, MoreHorizontal, Pencil, Pin, PinOff, Search,
  CircleHelp, Hourglass, PanelRightClose, Plus, Settings2, Trash2, Users, X, Zap,
} from "lucide-react";
import { api, navigate, usePolling } from "../api.js";
import { FeedbackBarButton, PROFILE_ITEMS, profileAction } from "./Feedback.jsx";
import { peoplePath } from "../inbox-people.js";
import { isUnreadChat, markSeen, markUnread, seenOf, useSeenVersion } from "../seen.js";
import { agentMeta, readSetting, writeSetting } from "../brand.js";
import { textDir } from "../dir.js";
import { SidebarSuggestions } from "./ChatTools.jsx";
import { ListStatus } from "./ListStatus.jsx";
import { isPlainClick } from "../sidebar-width.js";
import { FILTERS, GROUPS, SORTS, chatState, filterChats, isPeerChat, layoutChats, sortChats, splitPeerChats } from "../karsara-chat-list.js";
import { PROFILE_EVENT, ownerView } from "../profile.js";
import { clockLabel } from "../elapsed.js";
import { reminderLabel } from "../chat-list.js";
import { useFlag } from "../ui-prefs.js";
import { t } from "../i18n.js";
import { useListChoice, useSectionOrder } from "../list-prefs.js";
import { useUpdateDot } from "./UpdateNotice.jsx";
import { PaletteKey, SectionMenuFoot, SectionMenuItems } from "./SectionNav.jsx";
import { groupOrder, sectionDrag } from "../drag.js";
import { chatDragProps, groupDragProps, useSectionDrop } from "./SidebarDrag.jsx";

// The sidebar's one list (flag «یک فهرست برای همه», ui-prefs.js): Karsara's own list (karsara-live
// Sidebar.jsx, release a9c3e3ee51bc), kept as close to it as Griffin's data allows, drawn inside the one
// Sidebar (Sidebar.jsx gives the header, the sections and the footer).
// Differences from Karsara: the list holds the owner's own chats, the job runs and the peers' chats
// (Telegram, ops-room and workbench threads stay on their own pages); the Telegram inbox status comes
// from /api/telegram-inbox/status; «اتصالی ناقص است» is /api/setup's needsEngine.

// Which tab a chat belongs to in Griffin; Karsara's one list takes the owner's, the jobs' and the peers'.
const sourceOf = (chat) => (chat.global ? "telegram" : chat.source || "manual");
const KARSARA_SOURCES = new Set(["manual", "job", "peer"]);
const withoutSideChats = (list) => (list || []).filter((c) => !c.sideOf);

// GET /api/telegram-inbox/status: a pinned row while the install's DM mode is "inbox" (Karsara's inbox.js).
function inboxRow(status) {
  if (status?.mode !== "inbox" || !status.chatId) return null;
  const pending = Number(status.pending) || 0;
  return { chatId: status.chatId, title: "Telegram inbox", badge: pending > 99 ? "99+" : pending > 0 ? String(pending) : null };
}
function withoutInboxChat(chats, status) {
  const row = inboxRow(status);
  return row ? (chats || []).filter((chat) => chat.id !== row.chatId) : chats || [];
}

// Karsara's useSetup().pending, as far as Griffin's /api/setup tells: an engine still needs a key.
function useSetupMissing() {
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    let live = true;
    api("/api/setup").then((r) => live && setMissing(Boolean(r?.needsEngine)), () => {});
    return () => {
      live = false;
    };
  }, []);
  return missing;
}

// Job chats joined the list on 2026-10-07, long after the read baseline was taken: without a
// baseline of their own every old one would show as unread. The first load after that records
// the moment; a job chat is unread only for activity after it (or once it has been opened).
let jobBaselineAt = null;
function jobBaseline() {
  if (jobBaselineAt != null) return jobBaselineAt; // one storage read per page, not per row
  try {
    let at = localStorage.getItem("kc-job-baseline");
    if (!at) localStorage.setItem("kc-job-baseline", (at = new Date().toISOString()));
    jobBaselineAt = at;
  } catch {
    jobBaselineAt = "";
  }
  return jobBaselineAt;
}
const isUnread = (chat) => {
  const seenAt = seenOf(chat.id);
  if (chat.jobId && !seenAt && String(chat.updatedAt || "") <= jobBaseline()) return false;
  return isUnreadChat(chat, seenAt);
};

const REVERSES = [{ id: "no" }, { id: "yes" }];

// The grouping lives on the server (GET/PUT /api/list-prefs) so every device shows the same list.
// The last known value is kept for the page, so a sidebar that remounts (the phone drawer) does not flash.
let groupByCache = null;
function useServerGroupBy(initial) {
  const [value, setValue] = useState(groupByCache || initial);
  useEffect(() => {
    let alive = true;
    api("/api/list-prefs").then(
      ({ groupBy }) => {
        if (!alive || !groupBy) return;
        groupByCache = groupBy;
        setValue(groupBy);
      },
      () => {},
    );
    return () => {
      alive = false;
    };
  }, []);
  const set = (next) => {
    groupByCache = next;
    setValue(next);
    api("/api/list-prefs", { method: "PUT", body: { groupBy: next } }).catch(() => {});
  };
  return [value, set];
}

export function OneList({ chats, archived, groups = [], looseAt = null, loading = false, failed = false, onRetry = null, onNewChat = null, activeId, onClose, nav = null, karsara = true }) {
  const inboxOn = useFlag("inboxRow");
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(true);
  const [sort, setSort] = useListChoice("sort", "kc-list-sort", "updated", SORTS);
  const [groupBy, setGroupBy] = useServerGroupBy("custom");
  const [sectionOrders, setSectionOrder] = useSectionOrder(); // sections dragged into the owner's order (drag.js)
  const [reverse, setReverse] = useListChoice("reverse", "kc-list-reverse", "no", REVERSES);
  const [filter, setFilter] = useListChoice("filter", "kc-list-filter", "all", FILTERS);
  const seenVersion = useSeenVersion(); // read state changes re-shape the list (unread filter, groups)
  const [showArchived, setShowArchived] = useState(false);
  const searchRef = useRef(null);

  // Side chats live in their parent's side panel, never in the main list.
  // The Telegram inbox chat has its own pinned row while it is enabled.
  const inboxStatus = usePolling(inboxOn ? "/api/telegram-inbox/status" : null, 15_000);
  const inbox = inboxOn ? inboxRow(inboxStatus) : null;
  const list = useMemo(() => {
    const own = withoutSideChats(showArchived ? archived : chats).filter((c) => KARSARA_SOURCES.has(sourceOf(c)));
    return inboxOn ? withoutInboxChat(own, inboxStatus) : own;
  }, [showArchived, archived, chats, inboxStatus, inboxOn]);

  // Client-side title filter only sees what's already loaded; the server also matches message
  // bodies (SQLite FTS5) so a chat whose title never mentions the topic can still be found.
  const [bodyMatches, setBodyMatches] = useState([]);
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setBodyMatches([]);
      return;
    }
    let alive = true;
    const timer = setTimeout(() => {
      api(`/api/chats?q=${encodeURIComponent(q)}${showArchived ? "&archived=1" : ""}`)
        .then(({ chats: found }) => alive && setBodyMatches(found))
        .catch(() => alive && setBodyMatches([]));
    }, 200);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [query, showArchived]);

  const prepared = useMemo(() => {
    const q = query.trim().toLowerCase();
    let items;
    if (q) {
      const byId = new Map(list.map((c) => [c.id, c]));
      for (const c of bodyMatches) if (!byId.has(c.id)) byId.set(c.id, c);
      items = [...byId.values()].filter((c) => c.title.toLowerCase().includes(q) || bodyMatches.some((m) => m.id === c.id));
    } else {
      items = [...list];
    }
    const shown = sortChats(filterChats(items, filter, isUnread, { keepId: activeId }), sort, isUnread, { reverse: reverse === "yes" });
    // Chats other agents opened sit, collapsed, under «ایجنت‌های همکاران»; a search still finds them in place.
    return q ? { own: shown, peers: [] } : splitPeerChats(shown);
  }, [list, query, sort, reverse, filter, bodyMatches, seenVersion, activeId]);

  const sections = useMemo(() => {
    // Pinned chats, the owner's groups and the chosen grouping all show at once (pinned on top);
    // the archive has no groups. An empty group stays visible (a new one must show up to be used),
    // but not while a search or a filter narrows the list.
    const narrowed = Boolean(query.trim()) || filter !== "all" || showArchived;
    const all = layoutChats(prepared.own, groupBy, { isUnread, agentLabel: (id) => agentMeta(id).label, groups: showArchived ? [] : groups, looseAt, sectionOrder: sectionOrders[groupBy] });
    return all
      .filter((s) => s.chats.length || (s.groupId && !narrowed))
      .map((s) => (s.title && !s.counted ? { ...s, title: `${s.title} (${s.chats.length.toLocaleString("fa-IR")})` } : s));
  }, [prepared, groupBy, groups, looseAt, sectionOrders, query, filter, showArchived, seenVersion]);
  const order = useMemo(() => groupOrder(groups, looseAt), [groups, looseAt]); // drag and drop (drag.js)
  const sectionKeys = sections.filter((s) => s.loose).map((s) => s.key);
  const dragOf = (section) =>
    showArchived ? { handle: null, slots: [] } : sectionDrag(section, { groupBy, groupsOrder: order, hasGroups: groups.length > 0, sectionKeys, onOrder: (keys) => setSectionOrder(groupBy, keys) });


  const open = (id) => {
    navigate(id);
    onClose?.();
  };
  // A new chat, in a group when it comes from that group's «+».
  const startChat = (groupId = null, options = {}) => {
    if (onNewChat) onNewChat(groupId, options);
    else navigate(null);
    onClose?.();
  };

  return (
    <>
      <div className="px-2">
        <label className="kc-search">
          <Search className="size-3.5 shrink-0 text-muted-foreground" />
          <input
            ref={searchRef}
            data-reload-safe=""
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setQuery("");
            }}
            placeholder={t("جستجوی گفتگوها")}
            className="w-full min-w-0 bg-transparent outline-none placeholder:text-muted-foreground"
          />
          {query ? (
            <button type="button" className="kc-icon-btn !size-6" aria-label={t("پاک کردن جستجو")} onClick={() => setQuery("")}>
              <X className="!size-3.5" />
            </button>
          ) : null}
          <PaletteKey />
          <SortMenu sort={sort} groupBy={groupBy} reverse={reverse === "yes"} onSort={setSort} onGroupBy={setGroupBy} onReverse={(on) => setReverse(on ? "yes" : "no")} />
          <FilterMenu filter={filter} onFilter={setFilter} />
        </label>
      </div>

      {/* Only «جدید» and the search stay fixed; everything else scrolls with the chat list (owner, 2026-10-11). */}
      {nav?.top}

      <nav className="scrollbar-thin mt-1 min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {nav?.sections}
        <PeerChats chats={prepared.peers} activeId={activeId} onOpen={open} filtered={filter !== "all"} />
        <SidebarSuggestions refreshKey={chats} onNavigate={onClose} karsara={karsara} />
        {showArchived ? <p className="mt-3 px-2 text-xs text-muted-foreground">{t("بایگانی")}</p> : null}
        <div className="mt-2" />
        {inbox && !showArchived ? <InboxRow row={inbox} active={inbox.chatId === activeId} onOpen={open} /> : null}
        {sections.map((section) => (
          <Section
            key={section.key || section.title || "recent"}
            title={section.title}
            group={section.groupId ? groups.find((g) => g.id === section.groupId) : null}
            chats={section.chats}
            repo={section.repo}
            groups={groups}
            activeId={activeId}
            onOpen={open}
            dropTarget={showArchived ? null : section.pinned ? { kind: "pinned" } : section.groupId ? { kind: "group", id: section.groupId } : section.loose ? { kind: "loose" } : null}
            drag={dragOf(section)}
            onNewChat={showArchived ? null : startChat}
          />
        ))}
        {!showArchived ? (
          <button type="button" onClick={() => newGroup()} className="kc-list-row mt-1 w-full text-xs !text-[var(--kc-muted)]">
            <FolderPlus className="size-3.5" />
            {t("گروه جدید")}
          </button>
        ) : null}
        <ListStatus loading={loading && !chats.length} failed={failed} onRetry={onRetry} empty={!prepared.own.length} k>
          <p className="px-3 py-6 text-center text-sm text-muted-foreground">{t("گفتگویی نیست.")}</p>
        </ListStatus>
        {showArchived && list.length > 0 ? (
          <button type="button" onClick={() => deleteAllArchived(list.map((c) => c.id))} className="kc-list-row mt-2 w-full text-xs !text-[var(--kc-muted)]">
            <Trash2 className="size-3.5" />
            {t("حذف دائم همه بایگانی ({length})", { length: list.length })}
          </button>
        ) : null}
        {archived.length > 0 || showArchived ? (
          <button
            type="button"
            onClick={() => setShowArchived(!showArchived)}
            className="kc-list-row mt-2 w-full text-xs !text-[var(--kc-muted)]"
          >
            <Archive className="size-3.5" />
            {showArchived ? t("بازگشت به گفتگوها") : t("بایگانی ({length})", { length: archived.length })}
          </button>
        ) : null}
      </nav>
    </>
  );
}

function SortMenu({ sort, groupBy, reverse, onSort, onGroupBy, onReverse }) {
  const [open, setOpen] = useState(false);
  const active = sort !== "updated" || groupBy !== "custom" || reverse;
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          title={t("مرتب‌سازی")}
          aria-label={t("مرتب‌سازی")}
          className={`kc-icon-btn !size-7 ${active ? "!text-[var(--kc-accent)]" : ""}`}
        >
          <ArrowUpDown className="!size-3.5" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="start" sideOffset={6} className="kc-menu pop z-50 w-52 shadow-lg">
          <p className="px-2.5 py-1.5 text-[11px] font-medium text-muted-foreground">{t("مرتب‌سازی")}</p>
          {SORTS.map((item) => (
            <MenuPick key={item.id} icon={item.id === "title" ? ArrowDownAZ : ArrowUpDown} label={item.label} selected={sort === item.id} onClick={() => { onSort(item.id); setOpen(false); }} />
          ))}
          <MenuPick label={t("ترتیب معکوس")} selected={reverse} onClick={() => onReverse(!reverse)} />
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

function FilterMenu({ filter, onFilter }) {
  const [open, setOpen] = useState(false);
  const active = filter !== "all";
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          title={t("فیلتر")}
          aria-label={t("فیلتر")}
          className={`kc-icon-btn !size-7 ${active ? "!text-[var(--kc-accent)]" : ""}`}
        >
          <Filter className="!size-3.5" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="start" sideOffset={6} className="kc-menu pop z-50 w-44 shadow-lg">
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
    <button type="button" onClick={onClick} className="kc-row">
      {Icon ? <Icon className="size-3.5 kc-muted" /> : null}
      <span className="flex-1 text-start">{label}</span>
      {selected ? <Check className="kc-check size-3.5" /> : null}
    </button>
  );
}

// «منوی کاربر پایین فهرست» (flag userMenu): the owner's name opens agents, token usage and settings.
export function UserMenu({ onNavigate }) {
  const [open, setOpen] = useState(false);
  // Something to connect (Claude signed out, Telegram not connected): marked here, so it is seen
  // without opening Settings.
  const setupMissing = useSetupMissing();
  const updateDot = useUpdateDot(); // «آپدیت فقط در تنظیمات»: a new release waits there
  // The owner's name and photo, replaced at once when Settings saves a typed name.
  const [profile, setProfile] = useState(null);
  const [photoFailed, setPhotoFailed] = useState(false);
  useEffect(() => {
    let live = true;
    let timer = null;
    // One more ask a little later when the first failed or Telegram's photo was still on its way.
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
    return () => {
      live = false;
      clearTimeout(timer);
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
  const go = (hash, section = null) => {
    setOpen(false);
    if (section) {
      try {
        localStorage.setItem("griffin.settings.section", section);
      } catch {
        /* storage blocked: Settings opens on its first section */
      }
    }
    window.location.hash = hash;
    onNavigate?.();
  };
  return (
    <div className="flex items-center gap-2 border-t px-2 py-2 pb-[max(env(safe-area-inset-bottom),0.5rem)]">
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Trigger asChild>
          <button
            type="button"
            className="kc-list-row min-h-11 min-w-0 flex-1 text-start data-[state=open]:bg-[var(--kc-chip)]"
            aria-label={t("منوی کاربر")}
          >
            <img
              src={owner.photo}
              alt=""
              className={`size-6 shrink-0 ${owner.isPhoto ? "rounded-full object-cover" : ""}`}
              onError={owner.isPhoto ? onPhotoError : undefined}
            />
            <span className="min-w-0 flex-1 truncate text-sm" dir="auto">{owner.name}</span>
            {setupMissing ? <span className="size-2 shrink-0 rounded-full bg-warn" role="img" aria-label={t("اتصالی ناقص است")} title={t("اتصالی ناقص است")} /> : updateDot ? <span className="size-2 shrink-0 rounded-full bg-primary" role="img" aria-label={t("نسخهٔ تازه آماده است")} title={t("نسخهٔ تازه آماده است")} /> : null}
            <ChevronUp className={`size-3.5 shrink-0 text-muted-foreground transition-transform ${open ? "" : "opacity-70"}`} />
          </button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content
            side="top"
            align="start"
            sideOffset={8}
            avoidCollisions={false}
            className="kc-menu pop z-50 w-[var(--radix-popover-trigger-width)] shadow-lg"
          >
            {/* «جای بخش‌ها: منوی کاربر»: the sections first (SectionNav.jsx); nothing otherwise. */}
            <SectionMenuItems onPick={() => { setOpen(false); onNavigate?.(); }} rowClass="kc-row" iconClass="size-4 kc-muted" />
            {PROFILE_ITEMS.filter((item) => item.id !== "logout").map(({ id, icon, label }) => (
              <MenuRow key={id} icon={icon} label={label} onClick={() => { setOpen(false); profileAction(id, { editProfile: () => go("/settings", "account") }); }} />
            ))}
            <div className="my-1 border-t" />
            <MenuRow icon={Bot} label={t("ایجنت‌ها")} onClick={() => go("/agents")} />
            {/* Griffin keeps token usage in Settings: «مصرف توکن» opens that section. */}
            <MenuRow icon={Zap} label={t("مصرف توکن")} onClick={() => go("/settings", "tokens")} />
            <MenuRow icon={Settings2} label={updateDot ? t("تنظیمات · نسخهٔ تازه") : t("تنظیمات")} onClick={() => go("/settings", updateDot ? "status" : null)} warn={setupMissing || updateDot} />
            <SectionMenuFoot />
            <div className="my-1 border-t" />
            <MenuRow icon={LogOut} label={t("خروج")} onClick={() => { setOpen(false); profileAction("logout", {}); }} />
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
      <FeedbackBarButton className="kc-icon-btn !size-11" />
    </div>
  );
}

function MenuRow({ icon: Icon, label, onClick, warn = false }) {
  return (
    <button type="button" onClick={onClick} className="kc-row">
      <Icon className="size-4 kc-muted" />
      <span>{label}</span>
      {warn ? <span className="ms-auto size-2 rounded-full bg-warn" aria-hidden /> : null}
    </button>
  );
}

// The chats other agents opened here, under the «ایجنت‌های همکاران» row: closed by default so they do not
// crowd the list; the closed row still shows how many there are and whether one needs a look.
// It opens by itself while one of them is the chat on screen, and while a filter is on (a filter
// is a deliberate look, and its matches must not hide behind a closed row).
const PER_COLLEAGUE = 5;
// The colleagues' chats by whose agent opened them, newest colleague first (the list comes sorted).
function byColleague(chats) {
  const map = new Map();
  for (const chat of chats) {
    if (!map.has(chat.caller)) map.set(chat.caller, { caller: chat.caller, label: chat.peerLabel || chat.caller.slice("peer:".length), chats: [] });
    map.get(chat.caller).chats.push(chat);
  }
  return [...map.values()];
}

function PeerChats({ chats, activeId, onOpen, filtered = false }) {
  const holdsActive = chats.some((c) => c.id === activeId);
  // What the owner chose is kept across reloads and pages; opening because the chat on screen is in
  // here is not a choice and is not stored.
  const [openState, setOpenState] = useState(() => holdsActive || readSetting("kc-peer-chats-open", "") === "1");
  const setOpen = (value) => {
    setOpenState(value);
    writeSetting("kc-peer-chats-open", value ? "1" : "0");
  };
  const open = openState || filtered;
  useEffect(() => {
    if (holdsActive) setOpenState(true);
  }, [holdsActive]);
  if (!chats.length) return null;
  const pending = chats.some((c) => chatState(c, isUnread).id !== "read");
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="kc-list-row w-full justify-start ps-8 text-xs !text-[var(--kc-muted)]"
      >
        <ChevronDown className={`size-3.5 shrink-0 transition-transform ${open ? "" : "-rotate-90"}`} />
        <span>{t("گفتگوهای ایجنت‌های همکاران ({toLocaleString})", { toLocaleString: chats.length.toLocaleString("fa-IR") })}</span>
        {pending && !open ? <span className="kc-unread" title={t("گفتگویی منتظر دیدن است")} /> : null}
      </button>
      {/* A filter forces the group open, so only then it keeps its own short scroll: own chats stay in reach.
          One heading per colleague (the agent's name lives there, not in every title); its newest few
          chats under it, the rest on that colleague's page. */}
      {open ? (
        <div className={`mb-1 ms-6 border-s ps-2 ${filtered ? "scrollbar-thin max-h-64 overflow-y-auto" : ""}`}>
          {byColleague(chats).map((g) => {
            const shown = g.chats.some((c) => c.id === activeId) || filtered ? g.chats : g.chats.slice(0, PER_COLLEAGUE);
            return (
              <div key={g.caller}>
                <a href={`#/peers/${encodeURIComponent(g.caller.slice("peer:".length))}`} className="kc-list-row w-full justify-start text-xs !text-[var(--kc-muted)]" title={t("همهٔ کارهای این همکار")}>
                  <span className="min-w-0 truncate" dir="auto">{g.label}</span>
                  <span className="shrink-0">{`(${g.chats.length.toLocaleString("fa-IR")})`}</span>
                </a>
                <ul>
                  {shown.map((chat) => (
                    <ChatItem key={chat.id} chat={chat} active={chat.id === activeId} activeId={activeId} onOpen={onOpen} />
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function InboxRow({ row, active, onOpen }) {
  return (
    <div className="mt-1 flex min-w-0 items-center gap-1">
      <a href={`#/c/${row.chatId}`} onClick={() => onOpen(row.chatId)} data-active={active} className="kc-list-row w-full min-w-0 flex-1">
        <Inbox className="size-4 shrink-0 text-sky-500" />
        <span className="ltr min-w-0 flex-1 truncate text-start">{row.title}</span>
        {row.badge ? (
          <span className="ltr shrink-0 rounded-full bg-signal px-1.5 py-0.5 text-[11px] font-medium leading-none text-signal-foreground" aria-label={t("{badge} در صف", { badge: row.badge })}>
            {row.badge}
          </span>
        ) : null}
      </a>
      {/* The same inbox by sender, as Telegram lists it. */}
      <a href={peoplePath()} title={t("به تفکیک فرستنده")} aria-label={t("به تفکیک فرستنده")} className="press flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground">
        <Users className="size-4" />
      </a>
    </div>
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
// Permanent delete of archived chats (owner 2026-10-20): one chat from its menu, or the whole archive.
const deleteFailed = (error) => window.alert(error?.status === 409 ? t("هنوز در حال کار است") : error?.message || t("حذف انجام نشد"));
function deleteForGood(chat) {
  if (!window.confirm(t("گفتگوی «{title}» برای همیشه حذف شود؟ برگشتی ندارد.", { title: chat.title }))) return;
  api(`/api/chats/${chat.id}`, { method: "DELETE" }).catch(deleteFailed);
}
function deleteAllArchived(ids) {
  if (!window.confirm(t("همه {length} گفتگوی بایگانی برای همیشه حذف شوند؟ برگشتی ندارد.", { length: ids.length }))) return;
  api("/api/chats/delete-archived", { method: "POST", body: { ids } })
    .then((r) => { if (r.skipped?.length) window.alert(t("{length} گفتگو در حال کار بود و حذف نشد.", { length: r.skipped.length })); })
    .catch(deleteFailed);
}
const groupFailed = () => {
  window.alert(t("کار روی گروه انجام نشد؛ دوباره امتحان کنید."));
  return {};
}

// Which of the owner's groups are folded, kept across reloads.
const FOLDED_KEY = "kc-groups-folded";
function loadFolded() {
  try {
    return new Set(JSON.parse(localStorage.getItem(FOLDED_KEY) || "[]"));
  } catch {
    return new Set();
  }
}
function useFolded(id) {
  const [folded, setFolded] = useState(() => Boolean(id) && loadFolded().has(id));
  const toggle = () => {
    const next = !folded;
    setFolded(next);
    try {
      const all = loadFolded();
      if (next) all.add(id);
      else all.delete(id);
      localStorage.setItem(FOLDED_KEY, JSON.stringify([...all]));
    } catch {
      /* storage blocked: folding lasts for this page only */
    }
  };
  return [folded, toggle];
}

function Section({ title, group = null, repo = null, chats, groups, activeId, onOpen, onNewChat, dropTarget = null, drag = null }) {
  const [folded, toggleFolded] = useFolded(group?.id);
  const [menu, setMenu] = useState(false);
  const drop = useSectionDrop({ target: dropTarget, slots: drag?.slots || [] });
  const handle = drag?.handle ? groupDragProps(drag.handle.id, drag.handle.scope) : {};
  if (!chats.length && !group) return null;
  // The chat on screen stays in sight even inside a folded group.
  const shown = folded ? chats.filter((c) => c.id === activeId) : chats;
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
      {group ? (
        <div className="group relative flex items-center" {...handle} title={t("برای جابه‌جایی بکشید")}>
          <button
            type="button"
            onClick={toggleFolded}
            aria-expanded={!folded}
            className="flex min-w-0 flex-1 items-center gap-1 px-2.5 pb-1 pt-2 text-start text-xs text-muted-foreground hover:text-foreground"
          >
            <ChevronDown className={`size-3 shrink-0 transition-transform ${folded ? "-rotate-90" : ""}`} />
            <span className="min-w-0 truncate" dir="auto">{title}</span>
          </button>
          {onNewChat ? (
            <button
              type="button"
              onClick={() => onNewChat(group.id)}
              data-no-drag=""
              className="kc-icon-btn !h-7 !w-7 md:opacity-0 md:group-hover:opacity-100 md:focus-visible:opacity-100"
              title={t("گفتگوی جدید در «{name}»", { name: group.name })}
              aria-label={t("گفتگوی جدید در گروه {name}", { name: group.name })}
            >
              <Plus className="!size-3.5" />
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => setMenu(!menu)}
          data-no-drag=""
            className="kc-icon-btn !h-7 !w-7 md:opacity-0 md:group-hover:opacity-100 md:focus-visible:opacity-100"
            aria-label={t("گزینه‌های گروه {name}", { name: group.name })}
          >
            <MoreHorizontal className="!size-3.5" />
          </button>
          {menu ? (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setMenu(false)} />
              <div className="kc-menu absolute end-2 top-8 z-20 w-44 shadow-lg">
                <ChatMenuItem icon={Pencil} onClick={rename}>{t("تغییر نام گروه")}</ChatMenuItem>
                <ChatMenuItem icon={Trash2} onClick={remove}>{t("حذف گروه")}</ChatMenuItem>
              </div>
            </>
          ) : null}
        </div>
      ) : title && repo && onNewChat ? (
        <div className="group flex items-center" {...handle}>
          <p className="min-w-0 flex-1 truncate px-2.5 pb-1 pt-2 text-xs text-muted-foreground" dir="auto">{title}</p>
          <RepoNewChat repo={repo} onNewChat={onNewChat} className="kc-icon-btn !h-7 !w-7" />
        </div>
      ) : title ? (
        <p className="px-2.5 pb-1 pt-2 text-xs text-muted-foreground" {...handle}>{title}</p>
      ) : (
        <div className="pt-1" />
      )}
      <ul>
        {shown.map((chat) => (
          <ChatItem key={chat.id} chat={chat} active={chat.id === activeId} activeId={activeId} onOpen={onOpen} groups={groups} />
        ))}
      </ul>
    </div>
  );
}

// «+» beside a repository's heading (grouping «بر اساس مخزن»): a new chat in that repository
// (owner 2026-10-18). Always visible, small: a hover-only button is lost on a phone.
export function RepoNewChat({ repo, onNewChat, className }) {
  return (
    <button type="button" onClick={() => onNewChat(null, { repo })} data-no-drag="" className={className} title={t("گفتگوی جدید در مخزن {repo}", { repo })} aria-label={t("گفتگوی جدید در مخزن {repo}", { repo })}>
      <Plus className="!size-3.5" />
    </button>
  );
}

function ChatItem({ chat, active, activeId, onOpen, groups = [] }) {
  const [menu, setMenu] = useState(false);
  const [moving, setMoving] = useState(false); // the menu shows the group list instead
  const closeMenu = () => {
    setMenu(false);
    setMoving(false);
  };
  const moveTo = (groupId) => {
    closeMenu();
    if (groupId !== (chat.groupId || null)) patch({ groupId });
  };
  const moveToNew = async () => {
    closeMenu();
    const group = await newGroup();
    if (!group) return;
    await patch({ groupId: group.id });
  };
  useSeenVersion(); // subscribe: a markSeen elsewhere (opening this chat) clears the badge live
  const timeAgo = useFlag("timeAgo");
  const agents = chatAgents(chat);
  const children = Array.isArray(chat.children) ? chat.children : [];
  const unread = isUnread(chat);
  const state = chatState(chat, isUnread);
  const patch = (body) => api(`/api/chats/${chat.id}`, { method: "PATCH", body }).catch(() => {});
  const rename = () => {
    setMenu(false);
    const title = window.prompt(t("عنوان جدید"), chat.title);
    if (title?.trim()) patch({ title });
  };
  return (
    <li className="relative">
      <div
        className="kc-list-row group !p-0"
        data-active={active ? "true" : undefined}
        {...(isPeerChat(chat) ? {} : chatDragProps(chat))}
        onContextMenu={(event) => {
          // Right click = the «گزینه‌ها» menu. Shift+right click keeps the browser's own menu.
          if (event.shiftKey) return;
          event.preventDefault();
          setMenu(true);
        }}
      >
        {/* A real link: middle-click, Ctrl+click and the browser's own «Open in new tab» work. */}
        <a
          href={`#/c/${chat.id}`}
          onClick={(event) => {
            if (!isPlainClick(event)) return; // Ctrl/Shift+click: the browser opens the other tab, this one stays
            markSeen(chat.id, chat.updatedAt); // also the open chat, after «علامت خوانده‌نشده»
            onOpen(chat.id);
          }}
          className="flex min-h-[inherit] min-w-0 flex-1 items-center gap-2 py-1.5 ps-2.5 text-start">
          {state.id === "ask" ? (
            <span className="kc-state-wrap" title={state.label}><CircleHelp className="kc-state kc-state-ask" aria-label={state.label} /></span>
          ) : state.id === "running" ? (
            <span className="kc-dot kc-dot-run" title={state.label} />
          ) : state.id === "background" ? (
            <span className="kc-state-wrap" title={state.label}><Hourglass className="kc-state kc-state-bg" aria-label={state.label} /></span>
          ) : state.id === "error" ? (
            <span className="kc-dot kc-dot-bad" title={state.label} />
          ) : null}
          {chat.reminderAt ? (
            <span className="kc-state-wrap" title={reminderLabel(chat.reminderAt)}><BellRing className="kc-state" aria-label={reminderLabel(chat.reminderAt)} /></span>
          ) : null}
          {chat.jobId ? (
            <span className="kc-state-wrap kc-origin" title={t("از جاب: {v}", { v: chat.jobName || t("بی‌نام") })}>
              <AlarmClock className="kc-state" aria-label={t("از جاب {v}", { v: chat.jobName || "" })} />
            </span>
          ) : null}
          <span
            className="min-w-0 flex-1 truncate"
            dir={textDir(chat.title)}
            data-unread={unread || undefined}
            title={agents.length > 1 ? agents.map((id) => agentMeta(id).label).join(t("، ")) : undefined}
          >
            {chat.title}
          </span>
          {unread ? <span className="kc-unread" title={t("محتوای دیده‌نشده")} /> : null}
          <span className="kc-time">{timeAgo ? ago(chat.updatedAt || chat.createdAt) : clockLabel(chat.updatedAt || chat.createdAt)}</span>
        </a>
        <button
          type="button"
          onClick={() => setMenu(!menu)}
          data-no-drag=""
          className="kc-icon-btn !h-8 !w-8 md:opacity-0 md:group-hover:opacity-100 md:focus-visible:opacity-100"
          aria-label={t("گزینه‌ها")}
        >
          <MoreHorizontal />
        </button>
      </div>
      {children.length ? (
        <ul className="mb-1 ms-6 border-s ps-2">
          {children.map((child) => {
            const childUnread = isUnreadChat(child, seenOf(child.id));
            return (
              <li key={child.id}>
                <a
                  href={`#/c/${child.id}`}
                  onClick={(event) => {
                    if (isPlainClick(event)) onOpen(child.id); // Ctrl/Shift+click: only the new tab opens
                  }}
                  data-active={child.id === activeId ? "true" : undefined}
                  className="kc-list-row w-full text-start !text-[13px]"
                >
                  {child.runStatus === "running" ? (
                    <span className="kc-dot kc-dot-run" title={t("در حال اجرا")} />
                  ) : child.runStatus === "error" || child.runStatus === "cancelled" ? (
                    <span className="kc-dot !bg-[var(--bad)]" title={t("خطا")} />
                  ) : null}
                  <span className="min-w-0 flex-1 truncate" dir={textDir(child.title)} data-unread={childUnread || undefined}>{child.title}</span>
                  {childUnread ? <span className="kc-unread" title={t("محتوای دیده‌نشده")} /> : null}
                </a>
              </li>
            );
          })}
        </ul>
      ) : null}
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
            <div className="kc-menu scrollbar-thin absolute end-2 top-9 z-20 max-h-80 w-56 overflow-y-auto shadow-lg">
              <ChatMenuItem icon={ChevronRight} onClick={() => setMoving(false)}>{t("انتقال به گروه")}</ChatMenuItem>
              <div className="my-1 border-t" />
              {groups.map((g) => (
                <button key={g.id} type="button" onClick={() => moveTo(g.id)} className="kc-row">
                  <span className="min-w-0 flex-1 truncate text-start" dir="auto">{g.name}</span>
                  {chat.groupId === g.id ? <Check className="kc-check size-3.5" /> : null}
                </button>
              ))}
              {groups.length ? <div className="my-1 border-t" /> : null}
              <button type="button" onClick={() => moveTo(null)} className="kc-row">
                <span className="flex-1 text-start">{t("بدون گروه")}</span>
                {!groups.some((g) => g.id === chat.groupId) ? <Check className="kc-check size-3.5" /> : null}
              </button>
              <ChatMenuItem icon={FolderPlus} onClick={moveToNew}>{t("گروه جدید…")}</ChatMenuItem>
            </div>
          ) : (
          <div className="kc-menu absolute end-2 top-9 z-20 w-48 shadow-lg">
            <ChatMenuItem icon={chat.pinned ? PinOff : Pin} onClick={() => { setMenu(false); patch({ pinned: !chat.pinned }); }}>
              {chat.pinned ? t("برداشتن سنجاق") : t("سنجاق")}
            </ChatMenuItem>
            <ChatMenuItem icon={Pencil} onClick={rename}>{t("تغییر نام")}</ChatMenuItem>
            {chat.runStatus === "running" ? null : (
              <ChatMenuItem
                icon={unread ? MailOpen : Mail}
                onClick={() => {
                  setMenu(false);
                  if (unread) markSeen(chat.id, chat.updatedAt);
                  else markUnread(chat.id);
                }}
              >
                {unread ? t("علامت خوانده‌شده") : t("علامت خوانده‌نشده")}
              </ChatMenuItem>
            )}
            <ChatMenuItem icon={chat.archived ? ArchiveRestore : Archive} onClick={() => { setMenu(false); patch({ archived: !chat.archived }); }}>
              {chat.archived ? t("خروج از بایگانی") : t("بایگانی")}
            </ChatMenuItem>
            {chat.archived ? <ChatMenuItem icon={Trash2} onClick={() => { setMenu(false); deleteForGood(chat); }}>{t("حذف دائم")}</ChatMenuItem> : null}
            <ChatMenuItem
              icon={ExternalLink}
              onClick={() => {
                setMenu(false);
                window.open(`#/c/${chat.id}`, "_blank", "noopener");
              }}
            >
              {t("باز کردن در تب جدید")}
            </ChatMenuItem>
            {isPeerChat(chat) ? null : (
              <ChatMenuItem icon={FolderInput} onClick={() => setMoving(true)}>{t("انتقال به گروه")}</ChatMenuItem>
            )}
          </div>
          )}
        </>
      ) : null}
    </li>
  );
}

// Short, muted relative time for the chat list («۵ دقیقه», «۲ ساعت», «۳ روز»).
function ago(stamp) {
  const ms = stamp ? new Date(stamp).getTime() : NaN;
  if (!Number.isFinite(ms)) return "";
  const minutes = Math.max(0, Math.round((Date.now() - ms) / 60000));
  const fa = (n) => n.toLocaleString("fa-IR");
  if (minutes < 1) return t("الان");
  if (minutes < 60) return t("{fa} دقیقه", { fa: fa(minutes) });
  const hours = Math.round(minutes / 60);
  if (hours < 24) return t("{fa} ساعت", { fa: fa(hours) });
  const days = Math.round(hours / 24);
  if (days < 30) return t("{fa} روز", { fa: fa(days) });
  return t("{fa} ماه", { fa: fa(Math.round(days / 30)) });
}

function chatAgents(chat) {
  if (Array.isArray(chat.agents) && chat.agents.length) return chat.agents;
  const id = chat.agent || chat.agent_id || "griffin";
  return id ? [id] : [];
}

function ChatMenuItem({ icon: Icon, children, onClick }) {
  return (
    <button type="button" onClick={onClick} className="kc-row">
      <Icon className="size-4 kc-muted" />
      {children}
    </button>
  );
}
