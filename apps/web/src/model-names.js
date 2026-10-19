// A model's row in the model menu (Controls.jsx ModelPicker). The Karsara skin writes the version
// Claude Code's own menu shows («Opus 5.5», the server's `label`); Griffin's skin keeps `name`.
export const modelName = (m, karsara) => (karsara && m?.label) || m?.name || m?.id || "";

// The menu's search: what the row shows and the id — under the Karsara skin the version label too, so
// «5.5» finds «Sonnet 5.5»; Griffin's skin searches as before.
export const modelMatches = (m, needle, karsara = false) => !needle || `${m?.name || ""} ${karsara ? m?.label || "" : ""} ${m?.id || ""}`.toLowerCase().includes(needle);
