import { useEffect, useState } from "react";

// A long list on its first draw: the rows in sight now, the rest when the browser is idle. Mounting
// hundreds of rows at once held the page 100-300 ms on every move back to the chats. The open chat's row
// is always among the first.
const FIRST = 40;
export function useGradual(list, activeId = null) {
  const [all, setAll] = useState(list.length <= FIRST);
  useEffect(() => {
    if (all) return undefined;
    const idle = window.requestIdleCallback ? window.requestIdleCallback(() => setAll(true), { timeout: 500 }) : setTimeout(() => setAll(true), 100);
    return () => (window.cancelIdleCallback ? window.cancelIdleCallback(idle) : clearTimeout(idle));
  }, [all]);
  return all ? list : list.filter((row, i) => i < FIRST || row.id === activeId);
}
