import { useState } from "react";
import { Check, CircleHelp, Loader2, Send } from "lucide-react";
import { api, useRoute } from "../api.js";

// Card for the agent's ask_owner tool. While the tool call waits, the owner answers here and the
// run continues. If the run is already over, the same answer is sent as a follow-up message.
export function AskCard({ args = {}, result, isError, status }) {
  const chatId = useRoute();
  const options = Array.isArray(args.options) ? args.options.filter((o) => o?.label) : [];
  const waiting = status?.type === "running" || result === undefined;
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
    try {
      const response = await api(`/api/chats/${chatId}/answer`, {
        method: "POST",
        body: { question: args.question, selected: picks, text: text.trim() },
      });
      setSent(response.delivered === "tool" ? "tool" : response.delivered === "held" ? "held" : "message");
    } catch (caught) {
      setError(caught.message);
    } finally {
      setSending(false);
    }
  }

  const toggle = (label) =>
    setSelected((current) => (current.includes(label) ? current.filter((l) => l !== label) : [...current, label]));

  const closed = Boolean(answered) || sent;
  return (
    <div className={`my-2 rounded-lg border bg-card ${waiting && !closed ? "border-primary/60" : ""}`}>
      <div className="flex items-start gap-2 px-3 pt-2.5 text-sm">
        <CircleHelp className="mt-0.5 size-4 shrink-0 text-primary" />
        <p className="min-w-0 flex-1 font-medium" dir="auto">{args.question}</p>
      </div>

      {answered ? (
        <p className="flex items-center gap-2 px-3 pb-2.5 pt-1.5 text-sm text-muted-foreground" dir="auto">
          <Check className="size-4 shrink-0 text-ok" />
          {answered.answer}
        </p>
      ) : sent ? (
        <p className="px-3 pb-2.5 pt-1.5 text-sm text-muted-foreground">
          {sent === "tool" ? "پاسخ رسید؛ ادامه می‌دهد…" : sent === "held" ? "پاسخ ثبت شد؛ همین که ایجنت به این سؤال برسد، ادامه می‌دهد." : "کار قبلاً تمام شده بود؛ پاسخ به‌عنوان پیام جدید فرستاده شد."}
        </p>
      ) : (
        <div className="space-y-2 px-3 pb-3 pt-2">
          {!waiting ? (
            <p className="text-xs text-muted-foreground">
              {result?.answered === false || isError ? "این سؤال بی‌جواب ماند؛ اگر جواب بدهی، به‌عنوان پیام جدید می‌رود." : null}
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
                    className={`rounded-md border px-3 py-2 text-start text-sm transition-colors hover:bg-muted/60 ${
                      active ? "border-primary bg-primary/10" : ""
                    }`}
                  >
                    <span className="block font-medium" dir="auto">{option.label}</span>
                    {option.description ? (
                      <span className="block text-xs text-muted-foreground" dir="auto">{option.description}</span>
                    ) : null}
                  </button>
                );
              })}
            </div>
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
              placeholder={options.length ? "توضیح یا گزینهٔ دیگر…" : "پاسخ…"}
              dir="auto"
              className="min-w-0 flex-1 rounded-md border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
            />
            <button
              type="submit"
              disabled={sending || (!text.trim() && !selected.length)}
              className="flex size-9 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground disabled:opacity-40"
              aria-label="ارسال پاسخ"
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
