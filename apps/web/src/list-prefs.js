// The list's sort, its direction and the filter are kept on the server (GET/PUT /api/list-prefs), like the
// grouping, so every device shows the same list. The browser keeps a copy so the list draws at once and
// still works when the server is unreachable.
import { useEffect, useRef, useState } from "react";
import { api } from "./api.js";
import { readSetting, writeSetting } from "./brand.js";

// What a choice becomes once the server has answered: the server's value wins; a server that has none yet
// takes over this browser's (so a choice made before the server kept it is not lost).
export function settleChoice({ server, local, initial, valid }) {
  if (valid(server)) return { value: server, push: false };
  if (valid(local) && local !== initial) return { value: local, push: true };
  return { value: valid(local) ? local : initial, push: false };
}

// One GET for the page; a failed one is retried by the next list that mounts.
let loading = null;
let loaded = null;
function serverPrefs() {
  if (loaded) return Promise.resolve(loaded);
  loading ||= api("/api/list-prefs").then(
    (prefs) => {
      loading = null;
      return (loaded = prefs || {});
    },
    () => {
      loading = null;
      return null;
    },
  );
  return loading;
}

function save(field, value) {
  if (loaded) loaded = { ...loaded, [field]: value };
  return api("/api/list-prefs", { method: "PUT", body: { [field]: value } }).catch(() => {});
}

export function useListChoice(field, localKey, initial, allowed) {
  const valid = (item) => allowed.some((entry) => entry.id === item);
  const [value, setValue] = useState(() => {
    const saved = readSetting(localKey, initial);
    return valid(saved) ? saved : initial;
  });
  const touched = useRef(false); // a pick made before the server answered must not be overwritten by it
  useEffect(() => {
    let alive = true;
    serverPrefs().then((prefs) => {
      if (!alive || !prefs || touched.current) return;
      const settled = settleChoice({ server: prefs[field], local: readSetting(localKey, initial), initial, valid });
      setValue(settled.value);
      writeSetting(localKey, settled.value);
      if (settled.push) save(field, settled.value);
    });
    return () => {
      alive = false;
    };
  }, []);
  const set = (next) => {
    touched.current = true;
    setValue(next);
    writeSetting(localKey, next);
    save(field, next);
  };
  return [value, set];
}

/**
 * The order the owner dragged the sections of each grouping into (by repository, agent, …; drag.js):
 * [{ [grouping]: [section keys] }, set(grouping, keys)]. Kept on the server like the rest.
 */
export function useSectionOrder() {
  const [orders, setOrders] = useState(() => loaded?.sectionOrder || {});
  useEffect(() => {
    let alive = true;
    serverPrefs().then((prefs) => alive && prefs?.sectionOrder && setOrders(prefs.sectionOrder));
    return () => {
      alive = false;
    };
  }, []);
  const set = (grouping, keys) => {
    const next = { ...orders, [grouping]: keys };
    setOrders(next);
    save("sectionOrder", { [grouping]: keys });
    if (loaded) loaded = { ...loaded, sectionOrder: next };
  };
  return [orders, set];
}
