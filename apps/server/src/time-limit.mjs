// A call that may hang (an engine's health or model list behind a filtered network) answered within
// `ms`: past it, `fallback()` is the answer and the slow call is left to finish on its own. Settings
// → «موتورها» waited on these with no limit and spun for more than 20 s (2026-10-15).
export function withinTime(promise, ms, fallback) {
  let timer;
  const late = new Promise((resolve) => {
    timer = setTimeout(() => resolve(fallback()), ms);
  });
  return Promise.race([Promise.resolve(promise), late]).finally(() => clearTimeout(timer));
}
