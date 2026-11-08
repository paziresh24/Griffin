import { useLayoutEffect } from "react";

// A textarea as tall as its text: it grows first and only scrolls past its CSS max-height (owner
// 2026-11-05: the reply and new-chat boxes scrolled while there was room to grow).
export function useAutosize(ref, value) {
  useLayoutEffect(() => {
    const box = ref.current;
    if (!box) return;
    box.style.height = "auto";
    box.style.height = `${box.scrollHeight + box.offsetHeight - box.clientHeight}px`;
  }, [ref, value]);
}
