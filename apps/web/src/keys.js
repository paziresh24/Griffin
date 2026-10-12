// Esc stops the running turn, unless something else on screen owns that Esc: an open dialog or
// menu, the «/» list, or an IME still composing.
export function escCancels(event, { running = false, layerOpen = false, slashOpen = false } = {}) {
  if (event?.key !== "Escape" || event.defaultPrevented || event.isComposing) return false;
  // Typing in a field (the ask card's answer box, a search box): Esc is that field's, not Stop —
  // stopping there would cancel the very run waiting for the answer.
  if (event.target?.closest?.("input, textarea, select, [contenteditable=''], [contenteditable='true'], .quote-edit")) return false;
  return Boolean(running && !layerOpen && !slashOpen);
}
