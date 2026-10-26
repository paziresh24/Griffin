// Where the sections (تلگرام، جاب، حادثه‌ها، …) sit, one choice in Settings → «ظاهر» (ui-prefs.js navStyle;
// owner 2026-10-24 after a colleague's «اینا اینجا جاش نیست»: «همه حالات رو اضافه کن… برای بقیه به شکل فعلی بمونه»):
//   list     — rows under «جدید» (or one row of icons, flag navIcons): as before, the default.
//   launcher — one grid button in the sidebar's header; a section pinned there also gets its row.
//   rail     — a thin column of icons on the far edge of the screen, kept open or folded to a handle
//              that opens while the pointer is on it (a colleague's choice). On a phone the rows stay.
//   menu     — inside the user menu, and Ctrl/⌘+K finds one by name.
// The items, their order (dragged, drag.js) and the active one are the same in all of them.
import { useEffect, useRef, useState } from "react";
import { Dialog, Popover } from "radix-ui";
import { Command } from "cmdk";
import { AlarmClock, ChevronUp, Command as CommandIcon, Grip, MessageCircle, MessageSquare, PanelLeftClose, Pin, PinOff, Plus, Radar, Search, Settings2, Store, TerminalSquare, Users } from "lucide-react";
import { writeSetting } from "../brand.js";
import { orderNav } from "../drag.js";
import { moduleNavItems, sectionOn } from "../modules.js";
import { useModuleList, useModuleRoute } from "../module-hooks.js";
import { NAV_ITEMS, setUiPrefs, useUiPrefs } from "../ui-prefs.js";
import { isPlainClick } from "../sidebar-width.js";
import { navigate } from "../api.js";
import { MODULE_ICONS } from "./ModulePage.jsx";
import { useNavDrag } from "./SidebarDrag.jsx";
import { t } from "../i18n.js";

export const NAV_TARGETS = {
  telegram: { section: "telegram", icon: MessageCircle, path: "/telegram" },
  jobs: { section: "job", icon: AlarmClock, path: "/jobs" },
  incidents: { section: "ops", icon: Radar, path: "/incidents" },
  peers: { section: "peer", icon: Users, path: "/peers" },
  workbench: { section: "workbench", icon: TerminalSquare, path: "/workbench" },
};

/** The chosen place; anything unknown (an older or newer page's value) is the default list. */
export const navStyleOf = (flags) => (["launcher", "rail", "menu"].includes(flags?.navStyle) ? flags.navStyle : "list");

/** Every section that is on, in the dragged order, with what the owner hid and how to reorder. */
export function useSections() {
  const { flags } = useUiPrefs();
  const moduleRoute = useModuleRoute();
  const moduleList = useModuleList();
  // The pages modules add (modules/, docs/modules.md), after the core sections.
  const moduleItems = moduleNavItems(moduleList).map((i) => ({ ...i, icon: MODULE_ICONS[i.icon] || MODULE_ICONS.puzzle, section: `m:${i.module}:${i.page}` }));
  // The core sections are modules too (modules/telegram, …): one that is off here is not offered.
  const items = orderNav([...NAV_ITEMS.filter((item) => sectionOn(moduleList, item.id)).map((item) => ({ ...item, ...NAV_TARGETS[item.id] })), ...moduleItems], flags.navOrder);
  return {
    flags,
    items,
    ids: items.map((item) => item.id),
    hidden: flags.navHidden || [],
    moduleSection: moduleRoute ? `m:${moduleRoute.module}:${moduleRoute.page}` : null,
    reorder: (navOrder) => setUiPrefs({ flags: { navOrder } }),
  };
}

/** The section on screen, from the address, for the parts outside the sidebar (rail, menu). */
function useHashSection() {
  const read = () => {
    const hash = window.location.hash.replace(/^#/, "");
    return Object.values(NAV_TARGETS).find((t) => hash === t.path || hash.startsWith(`${t.path}/`))?.section || null;
  };
  const [section, setSection] = useState(read);
  useEffect(() => {
    const on = () => setSection(read());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return section;
}

const goTo = (path) => {
  window.location.hash = path;
};
export const openMarket = () => {
  writeSetting("griffin.settings.section", "market");
  goTo("/settings");
};

// A section as a drag handle and drop place: dropped on another, it takes that place (drag.js).
export function NavSlot({ id, ids, onOrder, horizontal = false, className = "", children }) {
  const drag = useNavDrag({ id, ids, onOrder, horizontal });
  return <div className={`g-drop rounded-lg ${horizontal ? "inline-flex" : ""} ${className}`} {...drag}>{children}</div>;
}

// A plain click stays in this tab; middle-click and Ctrl+click open another (a real link).
const linkClick = (path, onGo) => (event) => {
  if (!isPlainClick(event)) return;
  event.preventDefault();
  onGo(path);
};

/** A pinned section's row under «جدید» in the launcher layout: compact, with its own unpin on hover. */
export function PinnedRow({ item, active, onGo, onUnpin }) {
  const Icon = item.icon;
  return (
    <a
      href={`#${item.path}`}
      onClick={linkClick(item.path, onGo)}
      aria-current={active ? "page" : undefined}
      className={`g-sn-pinned g-nav-row flex w-full items-center gap-2.5 rounded-lg px-3 py-[5px] text-[13px] ${active ? "bg-primary/12 text-primary" : "text-foreground/80 hover:bg-muted/70 hover:text-foreground"}`}
    >
      <Icon className="size-[15px] shrink-0" />
      <span>{item.label}</span>
      <button
        type="button"
        className="g-sn-row-unpin"
        data-no-drag=""
        title={t("برداشتن سنجاق")}
        aria-label={`برداشتن سنجاق ${item.label}`}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onUnpin(item.id);
        }}
      >
        <PinOff className="size-[13px]" />
      </button>
    </a>
  );
}

/** «لانچر»: a grid button beside the agent picker; every section in it, each with a pin for its row under «جدید». */
export function NavLauncher({ go, activeSection }) {
  const [open, setOpen] = useState(false);
  const { items, ids, hidden, moduleSection, reorder } = useSections();
  const active = moduleSection || activeSection;
  const pick = (path) => {
    setOpen(false);
    go(path);
  };
  const pinnedCount = items.filter((i) => !hidden.includes(i.id)).length;
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button type="button" className="press flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground data-[state=open]:bg-muted data-[state=open]:text-foreground" aria-label={t("بخش‌ها")} title={t("بخش‌ها")}>
          <Grip className="size-4" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="end" sideOffset={8} collisionPadding={12} dir="rtl" className="g-sn-launcher pop z-50 rounded-xl border bg-card shadow-xl" aria-label={t("بخش‌ها")}>
          <div className="g-sn-pop-title">
            بخش‌ها
            <span className="hint"><Pin className="size-[11px]" /> {t("= همیشه زیر «جدید»")}</span>
          </div>
          <div className="g-sn-grid">
            {items.map((item) => {
              const Icon = item.icon;
              const pinned = !hidden.includes(item.id);
              return (
                <NavSlot key={item.id} id={item.id} ids={ids} onOrder={reorder} horizontal className="!flex">
                  <div className="g-sn-tile w-full" data-active={active === item.section ? "" : undefined}>
                    <a href={`#${item.path}`} onClick={linkClick(item.path, pick)} className="g-sn-tile-main" aria-current={active === item.section ? "page" : undefined}>
                      <span className="g-sn-tile-ic"><Icon className="size-5" /></span>
                      <span className="g-sn-tile-label">{item.label}</span>
                    </a>
                    <button
                      type="button"
                      className="g-sn-tile-pin"
                      data-no-drag=""
                      aria-pressed={pinned}
                      title={pinned ? t("برداشتن از زیر «جدید»") : t("سنجاق زیر «جدید»")}
                      aria-label={pinned ? `برداشتن ${item.label} از زیر «جدید»` : `سنجاق ${item.label} زیر «جدید»`}
                      onClick={() => setUiPrefs({ flags: { navHidden: pinned ? [...hidden, item.id] : hidden.filter((x) => x !== item.id) } })}
                    >
                      <Pin className="size-3" />
                    </button>
                  </div>
                </NavSlot>
              );
            })}
            <div className="g-sn-tile g-sn-tile-store">
              <button type="button" className="g-sn-tile-main" onClick={() => { setOpen(false); openMarket(); }}>
                <span className="g-sn-tile-ic"><Store className="size-5" /></span>
                <span className="g-sn-tile-label">{t("بازارچه")}<br />{t("بخش‌های بیشتر")}</span>
              </button>
            </div>
          </div>
          <div className="g-sn-pop-foot">{pinnedCount ? `${pinnedCount.toLocaleString("fa-IR")} بخش سنجاق شده` : t("هیچ بخشی سنجاق نشده؛ بالای فهرست فقط «جدید» است.")}</div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/**
 * «نوار کناری»: on a computer, a column of section icons on the far edge (the left, in Persian). Kept
 * open (railPinned) it takes 48px; folded it is a small tab in the middle of the edge that opens the
 * rail over the page while the pointer rests on it (or on a click) and folds when the pointer leaves.
 */
export function NavRail() {
  const { flags, items, ids, moduleSection, reorder } = useSections();
  const hashSection = useHashSection();
  const active = moduleSection || hashSection;
  const pinned = Boolean(flags.railPinned);
  const [peek, setPeek] = useState(false);
  const openTimer = useRef(null);
  const closeTimer = useRef(null);
  useEffect(() => () => {
    clearTimeout(openTimer.current);
    clearTimeout(closeTimer.current);
  }, []);
  // A rail opened over the page folds a moment after the pointer leaves it. Watched on the document:
  // it appears under a pointer that has not moved yet, so its own mouseleave may never fire.
  useEffect(() => {
    if (!peek) return undefined;
    const onMove = (event) => {
      const box = document.querySelector(".g-sn-rail[data-floating]")?.getBoundingClientRect();
      if (!box) return;
      const inside = event.clientX >= box.left - 4 && event.clientX <= box.right + 4 && event.clientY >= box.top && event.clientY <= box.bottom;
      if (inside) clearTimeout(closeTimer.current);
      else if (!closeTimer.current) closeTimer.current = setTimeout(() => {
        closeTimer.current = null;
        setPeek(false);
      }, 400);
    };
    document.addEventListener("mousemove", onMove);
    return () => {
      document.removeEventListener("mousemove", onMove);
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    };
  }, [peek]);
  if (navStyleOf(flags) !== "rail") return null;
  const go = (path) => {
    goTo(path);
    setPeek(false);
  };
  const rail = (floating) => (
    <nav aria-label={t("بخش‌ها")} className="g-sn-rail hidden md:flex" data-floating={floating ? "" : undefined}>
      <div className="g-sn-rail-group">
        {items.map((item) => {
          const Icon = item.icon;
          return (
            <NavSlot key={item.id} id={item.id} ids={ids} onOrder={reorder}>
              <a href={`#${item.path}`} onClick={linkClick(item.path, go)} aria-current={active === item.section ? "page" : undefined} aria-label={item.label} data-tip={item.label} className="g-sn-rail-btn g-sn-tip g-sn-tip-side">
                <Icon className="size-[18px]" />
              </a>
            </NavSlot>
          );
        })}
      </div>
      <div className="g-sn-rail-group g-sn-rail-foot">
        <button type="button" onClick={() => { setPeek(false); openMarket(); }} data-faint="" data-tip={t("بازارچه · بخش‌های بیشتر")} aria-label={t("بازارچه: بخش‌های بیشتر")} className="g-sn-rail-btn g-sn-tip g-sn-tip-side">
          <Store className="size-[18px]" />
        </button>
        <div className="g-sn-rail-sep" />
        <button
          type="button"
          onClick={() => {
            setUiPrefs({ flags: { railPinned: !pinned } });
            setPeek(false);
          }}
          data-tip={pinned ? t("جمع کردن نوار (با موس روی لبه باز می‌شود)") : t("ثابت نگه داشتن نوار")}
          aria-label={pinned ? t("جمع کردن نوار بخش‌ها") : t("ثابت نگه داشتن نوار بخش‌ها")}
          className={`g-sn-rail-btn g-sn-tip g-sn-tip-side ${pinned ? "" : "!text-primary"}`}
        >
          {pinned ? <PanelLeftClose className="size-[17px] rtl:-scale-x-100" /> : <Pin className="size-[17px]" />}
        </button>
      </div>
    </nav>
  );
  if (pinned) return rail(false);
  return (
    <>
      {peek ? null : (
        <button
          type="button"
          className="g-sn-rail-handle hidden md:grid"
          title={t("بخش‌ها (موس را نگه دارید یا کلیک کنید)")}
          aria-label={t("باز کردن نوار بخش‌ها")}
          onClick={() => setPeek(true)}
          onMouseEnter={() => {
            clearTimeout(openTimer.current);
            openTimer.current = setTimeout(() => setPeek(true), 150);
          }}
          onMouseLeave={() => clearTimeout(openTimer.current)}
        >
          <ChevronUp className="size-3 -rotate-90 rtl:rotate-90" />
        </button>
      )}
      {peek ? rail(true) : null}
    </>
  );
}

/** «داخل منوی کاربر»: the sections as menu rows under «بخش‌ها»; `onPick` closes the menu that holds them. */
export function SectionMenuItems({ onPick, rowClass, iconClass = "size-4 text-muted-foreground" }) {
  const { flags, items, moduleSection } = useSections();
  const hashSection = useHashSection();
  if (navStyleOf(flags) !== "menu") return null;
  const active = moduleSection || hashSection;
  return (
    <>
      <div className="g-sn-menu-label">{t("بخش‌ها")}</div>
      {items.map((item) => {
        const Icon = item.icon;
        return (
          <button key={item.id} type="button" className={`g-sn-menu-row ${rowClass}`} aria-current={active === item.section ? "page" : undefined} onClick={() => { onPick?.(); goTo(item.path); }}>
            <Icon className={iconClass} />
            <span>{item.label}</span>
          </button>
        );
      })}
      <button type="button" className={`${rowClass} !text-xs text-muted-foreground`} onClick={() => { onPick?.(); openMarket(); }}>
        <Store className="size-3.5 text-muted-foreground" />
        <span>{t("بازارچه · بخش‌های بیشتر")}</span>
      </button>
      <div className="my-1 border-t" />
    </>
  );
}

/** The last line of the user menu while the sections live there: Ctrl+K reaches them from anywhere. */
export function SectionMenuFoot() {
  const { flags } = useSections();
  if (navStyleOf(flags) !== "menu") return null;
  return (
    <div className="g-sn-menu-foot">
      <CommandIcon className="size-3" /> {t("از هر جا:")} <kbd className="g-sn-kbd">Ctrl K</kbd>
    </div>
  );
}

const PALETTE_EVENT = "griffin:sections-palette";
/** «Ctrl K» in the search box while the sections live in the user menu: opens the palette. */
export function PaletteKey() {
  const { flags } = useSections();
  if (navStyleOf(flags) !== "menu") return null;
  return (
    <button type="button" onClick={() => window.dispatchEvent(new Event(PALETTE_EVENT))} title={t("رفتن به هر بخش یا گفتگو")} aria-label={t("رفتن به هر بخش یا گفتگو")} className="flex shrink-0 items-center rounded-md px-1 py-0.5 hover:[&>kbd]:text-foreground">
      <kbd className="g-sn-kbd">Ctrl K</kbd>
    </button>
  );
}

/** Ctrl/⌘+K while the sections live in the user menu: a section, a chat (by title) or a command, by name. */
export function SectionsPalette({ chats = [], onNewChat = null }) {
  const { flags, items } = useSections();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const on = navStyleOf(flags) === "menu";
  useEffect(() => {
    if (!on) return undefined;
    const onKey = (event) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey || event.key.toLowerCase() !== "k") return;
      event.preventDefault();
      setOpen((v) => !v);
    };
    const onOpen = () => setOpen(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener(PALETTE_EVENT, onOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener(PALETTE_EVENT, onOpen);
    };
  }, [on]);
  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);
  if (!on) return null;
  const close = () => setOpen(false);
  const q = query.trim();
  const found = q ? chats.filter((c) => !c.sideOf && String(c.title || "").includes(q)).slice(0, 6) : [];
  const item = (key, value, Icon, label, kind, onSelect) => (
    <Command.Item key={key} value={value} onSelect={() => { close(); onSelect(); }} className="g-sn-palette-item">
      <Icon className="size-4" />
      <span className="min-w-0 truncate" dir="auto">{label}</span>
      <span className="kind">{kind}</span>
    </Command.Item>
  );
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className="overlay fixed inset-0 z-40 bg-black/30" />
        <Dialog.Content dir="rtl" className="g-sn-palette pop fixed left-1/2 top-[10vh] z-50 w-[min(35rem,calc(100vw-2rem))] -translate-x-1/2 overflow-hidden rounded-[14px] border bg-card shadow-2xl">
          <Dialog.Title className="sr-only">{t("رفتن به")}</Dialog.Title>
          <Command loop>
            <div className="g-sn-palette-input">
              <Search className="size-[18px] shrink-0 text-muted-foreground" />
              <Command.Input autoFocus value={query} onValueChange={setQuery} placeholder={t("برو به بخش، گفتگو یا کار…")} />
              <kbd className="g-sn-kbd">Esc</kbd>
            </div>
            <Command.List className="scrollbar-thin max-h-[380px] overflow-y-auto p-1.5">
              <Command.Empty className="px-3 py-5 text-center text-sm text-muted-foreground">{t("چیزی پیدا نشد")}</Command.Empty>
              <Command.Group heading={t("بخش‌ها")}>
                {items.map((s) => item(s.id, `بخش ${s.label}`, s.icon, s.label, t("بخش"), () => goTo(s.path)))}
                {item("market", t("بخش بازارچه"), Store, t("بازارچه"), t("بخش"), openMarket)}
              </Command.Group>
              {found.length ? (
                <Command.Group heading={t("گفتگوها")}>
                  {found.map((c) => item(`c:${c.id}`, `گفتگو ${c.title} ${c.id}`, MessageSquare, c.title, t("گفتگو"), () => navigate(c.id)))}
                </Command.Group>
              ) : null}
              <Command.Group heading={t("کارها")}>
                {item("new", t("کار گفتگوی جدید"), Plus, t("گفتگوی جدید"), t("کار"), () => (onNewChat ? onNewChat() : navigate(null)))}
                {item("settings", t("کار تنظیمات"), Settings2, t("تنظیمات"), t("کار"), () => goTo("/settings"))}
              </Command.Group>
            </Command.List>
            <div className="g-sn-palette-foot">
              <span><kbd className="g-sn-kbd">↑</kbd><kbd className="g-sn-kbd">↓</kbd> {t("انتخاب")}</span>
              <span><kbd className="g-sn-kbd">Enter</kbd> {t("باز کردن")}</span>
              <span><kbd className="g-sn-kbd">Esc</kbd> {t("بستن")}</span>
            </div>
          </Command>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
