// Small drawings of the app for Settings → «ظاهر» (owner 2026-11-01: «با جلوه‌های بصری و ویژوالایزیشن…»).
// Each scene takes the flags and draws that part of the page as they would have it, in the real colours
// (the theme's own tokens), so one drawing does three jobs: the live map at the top of the page, a tile
// of a choice (the same scene with that choice's flags), and the «؟» of a switch (with it off and on).
// Nothing here is real data; a size in em scales the whole drawing from `.g-mini`'s font size.
import { ArrowUp, Bell, ChevronDown, Clock, Grip, MessageCircle, MoreHorizontal, Pencil, Plus, Radar, RotateCcw, Undo2, UserRound, Zap, AlarmClock } from "lucide-react";
import { BRAND } from "../brand.js";
import { navStyleChoice } from "../ui-prefs.js";
import { homeChoice, updateChoice, workChoice } from "../settings-map.js";
import { t } from "../i18n.js";

const Line = ({ w = "100%", strong = false }) => <span className="g-mini-line" data-strong={strong || undefined} style={{ width: w }} />;

const SECTIONS = [
  { icon: MessageCircle, label: () => t("تلگرام") },
  { icon: AlarmClock, label: () => t("جاب") },
  { icon: Radar, label: () => t("حادثه‌ها") },
];
const CHATS = [
  { title: () => t("بررسی دیسک"), at: () => t("۱۴:۳۰"), ago: () => t("۵ دقیقه") },
  { title: () => t("گزارش فروش"), at: () => t("۱۲:۱۰"), ago: () => t("۲ ساعت") },
  { title: () => t("خطای ورود"), at: () => t("۰۹:۴۵"), ago: () => t("۱ روز") },
];

function ChatRow({ chat, flags, active = false }) {
  return (
    <span className="g-mini-row" data-active={active || undefined}>
      {flags.agentLogos ? <span className="g-mini-dot" data-brand="" /> : null}
      <span className="min-w-0 flex-1 truncate">{chat.title()}</span>
      <span className="g-mini-faint shrink-0">{flags.timeAgo ? chat.ago() : chat.at()}</span>
    </span>
  );
}

/** The chat list: where the sections sit, one list or per section, and what is at its foot. */
export function SidebarScene({ flags }) {
  const place = navStyleChoice(flags);
  const update = updateChoice(flags);
  return (
    <div className="g-mini-side">
      <div className="flex min-w-0 flex-1 flex-col gap-[0.35em]">
        <span className="flex items-center gap-[0.4em]">
          <span className="g-mini-dot" data-brand="" data-big="" />
          <b className="min-w-0 flex-1 truncate">{BRAND.name || t("گریفین")}</b>
          {place === "launcher" ? <Grip className="g-mini-ic" /> : null}
        </span>
        <span className="g-mini-new"><Plus className="g-mini-ic" />{t("جدید")}</span>
        {place === "list" ? SECTIONS.slice(0, 2).map(({ icon: Icon, label }, i) => <span key={i} className="g-mini-row"><Icon className="g-mini-ic" /><span className="truncate">{label()}</span></span>) : null}
        {place === "list" && flags.navMore ? <span className="g-mini-row g-mini-faint"><MoreHorizontal className="g-mini-ic" />{t("بیشتر")}</span> : null}
        {place === "icons" ? <span className="flex gap-[0.5em] px-[0.4em]">{SECTIONS.map(({ icon: Icon }, i) => <Icon key={i} className="g-mini-ic" />)}</span> : null}
        <span className="g-mini-rule" />
        {flags.oneList ? <span className="g-mini-faint">{t("سنجاق‌شده")}</span> : null}
        <ChatRow chat={CHATS[0]} flags={flags} active />
        {flags.oneList ? <span className="g-mini-faint">{t("اخیر")}</span> : null}
        <ChatRow chat={CHATS[1]} flags={flags} />
        <ChatRow chat={CHATS[2]} flags={flags} />
        <span className="mt-auto" />
        {update === "list" ? <span className="g-mini-row" data-primary=""><ArrowUp className="g-mini-ic" />{t("نسخهٔ تازه")}</span> : null}
        {flags.userMenu ? (
          <span className="g-mini-row"><UserRound className="g-mini-ic" /><span className="min-w-0 flex-1 truncate">{t("نام شما")}</span>{place === "menu" ? <ChevronDown className="g-mini-ic" /> : null}</span>
        ) : (
          <span className="flex gap-[0.4em]"><span className="g-mini-pill flex-1">{t("تنظیمات")}{update === "settings" ? <span className="g-mini-dot" data-warn="" /> : null}</span><span className="g-mini-pill">{t("خروج")}</span></span>
        )}
      </div>
      {place === "rail" ? (
        <span className="g-mini-rail">{SECTIONS.map(({ icon: Icon }, i) => <Icon key={i} className="g-mini-ic" />)}</span>
      ) : null}
    </div>
  );
}

function Work({ flags }) {
  const mode = workChoice(flags);
  if (mode === "inline") {
    return (
      <>
        <span className="g-mini-text">{t("الان لاگ‌ها را می‌بینم.")}</span>
        <span className="g-mini-work">{t("۳ دستور اجرا شد")}<ChevronDown className="g-mini-ic" /></span>
        <span className="g-mini-text">{t("علت پیدا شد.")}</span>
      </>
    );
  }
  return (
    <>
      <span className="g-mini-work"><Clock className="g-mini-ic" />{mode === "open" ? t("۴ ابزار · ۱ فکر") : t("در حال خواندن لاگ‌ها…")}<ChevronDown className="g-mini-ic" /></span>
      {mode === "open" ? <span className="g-mini-steps"><Line w="70%" /><Line w="55%" /><Line w="62%" /></span> : null}
    </>
  );
}

/** One exchange: the header, the question with its edit links, the work and the line under the answer. */
export function ChatScene({ flags }) {
  return (
    <div className="g-mini-chat">
      <span className="flex items-center gap-[0.4em]">
        <b className="min-w-0 flex-1 truncate">{t("بررسی دیسک")}</b>
        {flags.headerCounts ? <span className="g-mini-pill">{t("۱۲ هزار توکن")}</span> : null}
        {updateChoice(flags) === "top" ? <span className="g-mini-pill" data-primary=""><ArrowUp className="g-mini-ic" /></span> : null}
      </span>
      <span className="flex items-center gap-[0.3em] self-start">
        <span className="g-mini-bubble">{t("دیسک چرا پر شد؟")}</span>
        {flags.editLinks ? null : <><Pencil className="g-mini-ic g-mini-faint" /><RotateCcw className="g-mini-ic g-mini-faint" /></>}
      </span>
      {flags.editLinks ? <span className="g-mini-faint">{t("ویرایش · برگشت")}</span> : null}
      <Work flags={flags} />
      <Line w="92%" strong />
      <Line w="74%" strong />
      <span className="g-mini-faint">{flags.runFooterDetailed ? t("۱۴:۳۰ · Opus 5.5 · ۳۲ ثانیه · ۴ هزار توکن") : t("۱۴:۳۰ · Opus")}</span>
    </div>
  );
}

/** The new-chat page: one line and the box, or the work waiting for you. */
export function HomeScene({ flags }) {
  const mode = homeChoice(flags);
  if (mode === "simple") {
    return (
      <div className="g-mini-chat items-center justify-center">
        <b className="text-[1.25em]">{t("چه کاری انجام بدهم؟")}</b>
        <span className="g-mini-faint">{t("یک خط معرفی و کادر وسط صفحه")}</span>
      </div>
    );
  }
  return (
    <div className="g-mini-chat">
      <b>{t("منتظر شما")}</b>
      {mode === "one" ? (
        <span className="g-mini-row" data-primary=""><Bell className="g-mini-ic" /><span className="truncate">{t("۲ تأیید در گفتگوها")}</span></span>
      ) : (
        <>
          <span className="g-mini-card"><span className="truncate">{t("تأیید مرج")}</span><span className="g-mini-pill" data-primary="">{t("تأیید")}</span></span>
          <span className="g-mini-card"><span className="truncate">{t("سؤال ایجنت")}</span><span className="g-mini-pill">{t("جواب")}</span></span>
          <b>{t("در جریان")}</b>
          <span className="g-mini-card"><span className="truncate">{t("بررسی دیسک")}</span><Clock className="g-mini-ic" /></span>
        </>
      )}
    </div>
  );
}

/** The message box with everything that can sit around it. */
export function ComposerScene({ flags }) {
  const chips = flags.repoCapsule ? [t("کپسول"), "main"] : ["griffin", "main", "worktree"];
  return (
    <div className="g-mini-composer">
      {flags.scheduledPeek ? <span className="g-mini-row g-mini-note"><Clock className="g-mini-ic" /><span className="truncate">{t("یادآور ساعت ۱۷")}</span></span> : null}
      {flags.nextGhost ? null : <span className="g-mini-row g-mini-note"><Undo2 className="g-mini-ic" /><span className="truncate">{t("پیشنهاد: مرج کن")}</span></span>}
      {flags.repoChipsAlways ? <span className="flex flex-wrap gap-[0.3em]">{chips.map((chip) => <span key={chip} className="g-mini-pill">{chip}</span>)}</span> : null}
      <span className="g-mini-box">
        <span className="min-w-0 flex-1 truncate g-mini-faint">{flags.nextGhost ? t("مرج کن (Tab)") : t("پیام شما…")}</span>
        <span className="g-mini-send"><ArrowUp className="g-mini-ic" />{flags.laterButton ? <Clock className="g-mini-ic" /> : null}</span>
      </span>
      <span className="flex flex-wrap items-center gap-[0.3em]">
        {flags.modeSimple ? <><span className="g-mini-pill">Bypass</span><span className="g-mini-pill">Plan</span></> : <span className="g-mini-pill">{t("خودکار")}<ChevronDown className="g-mini-ic" /></span>}
        {flags.effortSimple ? <span className="g-mini-pill">{t("تلاش")}<ChevronDown className="g-mini-ic" /></span> : <span className="g-mini-slider"><span /></span>}
        <span className="g-mini-pill">{flags.modelLabels ? "Opus 5.5" : t("خودکار")}</span>
        {flags.fastChip ? <span className="g-mini-pill"><Zap className="g-mini-ic" /></span> : null}
        {flags.composerStats ? <span className="g-mini-ring" /> : null}
      </span>
      {flags.nonClaudeHint ? <span className="g-mini-faint">{t("ابزارها ممکن است کامل کار نکنند")}</span> : null}
    </div>
  );
}

/** The side chat: with its bar under the box, or plain. */
export function SideChatScene({ flags }) {
  return (
    <div className="g-mini-chat">
      <b>{t("چت کناری")}</b>
      <Line w="80%" />
      <span className="g-mini-box"><span className="flex-1 g-mini-faint">{t("پیام شما…")}</span><span className="g-mini-send"><ArrowUp className="g-mini-ic" /></span></span>
      {flags.sideChatSimple ? null : <span className="flex gap-[0.3em]"><span className="g-mini-pill">{t("مدل")}</span><span className="g-mini-pill">{t("بعداً")}</span></span>}
    </div>
  );
}

const SCENES = { sidebar: SidebarScene, chat: ChatScene, home: HomeScene, composer: ComposerScene, side: SideChatScene };

// The switches a scene can show; a flag with no picture keeps its words alone.
const DEMO = {
  oneList: "sidebar", userMenu: "sidebar", agentLogos: "sidebar", timeAgo: "sidebar", navMore: "sidebar",
  runFooterDetailed: "chat", editLinks: "chat", headerCounts: "chat", sideChatSimple: "side",
  modeSimple: "composer", effortSimple: "composer", fastChip: "composer", modelLabels: "composer", composerStats: "composer",
  repoChipsAlways: "composer", repoCapsule: "composer", scheduledPeek: "composer", laterButton: "composer", nonClaudeHint: "composer", nextGhost: "composer",
};

/** Inside a «؟»: the same drawing with the switch off and on, side by side when it is narrow. */
export function Compare({ flags, flagKey }) {
  const name = DEMO[flagKey];
  if (!name) return null;
  const Scene = SCENES[name];
  return (
    <div className={`grid gap-2 ${name === "sidebar" || name === "side" ? "grid-cols-2" : "grid-cols-1"}`} aria-hidden>
      {[false, true].map((on) => (
        <figure key={String(on)} className="g-mini g-mini-small m-0 overflow-hidden rounded-lg border">
          <Scene flags={{ ...flags, navStyle: name === "sidebar" && flagKey === "navMore" ? "list" : flags.navStyle, navIcons: name === "sidebar" && flagKey === "navMore" ? false : flags.navIcons, [flagKey]: on }} />
          <figcaption className="g-mini-caption">{on ? t("روشن") : t("خاموش")}</figcaption>
        </figure>
      ))}
    </div>
  );
}

/** A choice as tiles, each the drawing with that option's flags. */
export function SceneChoice({ label, value, options, scene, flags, onChange, wide = false }) {
  const Scene = SCENES[scene];
  return (
    <div role="radiogroup" aria-label={label} className={`grid gap-2 ${wide ? "grid-cols-1 sm:grid-cols-3" : "grid-cols-2 sm:grid-cols-5"}`}>
      {options.map((o) => {
        const active = value === o.id;
        return (
          <button key={o.id} type="button" role="radio" aria-checked={active} onClick={() => !active && onChange(o.id)} className={`flex flex-col overflow-hidden rounded-xl border text-start transition-shadow ${active ? "ring-2 ring-primary" : "hover:ring-1 hover:ring-primary/40"}`}>
            <span className="g-mini g-mini-small block flex-1" aria-hidden><Scene flags={{ ...flags, ...o.flags }} /></span>
            <span className="block border-t px-2 py-1.5 text-xs font-medium">{o.label}</span>
          </button>
        );
      })}
    </div>
  );
}

/** The map: the whole page in small, each part a place to tap; what is not picked steps back. */
export function MiniApp({ flags, zone, onZone }) {
  const part = (id, children, className = "") => (
    <div className={`g-mini-zone ${className}`} data-on={zone === id || undefined} data-rest={(zone !== id && zone !== "other" && zone !== "look") || undefined} onClick={() => onZone(id)}>
      {children}
    </div>
  );
  return (
    <div className="g-mini g-mini-app" aria-hidden>
      {part("sidebar", <SidebarScene flags={flags} />, "g-mini-app-side")}
      <div className="flex min-w-0 flex-1 flex-col">
        {zone === "home" ? part("home", <HomeScene flags={flags} />, "min-h-0 flex-1") : part("chat", <ChatScene flags={flags} />, "min-h-0 flex-1")}
        {part("composer", <ComposerScene flags={flags} />)}
      </div>
    </div>
  );
}
