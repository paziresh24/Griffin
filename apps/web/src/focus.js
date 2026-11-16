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

// The sidebar's search opened this chat for words inside a message: once the chat has drawn, scroll to
// the newest place that holds them and paint them (CSS Custom Highlight, «search-hit» in styles.css;
// the DOM stays as React drew it). Arabic yeh/kaf match the Persian letters, one for one, so offsets in
// the folded text are offsets in the page. Polled like focusChore; gives up quietly.
const foldChar = (text) => String(text).toLowerCase().replace(/\u064A/g, "\u06CC").replace(/\u0643/g, "\u06A9");

// The whole phrase first (its places only); none, then each word of it.
export function findText(root, query) {
  const phrase = foldChar(query).replace(/\s+/g, " ").trim();
  const words = phrase.split(/[^\p{L}\p{N}]+/u).filter((w) => [...w].length >= 2);
  if (!root || !words.length) return [];
  const exact = [...phrase].length >= 2 ? rangesOf(root, [phrase]) : [];
  return exact.length ? exact : rangesOf(root, words);
}

function rangesOf(root, needles) {
  const doc = root.ownerDocument || document;
  const walker = doc.createTreeWalker(root, 4 /* NodeFilter.SHOW_TEXT */);
  const found = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = foldChar(node.nodeValue || "");
    for (const word of needles) {
      for (let at = text.indexOf(word); at >= 0; at = text.indexOf(word, at + word.length)) {
        const range = doc.createRange();
        range.setStart(node, at);
        range.setEnd(node, at + word.length);
        found.push(range);
      }
    }
  }
  return found;
}

export function focusText(query, { tries = 40, every = 150 } = {}) {
  let n = 0;
  const timer = setInterval(() => {
    // The messages only: not the title in the header, not the composer.
    const root = document.querySelector("[data-griffin-chat] [data-griffin-thread]");
    const ranges = findText(root, query);
    if (!ranges.length && ++n < tries) return;
    clearInterval(timer);
    if (!ranges.length) return;
    const last = ranges.at(-1);
    const target = last.startContainer.parentElement;
    const show = () => target?.scrollIntoView({ block: "center" });
    show();
    setTimeout(show, 500); // the thread's own scroll-to-bottom can land after the first one
    if (typeof CSS !== "undefined" && CSS.highlights && typeof Highlight === "function") {
      CSS.highlights.set("search-hit", new Highlight(...ranges));
      setTimeout(() => CSS.highlights.delete("search-hit"), 8000);
    }
  }, every);
}
