import { useState } from "react";
import { Megaphone, X } from "lucide-react";
import { usePolling } from "../api.js";
import { isMember } from "../auth-me.js";
import { t } from "../i18n.js";

// The maintainer's announcement to every install (server accounting.mjs KV_ANNOUNCEMENT): a bar across
// the top of every page until it expires, is taken back on the hub, or this browser closes it. Closing
// is per announcement: a new one shows again.
const SEEN = "griffin.announcement.closed";
const TONE = {
  info: "border-signal/30 bg-signal/10 text-foreground",
  warn: "border-amber-500/40 bg-amber-500/12 text-foreground",
  critical: "border-bad/40 bg-bad/12 text-foreground",
};
const ICON = { info: "text-signal", warn: "text-amber-600", critical: "text-bad" };

export function AnnouncementBar() {
  if (isMember()) return null;
  const data = usePolling("/api/announcement", 60_000);
  const [closed, setClosed] = useState(() => {
    try {
      return localStorage.getItem(SEEN) || "";
    } catch {
      return "";
    }
  });
  const a = data?.announcement;
  if (!a || a.id === closed) return null;
  const close = () => {
    try {
      localStorage.setItem(SEEN, a.id);
    } catch {}
    setClosed(a.id);
  };
  return (
    <div role="status" className={`flex shrink-0 items-start gap-2 border-b px-3 py-2 text-sm sm:px-4 ${TONE[a.level] || TONE.info}`}>
      <Megaphone className={`mt-0.5 size-4 shrink-0 ${ICON[a.level] || ICON.info}`} />
      <p dir="auto" className="min-w-0 flex-1 whitespace-pre-line leading-6">{a.text}</p>
      <button type="button" onClick={close} className="press shrink-0 rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground" aria-label={t("بستن اعلان")}>
        <X className="size-4" />
      </button>
    </div>
  );
}
