import { useEffect, useState, useSyncExternalStore } from "react";
import { api } from "./api.js";
import { filterQuery, parseModuleRoute, translateManifest } from "./modules.js";

// The module hooks: what is on (fetched on page load, after a switch in the marketplace, and when the
// owner returns to the tab), the open module page, and a page's rows.

let cache = null;
const listeners = new Set();
let inflight = null;
function load() {
  if (inflight) return inflight;
  inflight = api("/api/modules")
    .then((data) => {
      // No module installed at all (the folder is missing in this build): there is no module system
      // to follow, so every section shows exactly as before.
      cache = data.installed === 0 ? null : translateManifest(data.modules || []);
      for (const l of listeners) l();
    })
    .catch(() => {
      // Could not read the list (server still starting, a network blip): leave it unknown. Unknown
      // shows every section; an empty list would have hidden them all.
      for (const l of listeners) l();
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** Fetch the list again (the marketplace switched something): the menu and pages follow at once. */
export const reloadModules = () => load();

/** The enabled modules (fetched once per page load; a module is switched on in config and a restart). */
export function useModuleList() {
  const modules = useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => cache,
  );
  useEffect(() => {
    if (cache === null) load();
    // A module switched on elsewhere (another tab, the API) reaches this open page when the owner
    // comes back to it, not only on the next page load.
    let last = Date.now();
    const again = () => {
      if (document.visibilityState === "hidden" || Date.now() - last < 15000) return;
      last = Date.now();
      load();
    };
    window.addEventListener("focus", again);
    document.addEventListener("visibilitychange", again);
    return () => {
      window.removeEventListener("focus", again);
      document.removeEventListener("visibilitychange", again);
    };
  }, []);
  return modules;
}

/** The same list, empty until it arrives. */
export const useModules = () => useModuleList() || [];

export function useModuleRoute() {
  const hash = useSyncExternalStore(
    (cb) => {
      window.addEventListener("hashchange", cb);
      return () => window.removeEventListener("hashchange", cb);
    },
    () => window.location.hash,
  );
  return parseModuleRoute(hash);
}

export function useModuleRows(moduleId, pageId, values, nonce = 0) {
  const [state, setState] = useState({ rows: null, error: null, loading: true });
  const query = filterQuery(values);
  useEffect(() => {
    let alive = true;
    setState((s) => ({ ...s, loading: true }));
    api(`/api/modules/${moduleId}/pages/${pageId}/data${query ? `?${query}` : ""}`).then(
      (r) => alive && setState({ rows: r.rows || [], meta: r.meta ?? null, error: null, loading: false }),
      (e) => alive && setState({ rows: null, meta: null, error: e.message, loading: false }),
    );
    return () => {
      alive = false;
    };
  }, [moduleId, pageId, query, nonce]);
  return state;
}
