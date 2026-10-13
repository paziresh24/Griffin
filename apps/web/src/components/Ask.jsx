import { useState } from "react";
import { Check, CircleHelp, Loader2, Send } from "lucide-react";
import { api, useRoute } from "../api.js";
import { num, t } from "../i18n.js";
import { holdReload } from "../new-version.js";

// Card for the agent's ask_owner tool. While the tool call waits, the owner answers here and the
// run continues. If the run is already over, the same answer is sent as a follow-up message.
// The home-page board passes chatId/askId itself: an answer with an id settles exactly that
// question, and a 409 means it was answered elsewhere (no follow-up message, no duplicate run).
export function AskCard({ args = {}, result, isError, status, chatId: chatIdProp = null, askId: askIdProp = null, onDone = null }) {
  const routeChat = useRoute();
  const chatId = chatIdProp || routeChat;
  const options = Array.isArray(args.options) ? args.options.filter((o) => o?.label) : [];
  const waiting = status?.type === "running" || result === undefined;
  const askId = askIdProp || (waiting ? args.askId || null : null);
  const answered = result?.answered ? result : null;
  const [selected, setSelected] = useState([]);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(null);
  const [error, setError] = useState(null);

  async function submit(choice) {
    const picks = choice ? [choice] : selected;
    if (!picks.length && !text.trim()) return;
    setSending(true);
    setError(null);
    const releaseReload = holdReload();
    try {
      const response = await api(`/api/chats/${chatId}/answer`, {
        method: "POST",
        body: { question: args.question, selected: picks, text: text.trim(), ...(askId ? { askId } : {}) },
      });
      setSent(response.delivered === "tool" ? "tool" : response.delivered === "held" ? "held" : "message");
      onDone?.();
    } catch (caught) {
      if (askId && caught.status === 409) {
        setSent("gone");
        onDone?.();
      } else setError(caught.message);
    } finally {
      releaseReload();
      setSending(false);
    }
  }

  const toggle = (label) =>
    setSelected((current) => (current.includes(label) ? current.filter((l) => l !== label) : [...current, label]));

  const closed = Boolean(answered) || sent;
  return (
    <div className={`g-box my-2 rounded-lg border bg-card ${waiting && !closed ? "border-primary/60" : ""}`}>
      <div className="flex items-start gap-2 px-3 pt-2.5 text-sm">
        <CircleHelp className="g-ask-icon mt-0.5 size-4 shrink-0 text-primary" />
        <p className="min-w-0 flex-1 font-medium" dir="auto">{args.question}</p>
      </div>

      {answered ? (
        <p className="flex items-center gap-2 px-3 pb-2.5 pt-1.5 text-sm text-muted-foreground" dir="auto">
          <Check className="g-ask-done size-4 shrink-0 text-ok" />
          {answered.answer}
        </p>
      ) : sent ? (
        <p className="px-3 pb-2.5 pt-1.5 text-sm text-muted-foreground">
          {sent === "gone"
            ? t("این سؤال دیگر باز نیست (جای دیگری جواب گرفت).")
            : sent === "tool" ? t("پاسخ رسید؛ ادامه می‌دهد…") : sent === "held" ? t("پاسخ ثبت شد؛ همین که ایجنت به این سؤال برسد، ادامه می‌دهد.") : t("کار قبلاً تمام شده بود؛ پاسخ به‌عنوان پیام جدید فرستاده شد.")}
        </p>
      ) : (
        <div className="space-y-2 px-3 pb-3 pt-2">
          {!waiting ? (
            <p className="text-xs text-muted-foreground">
              {result?.answered === false || isError ? t("این سؤال بی‌جواب ماند؛ اگر جواب بدهی، به‌عنوان پیام جدید می‌رود.") : null}
            </p>
          ) : null}
          {options.length ? (
            <div className="grid gap-1.5">
              {options.map((option) => {
                const active = selected.includes(option.label);
                return (
                  <button
                    key={option.label}
                    type="button"
                    disabled={sending}
                    onClick={() => (args.multiSelect ? toggle(option.label) : submit(option.label))}
                    aria-pressed={args.multiSelect ? active : undefined}
                    className={`min-w-0 rounded-md border px-3 py-2 text-start text-sm transition-colors pointer-coarse:min-h-11 ${
                      active ? "border-primary bg-primary/10 hover:bg-primary/15" : "hover:bg-muted/60"
                    }`}
                  >
                    <span className="flex items-start gap-2 font-medium" dir="auto">
                      {/* Multi-select: a checkbox on every option, so it reads as "pick several" before the first tap. */}
                      {args.multiSelect ? (
                        <span className={`mt-0.5 flex size-4 shrink-0 items-center justify-center rounded border ${active ? "border-primary bg-primary text-primary-foreground" : ""}`}>
                          {active ? <Check className="size-3" /> : null}
                        </span>
                      ) : null}
                      <span className="min-w-0 flex-1">{option.label}</span>
                    </span>
                    {option.description ? (
                      <span className="block text-xs text-muted-foreground" dir="auto">{option.description}</span>
                    ) : null}
                  </button>
                );
              })}
            </div>
          ) : null}
          {options.length > 0 && args.multiSelect ? (
            <p className="text-xs text-muted-foreground" aria-live="polite">
              {selected.length
                ? t("{n} گزینه انتخاب شد؛ برای فرستادن، دکمهٔ ارسال را بزن.", { n: num(selected.length) })
                : t("می‌توانی چند گزینه انتخاب کنی؛ بعد دکمهٔ ارسال را بزن.")}
            </p>
          ) : null}
          <form
            className="flex items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              submit();
            }}
          >
            <input
              value={text}
              onChange={(event) => setText(event.target.value)}
              placeholder={options.length ? t("توضیح یا گزینهٔ دیگر…") : t("پاسخ…")}
              dir="auto"
              className="g-input min-w-0 flex-1 rounded-md border bg-background px-3 py-2 text-sm outline-none focus:border-primary pointer-coarse:h-11"
            />
            <button
              type="submit"
              disabled={sending || (!text.trim() && !selected.length)}
              className="g-btn flex size-9 shrink-0 items-center !p-0 justify-center rounded-md bg-primary text-primary-foreground disabled:opacity-40 pointer-coarse:size-11"
              aria-label={t("ارسال پاسخ")}
            >
              {sending ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4 rtl:-scale-x-100" />}
            </button>
          </form>
          {error ? <p className="text-xs text-bad">{error}</p> : null}
        </div>
      )}
    </div>
  );
}
