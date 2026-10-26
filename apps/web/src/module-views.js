import { lazy } from "react";

// The modules' own screens, found at build time (modules/<id>/web/<view>.jsx) and loaded only when
// opened. A page whose view is not in this build falls back to the shared list.
const files = import.meta.glob("../../../modules/*/web/*.jsx");
const views = new Map();
for (const [path, load] of Object.entries(files)) {
  const m = /modules\/([a-z0-9-]+)\/web\/([a-z0-9-]+)\.jsx$/.exec(path);
  if (m) views.set(`${m[1]}/${m[2]}`, lazy(load));
}

export const moduleView = (moduleId, view) => (view ? views.get(`${moduleId}/${view}`) || null : null);
