// The board's «باز کردن» on a chore: once the chat has drawn, bring the card that made it into view
// (Tool.jsx marks it data-chore / data-chore-title) and flash it. Polled, because the chat loads
// after the hash changes; gives up quietly after a few seconds.
export function choreCard(doc, { choreId, title }) {
  const cards = [...doc.querySelectorAll("[data-chore]")];
  return cards.find((el) => choreId && el.dataset.chore === choreId) || cards.reverse().find((el) => title && el.dataset.choreTitle === title) || null;
}

export function focusChore(item, { tries = 40, every = 150 } = {}) {
  let n = 0;
  const timer = setInterval(() => {
    const el = choreCard(document, item);
    if (!el && ++n < tries) return;
    clearInterval(timer);
    if (!el) return;
    const show = () => el.scrollIntoView({ block: "center" }); // instant: a long chat is a long smooth scroll
    show();
    setTimeout(show, 500); // the thread's own scroll-to-bottom can land after the first one
    el.classList.add("flash");
    setTimeout(() => el.classList.remove("flash"), 2400);
  }, every);
}
