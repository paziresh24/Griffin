// The private-share guest page polls; it tells the server what it holds (lastEventId + the cached
// timeline's revision), so an unchanged chat answers one line instead of the whole timeline.
export function pollQuery(last) {
  const have = last?.timeline?.lastEventId;
  if (!last?.rev || !Number.isFinite(have)) return "";
  return `?have=${have}&rev=${encodeURIComponent(last.rev)}`;
}

// A reply still being written is polled every 4 s; otherwise every 20 s.
export function pollDelay(timeline) {
  const running = Array.isArray(timeline?.messages) && timeline.messages.some((m) => m.role === "assistant" && m.status === "running");
  return running ? 4000 : 20000;
}
