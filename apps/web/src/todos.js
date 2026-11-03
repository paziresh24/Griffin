// A todo tool's list as an array. A model sometimes passes `todos` as a JSON string (a TodoWrite
// the session had disabled, 2026-10-30): anything that is not a list of steps reads as none.
export function todoList(value) {
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return [];
    }
  }
  return Array.isArray(value) ? value.filter((t) => t && typeof t === "object") : [];
}
