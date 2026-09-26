import { useEffect, useMemo, useRef, useState } from "react";
import { Popover } from "radix-ui";
import {
  AlarmClock, Radar, Archive, ArchiveRestore, ArrowDownAZ, ArrowUpDown, Bot, Check, ChevronDown, ChevronUp,
  Filter, FolderTree, LogOut, MessageCircle, MoreHorizontal, Pencil, Pin, PinOff, Search,
  Settings2, Users, X,
} from "lucide-react";
import { api, navigate } from "../api.js";
import { BRAND, agentMeta, readSetting, writeSetting } from "../brand.js";
import { textDir } from "../dir.js";
import { AgentGlyph, AgentPicker } from "./Controls.jsx";

const SORTS = [
  { id: "updated", label: "جدیدترین" },
  { id: "title", label: "نام (الفبا)" },
  { id: "running", label: "در حال اجرا اول" },
];

const GROUPS = [
  { id: "none", label: "بدون گروه‌بندی" },
  { id: "owner", label: "بر اساس صاحب" },
  { id: "agent", label: "بر اساس ایجنت" },
  { id: "status", label: "بر اساس وضعیت" },
];

const FILTERS = [
  { id: "all", label: "همه" },
  { id: "running", label: "در حال اجرا" },
  { id: "error", label: "دارای خطا" },
  { id: "pinned", label: "سنجاق‌شده" },
];

// Each tab lists only its own threads: «گفتگو» is what the owner started by hand; Telegram-born,
// peer, ops-room and job threads live under their tabs. Sub-agent chats never appear here — the
// parent chat shows them above the composer.
const SECTIONS = {
  manual: { page: null, label: "گفتگوهای اخیر" },
  telegram: { page: "telegram", label: "رشته‌های تلگرام" },
  peer: { page: "peers", label: "کارهای همتاها" },
  ops: { page: "incidents", label: "اتاق‌های عملیات" },
  job: { page: "jobs", label: "اجراهای جاب" },
};
const sectionOfPage = (page) => Object.keys(SECTIONS).find((k) => SECTIONS[k].page === page && page) || null;

export function Sidebar({ chats, archived, activeId, activeSource = null, page = null, agent, onAgentChange, agentLocked = false, onClose }) {
  const section = sectionOfPage(page) || (!page && activeSource && SECTIONS[activeSource] ? activeSource : "manual");
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [sort, setSort] = useState("updated");
  // Telegram and peer threads group by whose they are by default, so one person's threads can be
  // folded away while another's stay open.
  const [groupChoice, setGroupChoice] = useState({});
  const groupBy = groupChoice[section] || (section === "telegram" || section === "peer" ? "owner" : "none");
  const setGroupBy = (value) => setGroupChoice((g) => ({ ...g, [section]: value }));
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
  const searchRef = useRef(null);

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
      if (sort === "title") return String(a.title).localeCompare(String(b.title), "fa");
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
    if (groupBy === "owner") {
      const map = new Map();
      for (const chat of prepared) {
        const key = chat.ownerKey || "none";
        if (!map.has(key)) map.set(key, { key: `${section}:${key}`, title: chat.ownerLabel || "بدون صاحب", chats: [], collapsible: true });
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
        running.length ? { title: "در حال اجرا", chats: running } : null,
        errored.length ? { title: "خطا", chats: errored } : null,
        rest.length ? { title: "بقیه", chats: rest } : null,
      ].filter(Boolean);
    }
    const pinned = prepared.filter((c) => c.pinned);
    const rest = prepared.filter((c) => !c.pinned);
      return [
      pinned.length ? { title: "سنجاق‌شده", chats: pinned } : null,
      { title: null, chats: rest },
    ].filter((s) => s && s.chats.length);
  }, [prepared, groupBy, showArchived, section]);

  useEffect(() => {
    if (searchOpen) searchRef.current?.focus();
  }, [searchOpen]);

  const open = (id) => {
    navigate(id);
    onClose?.();
  };

  return (
    <aside className="flex h-full w-full flex-col bg-card">
      <div className="flex min-w-0 items-center gap-3 px-3 pb-3 pt-[max(env(safe-area-inset-top),0.85rem)]">
        <img src="/icon.svg" alt={BRAND.name} className="size-10 shrink-0 rounded-xl" title={BRAND.name} />
        <AgentPicker agent={agent} onChange={onAgentChange} locked={agentLocked} className="min-w-[11rem]" />
        {onClose ? (
          <button type="button" onClick={onClose} className="rounded-lg p-2 hover:bg-muted md:hidden" aria-label="بستن">
            <X className="size-5" />
          </button>
        ) : null}
      </div>

      <div className="mt-1 space-y-0.5 px-2">
        <NavButton active={section === "manual" && !page} icon={Bot} label="گفتگو" onClick={() => open(null)} />
        <NavButton active={section === "telegram"} icon={MessageCircle} label="تلگرام" onClick={() => { window.location.hash = "/telegram"; onClose?.(); }} />
        <NavButton active={section === "job"} icon={AlarmClock} label="جاب" onClick={() => { window.location.hash = "/jobs"; onClose?.(); }} />
        <NavButton active={section === "ops"} icon={Radar} label="حادثه‌ها" onClick={() => { window.location.hash = "/incidents"; onClose?.(); }} />
        <NavButton active={section === "peer"} icon={Users} label="همتاها" onClick={() => { window.location.hash = "/peers"; onClose?.(); }} />
      </div>

      <div className="my-4 flex items-center justify-center" aria-hidden>
        <span className="size-1 rounded-full bg-border" />
      </div>

      <div className="px-2">
        <div className="flex items-center gap-1 px-1">
          <h2 className="min-w-0 flex-1 truncate text-start text-xs font-medium text-muted-foreground">
            {showArchived ? "بایگانی" : SECTIONS[section].label}
          </h2>
          <div className="flex shrink-0 items-center gap-0.5">
            <IconToggle
              active={searchOpen || !!query}
              icon={Search}
              label="جستجو"
              onClick={() => setSearchOpen((v) => !v)}
            />
            <SortMenu sort={sort} groupBy={groupBy} onSort={setSort} onGroupBy={setGroupBy} />
            <FilterMenu filter={filter} onFilter={setFilter} />
          </div>
        </div>
        {searchOpen ? (
          <label className="mt-2 flex items-center gap-2 rounded-lg bg-muted px-2.5 py-1.5">
            <Search className="size-4 shrink-0 text-muted-foreground" />
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  if (!query) setSearchOpen(false);
                  else setQuery("");
                }
              }}
              placeholder="جستجوی گفتگوها"
              className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            />
            {query || searchOpen ? (
              <button
                type="button"
                className="rounded p-0.5 text-muted-foreground hover:bg-background"
                aria-label="بستن جستجو"
                onClick={() => { setQuery(""); setSearchOpen(false); }}
              >
                <X className="size-3.5" />
              </button>
            ) : null}
          </label>
        ) : null}
      </div>

      <nav className="scrollbar-thin mt-2 min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {sections.map((section) => (
          <Section
            key={section.key || section.title || "recent"}
            title={section.title}
            chats={section.chats}
            activeId={activeId}
            onOpen={open}
            collapsible={section.collapsible}
            collapsed={section.collapsible && collapsed[section.key] && !section.chats.some((c) => c.id === activeId)}
            onToggle={() => toggleGroup(section.key)}
          />
        ))}
        {!prepared.length ? <p className="px-3 py-6 text-center text-sm text-muted-foreground">گفتگویی نیست.</p> : null}
        {archivedHere.length > 0 || showArchived ? (
          <button
            type="button"
            onClick={() => setShowArchived(!showArchived)}
            className="mt-2 flex w-full items-center gap-2 rounded-lg px-3 py-2 text-xs text-muted-foreground hover:bg-muted"
          >
            <Archive className="size-3.5" />
            {showArchived ? "بازگشت" : `بایگانی (${archivedHere.length})`}
          </button>
        ) : null}
      </nav>

      <UserBar onNavigate={onClose} />
    </aside>
  );
}

function IconToggle({ active, icon: Icon, label, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-pressed={!!active}
      className={`press flex size-8 items-center justify-center rounded-lg ${
        active ? "bg-primary/12 text-primary" : "text-muted-foreground hover:bg-muted hover:text-foreground"
      }`}
    >
      <Icon className="size-4" />
    </button>
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
          title="مرتب‌سازی"
          aria-label="مرتب‌سازی"
          className={`press flex size-8 items-center justify-center rounded-lg ${
            active || open ? "bg-primary/12 text-primary" : "text-muted-foreground hover:bg-muted hover:text-foreground"
          }`}
        >
          <ArrowUpDown className="size-4" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="start" sideOffset={6} className="pop z-50 w-52 overflow-hidden rounded-xl border bg-card p-1 text-sm shadow-xl">
          <p className="px-2.5 py-1.5 text-[11px] font-medium text-muted-foreground">مرتب‌سازی</p>
          {SORTS.map((item) => (
            <MenuPick key={item.id} icon={item.id === "title" ? ArrowDownAZ : ArrowUpDown} label={item.label} selected={sort === item.id} onClick={() => { onSort(item.id); setOpen(false); }} />
          ))}
          <div className="my-1 border-t" />
          <p className="flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] font-medium text-muted-foreground">
            <FolderTree className="size-3" /> گروه‌بندی
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
          title="فیلتر"
          aria-label="فیلتر"
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
            aria-label="منوی کاربر"
          >
            <img src="/icon.svg" alt="" className="size-9 shrink-0 rounded-full" />
            <span className="min-w-0 flex-1 truncate text-sm font-medium">Owner</span>
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
            <MenuRow icon={Bot} label="ایجنت‌ها" onClick={() => go("/agents")} />
            <MenuRow icon={Settings2} label="تنظیمات" onClick={() => go("/settings")} />
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
      <button
        type="button"
        onClick={logout}
        className="press flex size-11 shrink-0 items-center justify-center rounded-xl text-muted-foreground hover:bg-muted hover:text-foreground"
        title="خروج"
        aria-label="خروج"
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

function Section({ title, chats, activeId, onOpen, collapsible = false, collapsed = false, onToggle }) {
  if (!chats.length) return null;
  return (
    <div className="mb-2">
      {collapsible ? (
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={!collapsed}
          className="flex w-full items-center gap-1.5 rounded-md px-3 pb-1 pt-2 text-[11px] font-medium text-muted-foreground hover:text-foreground"
        >
          <ChevronDown className={`size-3 shrink-0 transition-transform ${collapsed ? "-rotate-90 rtl:rotate-90" : ""}`} />
          <span className="min-w-0 flex-1 truncate text-start" dir="auto">{title}</span>
          <span className="shrink-0 tabular-nums">{chats.length}</span>
        </button>
      ) : title ? <p className="px-3 pb-1 pt-2 text-[11px] font-medium text-muted-foreground">{title}</p> : <div className="pt-1" />}
      {collapsed ? null : <ul>
        {chats.map((chat) => (
          <ChatItem key={chat.id} chat={chat} active={chat.id === activeId} onOpen={onOpen} />
        ))}
      </ul>}
    </div>
  );
}

function ChatItem({ chat, active, onOpen }) {
  const [menu, setMenu] = useState(false);
  const agents = chatAgents(chat);
  const patch = (body) => api(`/api/chats/${chat.id}`, { method: "PATCH", body }).catch(() => {});
  const rename = () => {
    setMenu(false);
    const title = window.prompt("عنوان جدید", chat.title);
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
            <span className="size-1.5 shrink-0 rounded-full bg-bad" title="خطا" />
          ) : null}
        </button>
        <button
          type="button"
          onClick={() => setMenu(!menu)}
          className="me-1 rounded p-1 text-muted-foreground opacity-100 hover:bg-background md:opacity-0 md:group-hover:opacity-100"
          aria-label="گزینه‌ها"
        >
          <MoreHorizontal className="size-4" />
        </button>
      </div>
      {menu ? (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setMenu(false)} />
          <div className="absolute end-2 top-9 z-20 w-40 overflow-hidden rounded-lg border bg-card text-sm shadow-lg">
            <ChatMenuItem icon={chat.pinned ? PinOff : Pin} onClick={() => { setMenu(false); patch({ pinned: !chat.pinned }); }}>
              {chat.pinned ? "برداشتن سنجاق" : "سنجاق"}
            </ChatMenuItem>
            <ChatMenuItem icon={Pencil} onClick={rename}>تغییر نام</ChatMenuItem>
            <ChatMenuItem icon={chat.archived ? ArchiveRestore : Archive} onClick={() => { setMenu(false); patch({ archived: !chat.archived }); }}>
              {chat.archived ? "خروج از بایگانی" : "بایگانی"}
            </ChatMenuItem>
          </div>
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
  const labels = shown.map((id) => agentMeta(id).label).join("، ");
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
