import { t } from "./i18n.js";

// «{name}» placeholders in a server's text filled from its vars (setup checks, doctor findings).
// Its own module so the chat view uses it without loading the setup wizard.
export const fill = (text, vars) => String(text).replace(/\{(\w+)\}/g, (m, k) => (vars && k in vars ? String(vars[k]) : m));

// Translates a text and its string values (the wizard passes labels as values).
export const tr = (text, vars) => t(text, vars && Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, typeof v === "string" ? t(v) : v])));
