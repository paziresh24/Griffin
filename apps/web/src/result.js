// Tool results arrive in SDK shape. Custom (broker/app) tools return MCP content: the first text
// part is a JSON summary for the UI; later parts are for the model (the file's text, an image).
// Only the first JSON part is parsed; joining the parts would break the JSON.
export function unwrapResult(part) {
  if (part.status === "running") return { result: undefined, isError: false };
  if (part.status === "cancelled") return { result: { cancelled: true }, isError: false };
  const raw = part.result;
  if (!raw) return { result: null, isError: part.status !== "success" };
  if (raw.status === "error") return { result: { error: raw.error?.message || "error" }, isError: true };
  const value = raw.value ?? raw;
  if (Array.isArray(value?.content)) {
    const isError = Boolean(value.isError);
    // SDK delivers MCP text content as { text: { text } } (no "type"); tests/demo use { type, text }.
    const texts = value.content
      .map((c) => (typeof c.text === "string" ? c.text : typeof c.text?.text === "string" ? c.text.text : null))
      .filter((t) => t !== null);
    for (const [index, text] of texts.entries()) {
      try {
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === "object") {
          const extra = texts.filter((_, i) => i !== index).join("\n");
          return { result: extra ? { ...parsed, modelText: extra } : parsed, isError };
        }
      } catch {
        // not JSON; try the next part
      }
    }
    return { result: { text: texts.join("") }, isError };
  }
  return { result: value, isError: false };
}
