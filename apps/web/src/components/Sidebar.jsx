import { useEffect, useMemo, useRef, useState } from "react";
import { Popover } from "radix-ui";
import {
  AlarmClock, Radar, TerminalSquare, Archive, ArchiveRestore, ArrowDownAZ, ArrowUpDown, Bot, Check, ChevronDown, ChevronRight, ChevronUp,
  Filter, FolderInput, FolderPlus, FolderTree, LogOut, MessageCircle, MoreHorizontal, Pencil, Pin, PinOff, Plus, Search,
  Settings2, Trash2, Users, X,
} from "lucide-react";
import { toast } from "sonner";
import { api, navigate, usePolling } from "../api.js";
import { BRAND, agentMeta, readSetting, writeSetting } from "../brand.js";
import { textDir } from "../dir.js";
import { locale, num, t } from "../i18n.js";
import { groupSections } from "../chat-groups.js";
import { PROFILE_EVENT, ownerView } from "../profile.js";
import { AgentGlyph, AgentPicker } from "./Controls.jsx";
import { SidebarNotes } from "./Notes.jsx";
import { UsageBadge } from "./Usage.jsx";
import { SidebarSuggestions } from "./ChatTools.jsx";

const SORTS = [
  { id: "updated", label: t("جدیدترین") },
  { id: "title", label: t("نام (الفبا)") },
  { id: "running", label: t("در حال اجرا اول") },
];

const GROUPS = [
  { id: "none", label: t("بدون گروه‌بندی") },
  { id: "custom", label: t("گروه‌های خودم") },
  { id: "owner", label: t("بر اساس صاحب") },
  { id: "agent", label: t("بر اساس ایجنت") },
  { id: "status", label: t("بر اساس وضعیت") },
];

const FILTERS = [
  { id: "all", label: t("همه") },
  { id: "running", label: t("در حال اجرا") },
  { id: "error", label: t("دارای خطا") },
  { id: "pinned", label: t("سنجاق‌شده") },
];

// Each tab lists only its own threads: «گفتگو» is what the owner started by hand; Telegram-born,
// peer, ops-room and job threads live under their tabs. Sub-agent chats never appear here — the
// parent chat shows them above the composer.
const SECTIONS = {
  manual: { page: null, label: t("گفتگوهای اخیر") },
  telegram: { page: "telegram", label: t("چت‌های تلگرام") },
  peer: { page: "peers", label: t("کارهای ایجنت‌های همکاران") },
  ops: { page: "incidents", label: t("اتاق‌های عملیات") },
  workbench: { page: "workbench", label: t("میز کار") },
  job: { page: "jobs", label: t("اجراهای جاب") },
};
const sectionOfPage = (page) => Object.keys(SECTIONS).find((k) => SECTIONS[k].page === page && page) || null;

export function Sidebar({ chats, archived, groups = [], onNewChat = null, activeId, activeSource = null, activePersonId = null, page = null, agent, onAgentChange, agentLocked = false, onClose }) {
  const section = sectionOfPage(page) || (!page && activeSource && SECTIONS[activeSource] ? activeSource : "manual");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState("updated");
  // Telegram and peer threads group by whose they are by default, so one person's threads can be
  // folded away while another's stay open. The choice is kept, so the owner's groups stay up.
  const [groupChoice, setGroupChoice] = useState(() => {
    try { return JSON.parse(readSetting("griffin.sidebar.groupBy", "{}")) || {}; } catch { return {}; }
  });
  const groupBy = groupChoice[section] || (section === "telegram" || section === "peer" ? "owner" : "none");
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
  const [filter, setFilter] = useState("all");
  const [showArchived, setShowArchived] = useState(false);

  const list = useMemo(
    () => (showArchived ? archived : chats).filter((c) => (c.source || "manual") === section),
    [showArchived, archived, chats, section],
  );
  const archivedHere = useMemo(() => archived.filter((c) => (c.source || "manual") === section), [archived, section]);

  const prepared = useMemo(() => {
    let items = [...list];
    if (filter === "running") items = items.filter((c) => c.runStatus === "running");
    else if (filter === "error") items = items.filter((c) => c.runStatus === "error");
    else if (filter === "pinned") items = items.filter((c) => c.pinned);

    const q = query.trim().toLowerCase();
    if (q) items = items.filter((c) => c.title.toLowerCase().includes(q));

    items.sort((a, b) => {
      if (sort === "title") return String(a.title).localeCompare(String(b.title), locale);
      if (sort === "running") {
        const ar = a.runStatus === "running" ? 0 : 1;
        const br = b.runStatus === "running" ? 0 : 1;
        if (ar !== br) return ar - br;
      }
      return String(b.updatedAt || b.createdAt || "").localeCompare(String(a.updatedAt || a.createdAt || ""));
    });
    return items;
  }, [list, query, sort, filter]);

  const sections = useMemo(() => {
    if (groupBy === "custom") return groupSections(prepared, groups, { narrowed: Boolean(query.trim()) || filter !== "all" || showArchived });
    if (groupBy === "owner") {
      const map = new Map();
      for (const chat of prepared) {
        const key = chat.ownerKey || "none";
        if (!map.has(key)) map.set(key, { key: `${section}:${key}`, title: chat.ownerLabel || t("بدون صاحب"), chats: [], collapsible: true });
        map.get(key).chats.push(chat);
      }
      return [...map.values()];
    }
    if (groupBy === "agent") {
      const map = new Map();
      for (const chat of prepared) {
        const key = chat.agent || "griffin";
        if (!map.has(key)) map.set(key, []);
        map.get(key).push(chat);
      }
      return [...map.entries()].map(([id, items]) => ({
        title: agentMeta(id).label,
        chats: items,
      }));
    }
    if (groupBy === "status") {
      const running = prepared.filter((c) => c.runStatus === "running");
      const errored = prepared.filter((c) => c.runStatus === "error");
      const rest = prepared.filter((c) => c.runStatus !== "running" && c.runStatus !== "error");
      return [
        running.length ? { title: t("در حال اجرا"), chats: running } : null,
        errored.length ? { title: t("خطا"), chats: errored } : null,
        rest.length ? { title: t("بقیه"), chats: rest } : null,
      ].filter(Boolean);
    }
    const pinned = prepared.filter((c) => c.pinned);
    const rest = prepared.filter((c) => !c.pinned);
      return [
      pinned.length ? { title: t("سنجاق‌شده"), chats: pinned } : null,
      { title: null, chats: rest },
    ].filter((s) => s && s.chats.length);
  }, [prepared, groupBy, groups, query, filter, showArchived, section]);

  const open = (id) => {
    navigate(id);
    onClose?.();
  };
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
    <aside className="flex h-full w-full flex-col bg-card">
      <div className="flex min-w-0 items-center gap-3 px-3 pb-3 pt-[max(env(safe-area-inset-top),0.85rem)]">
        <img src="/icon.svg" alt={BRAND.name} className="size-10 shrink-0 rounded-xl" title={BRAND.name} />
        <AgentPicker agent={agent} onChange={onAgentChange} locked={agentLocked} className="min-w-[11rem]" />
        {onClose ? (
          <button type="button" onClick={onClose} className="rounded-lg p-2 hover:bg-muted md:hidden" aria-label={t("بستن")}>
            <X className="size-5" />
          </button>
        ) : null}
      </div>

      <div className="px-2">
        <label className="flex items-center gap-1 rounded-lg bg-muted py-0.5 pe-0.5 ps-2.5">
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
            <SortMenu sort={sort} groupBy={groupBy} onSort={setSort} onGroupBy={setGroupBy} />
            <FilterMenu filter={filter} onFilter={setFilter} />
          </>}
        </label>
      </div>

      {/* Only "new" and the search stay fixed; everything else scrolls with the chat list. */}
      <div className="mt-2 px-2">
        <NavButton active={!page && !activeId} icon={Bot} label={t("جدید")} onClick={() => startChat(null)} />
      </div>

      <nav className="scrollbar-thin mt-0.5 min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {section === "manual" && !showArchived ? <SidebarNotes refreshKey={chats} onNavigate={onClose} /> : null}
        <SidebarSuggestions refreshKey={chats} onNavigate={onClose} />
        <div className="space-y-0.5">
          <NavButton active={section === "telegram"} icon={MessageCircle} label={t("تلگرام")} onClick={() => go("/telegram")} />
          <NavButton active={section === "job"} icon={AlarmClock} label={t("جاب")} onClick={() => go("/jobs")} />
          <NavButton active={section === "ops"} icon={Radar} label={t("حادثه‌ها")} onClick={() => go("/incidents")} />
          <NavButton active={section === "peer"} icon={Users} label={t("ایجنت‌های همکاران")} onClick={() => go("/peers")} />
          <NavButton active={section === "workbench"} icon={TerminalSquare} label={t("میز کار")} onClick={() => go("/workbench")} />
        </div>

        <div className="my-4 flex items-center justify-center" aria-hidden>
          <span className="size-1 rounded-full bg-border" />
        </div>

        {section === "telegram" ? (
          <MotherList query={query} activePersonId={activePersonId} onNavigate={onClose} />
        ) : (
          <>
          <h2 className="truncate px-1 text-start text-xs font-medium text-muted-foreground">
            {showArchived ? t("بایگانی") : SECTIONS[section].label}
          </h2>
          <div className="mt-2" />
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
            />
          ))}
          {groupBy === "custom" && !showArchived ? (
            <button type="button" onClick={() => newGroup()} className="mt-1 flex w-full items-center gap-2 rounded-lg px-3 py-2 text-xs text-muted-foreground hover:bg-muted">
              <FolderPlus className="size-3.5" />
              {t("گروه جدید")}
            </button>
          ) : null}
          {!prepared.length ? <p className="px-3 py-6 text-center text-sm text-muted-foreground">{t("گفتگویی نیست.")}</p> : null}
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

      <UserBar onNavigate={onClose} />
    </aside>
  );
}

function SortMenu({ sort, groupBy, onSort, onGroupBy }) {
  const [open, setOpen] = useState(false);
  const active = sort !== "updated" || groupBy !== "none";
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          title={t("مرتب‌سازی")}
          aria-label={t("مرتب‌سازی")}
          className={`press flex size-8 items-center justify-center rounded-lg ${
            active || open ? "bg-primary/12 text-primary" : "text-muted-foreground hover:bg-muted hover:text-foreground"
          }`}
        >
          <ArrowUpDown className="size-4" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="start" sideOffset={6} className="pop z-50 w-52 overflow-hidden rounded-xl border bg-card p-1 text-sm shadow-xl">
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
          className={`press flex size-8 items-center justify-center rounded-lg ${
            active || open ? "bg-primary/12 text-primary" : "text-muted-foreground hover:bg-muted hover:text-foreground"
          }`}
        >
          <Filter className="size-4" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="start" sideOffset={6} className="pop z-50 w-44 overflow-hidden rounded-xl border bg-card p-1 text-sm shadow-xl">
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
    <button type="button" onClick={onClick} className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 hover:bg-muted">
      {Icon ? <Icon className="size-3.5 text-muted-foreground" /> : null}
      <span className="flex-1 text-start">{label}</span>
      {selected ? <Check className="size-3.5 text-primary" /> : null}
    </button>
  );
}

function UserBar({ onNavigate }) {
  const [open, setOpen] = useState(false);
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
  const logout = () => api("/api/auth/logout", { method: "POST" }).finally(() => window.location.reload());

  return (
    <div className="flex items-center gap-2 border-t px-2 py-2 pb-[max(env(safe-area-inset-bottom),0.5rem)]">
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Trigger asChild>
          <button
            type="button"
            className="press flex min-w-0 flex-1 items-center gap-2.5 rounded-xl bg-muted/50 px-2 py-1.5 text-start hover:bg-muted data-[state=open]:bg-muted"
            aria-label={t("منوی کاربر")}
          >
            <img
              src={owner.photo}
              alt=""
              className={`size-9 shrink-0 rounded-full ${owner.isPhoto ? "object-cover" : ""}`}
              onError={owner.isPhoto ? onPhotoError : undefined}
            />
            <span className="min-w-0 flex-1 truncate text-sm font-medium" dir="auto">{owner.name}</span>
            <ChevronUp className={`size-3.5 shrink-0 text-muted-foreground transition-transform ${open ? "" : "opacity-70"}`} />
          </button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content
            side="top"
            align="start"
            sideOffset={8}
            avoidCollisions={false}
            className="pop z-50 w-[var(--radix-popover-trigger-width)] overflow-hidden rounded-xl border bg-card p-1 shadow-xl"
          >
            <MenuRow icon={Bot} label={t("ایجنت‌ها")} onClick={() => go("/agents")} />
            <UsageBadge />
            <MenuRow icon={Settings2} label={t("تنظیمات")} onClick={() => go("/settings")} />
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

function MenuRow({ icon: Icon, label, onClick }) {
  return (
    <button type="button" onClick={onClick} className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2.5 text-sm hover:bg-muted">
      <Icon className="size-4 text-muted-foreground" />
      <span>{label}</span>
    </button>
  );
}

function NavButton({ active, icon: Icon, label, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={`flex w-full items-center justify-start gap-2.5 rounded-lg px-3 py-2 text-sm font-medium ${
        active ? "bg-primary/12 text-primary" : "text-foreground/80 hover:bg-muted/70 hover:text-foreground"
      }`}
    >
      <Icon className="size-4 shrink-0" />
      <span>{label}</span>
    </button>
  );
}

// The owner's groups: created from the list or from a chat's "move to group", renamed and deleted
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

function Section({ title, group = null, chats, groups, activeId, onOpen, collapsible = false, collapsed = false, onToggle, onGroupCreated, onNewChat }) {
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
              <div className="absolute end-2 top-8 z-20 w-44 overflow-hidden rounded-lg border bg-card text-sm shadow-lg">
                <ChatMenuItem icon={Pencil} onClick={rename}>{t("تغییر نام گروه")}</ChatMenuItem>
                <ChatMenuItem icon={Trash2} onClick={remove}>{t("حذف گروه")}</ChatMenuItem>
              </div>
            </>
          ) : null}
        </div>
      ) : title ? <p className="px-3 pb-1 pt-2 text-[11px] font-medium text-muted-foreground">{title}</p> : <div className="pt-1" />}
      {collapsed ? null : <ul>
        {chats.map((chat) => (
          <ChatItem key={chat.id} chat={chat} active={chat.id === activeId} onOpen={onOpen} groups={groups} onGroupCreated={onGroupCreated} />
        ))}
      </ul>}
    </div>
  );
}

function ChatItem({ chat, active, onOpen, groups = [], onGroupCreated }) {
  const [menu, setMenu] = useState(false);
  const [moving, setMoving] = useState(false); // the menu shows the group list instead
  const closeMenu = () => {
    setMenu(false);
    setMoving(false);
  };
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
      <div className={`group flex items-center rounded-lg ${active ? "bg-muted" : "hover:bg-muted/60"}`}>
        <button type="button" onClick={() => onOpen(chat.id)} className="flex min-w-0 flex-1 items-center gap-2 px-3 py-2 text-start text-sm">
          <ChatAgentGlyphs agents={agents} />
          <span className="min-w-0 flex-1 truncate" dir={textDir(chat.title)}>
            {chat.title}
          </span>
          {chat.runStatus === "running" ? (
            <span className="agent-dots shrink-0 text-primary" aria-hidden><i /><i /><i /></span>
          ) : chat.runStatus === "error" ? (
            <span className="size-1.5 shrink-0 rounded-full bg-bad" title={t("خطا")} />
          ) : null}
        </button>
        <button
          type="button"
          onClick={() => (menu ? closeMenu() : setMenu(true))}
          className="me-1 rounded p-1 text-muted-foreground opacity-100 hover:bg-background md:opacity-0 md:group-hover:opacity-100"
          aria-label={t("گزینه‌ها")}
        >
          <MoreHorizontal className="size-4" />
        </button>
      </div>
      {menu ? (
        <>
          <div className="fixed inset-0 z-10" onClick={closeMenu} />
          {moving ? (
            <div className="scrollbar-thin absolute end-2 top-9 z-20 max-h-80 w-56 overflow-y-auto rounded-lg border bg-card text-sm shadow-lg">
              <ChatMenuItem icon={ChevronRight} onClick={() => setMoving(false)}>{t("انتقال به گروه")}</ChatMenuItem>
              <div className="my-1 border-t" />
              {groups.map((g) => (
                <button key={g.id} type="button" onClick={() => moveTo(g.id)} className="flex w-full items-center gap-2 px-3 py-2 hover:bg-muted">
                  <span className="min-w-0 flex-1 truncate text-start" dir="auto">{g.name}</span>
                  {chat.groupId === g.id ? <Check className="size-3.5 text-primary" /> : null}
                </button>
              ))}
              {groups.length ? <div className="my-1 border-t" /> : null}
              <button type="button" onClick={() => moveTo(null)} className="flex w-full items-center gap-2 px-3 py-2 hover:bg-muted">
                <span className="flex-1 text-start">{t("بدون گروه")}</span>
                {!groups.some((g) => g.id === chat.groupId) ? <Check className="size-3.5 text-primary" /> : null}
              </button>
              <ChatMenuItem icon={FolderPlus} onClick={moveToNew}>{t("گروه جدید…")}</ChatMenuItem>
            </div>
          ) : (
          <div className="absolute end-2 top-9 z-20 w-44 overflow-hidden rounded-lg border bg-card text-sm shadow-lg">
            <ChatMenuItem icon={chat.pinned ? PinOff : Pin} onClick={() => { closeMenu(); patch({ pinned: !chat.pinned }); }}>
              {chat.pinned ? t("برداشتن سنجاق") : t("سنجاق")}
            </ChatMenuItem>
            <ChatMenuItem icon={Pencil} onClick={rename}>{t("تغییر نام")}</ChatMenuItem>
            <ChatMenuItem icon={chat.archived ? ArchiveRestore : Archive} onClick={() => { closeMenu(); patch({ archived: !chat.archived }); }}>
              {chat.archived ? t("خروج از بایگانی") : t("بایگانی")}
            </ChatMenuItem>
            <ChatMenuItem icon={FolderInput} onClick={() => setMoving(true)}>{t("انتقال به گروه")}</ChatMenuItem>
          </div>
          )}
        </>
      ) : null}
    </li>
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
    <button type="button" onClick={onClick} className="flex w-full items-center gap-2 px-3 py-2 hover:bg-muted">
      <Icon className="size-4 text-muted-foreground" />
      {children}
    </button>
  );
}

// Telegram: one mother chat per person (their threads open from inside it), newest activity first.
function MotherList({ query, activePersonId, onNavigate }) {
  const data = usePolling("/api/telegram/mothers", 8000);
  const q = query.trim().toLowerCase();
  const list = (data?.mothers || []).filter((m) => !q || `${m.name} ${m.username || ""}`.toLowerCase().includes(q));
  const groups = [
    { title: t("افراد"), items: list.filter((m) => !m.group) },
    { title: t("گروه‌ها"), items: list.filter((m) => m.group) },
  ].filter((g) => g.items.length);
  return (
    <div>
      {!data ? <p className="px-3 py-6 text-center text-sm text-muted-foreground">{t("در حال بارگذاری…")}</p> : null}
      {groups.map((g) => (
      <div key={g.title} className="mb-2">
      <p className="flex items-center px-3 pb-1 pt-2 text-[11px] font-medium text-muted-foreground"><span className="flex-1">{g.title}</span><span className="tabular-nums">{g.items.length}</span></p>
      <ul>
        {g.items.map((m) => (
          <li key={m.id}>
            <button
              type="button"
              onClick={() => { window.location.hash = `/telegram/${m.id}`; onNavigate?.(); }}
              className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-start ${m.id === activePersonId ? "bg-muted" : "hover:bg-muted/60"}`}
            >
              <span className={`size-1.5 shrink-0 rounded-full ${m.watch ? "bg-ok" : "bg-border"}`} title={m.watch ? t("واچر روشن") : t("واچر خاموش")} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm" dir="auto">{m.name}</span>
                <span className="block truncate text-[11px] text-muted-foreground" dir="auto">{m.lastDirection === "out" ? "↩ " : ""}{m.lastText}</span>
              </span>
              {m.running ? (
                <span className="agent-dots shrink-0 text-primary" aria-hidden><i /><i /><i /></span>
              ) : m.openThreads ? (
                <span className="shrink-0 rounded-full bg-primary/12 px-1.5 text-[11px] tabular-nums text-primary" title={t("رشته‌های باز")}>{m.openThreads}</span>
              ) : null}
            </button>
          </li>
        ))}
      </ul>
      </div>
      ))}
      {data && !list.length ? <p className="px-3 py-6 text-center text-sm text-muted-foreground">{t("پیامی نیست.")}</p> : null}
    </div>
  );
}
