// A status colour must not follow the palette (under a grey palette everything turned grey, even
// the unread dot). The palette picker rewrites --primary/--accent/--brand only, so the unread
// dot, the queue badges and the running dots read --signal, which no palette sets.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const src = (path) => readFileSync(fileURLToPath(new URL(`../src/${path}`, import.meta.url)), "utf8");

test("--signal is defined in light and dark and never by the palette picker", () => {
  const css = src("styles.css");
  assert.equal((css.match(/^\s*--signal:/gm) || []).length, 4, "light + dark, and the Karsara look keeps its own blue in both");
  assert.doesNotMatch(src("components/BrandPicker.jsx"), /--signal/);
  assert.doesNotMatch(src("brand-presets.js"), /signal/);
});

test("the unread dots and badges use the signal colour, not the palette's primary", () => {
  const side = src("components/Sidebar.jsx");
  const dot = side.split("\n").find((line) => /title=\{?(?:t\()?"محتوای دیده‌نشده"/.test(line));
  assert.match(dot, /bg-signal/);
  assert.doesNotMatch(dot, /primary/);
  assert.match(src("karsara.css"), /\.kc-unread \{[^}]*var\(--signal\)/);
  assert.doesNotMatch(src("karsara.css"), /\.kc-unread \{[^}]*var\(--kc-accent\)/);
  assert.match(src("components/Board.jsx"), /\? "bg-signal"/);
});

test("running, count and usage states read the signal/ok colours, never the palette", () => {
  for (const [file, needle] of [
    ["components/Thread.jsx", "g-run-phase"],
    ["components/Telegram.jsx", "const Dots"],
    ["components/Health.jsx", "agent-dots"],
    ["components/Tool.jsx", "animate-pulse"],
    ["components/Work.jsx", "group-hover/work:bg-accent"],
  ]) {
    const line = src(file).split("\n").find((l) => l.includes(needle) && /signal|primary/.test(l));
    assert.ok(line, `${file}: ${needle}`);
    assert.match(line, /signal/, `${file} should use --signal`);
    assert.doesNotMatch(line.replace(/primary-foreground/g, ""), /(?:text|bg|border)-primary/, `${file} still follows the palette`);
  }
  assert.match(src("components/QueuePeek.jsx"), /animate-spin text-signal/);
  assert.match(src("components/Peers.jsx"), /pct >= 80 \? "bg-warn" : "bg-ok"/);
  assert.match(src("styles.css"), /--series-0: var\(--signal\)/);
});

test("the agent logos beside a chat are a flag, on in both presets", () => {
  // read as text: ui-prefs.js imports react, which the test run does not need to load
  const line = src("ui-prefs.js").split("\n").find((l) => l.includes('key: "agentLogos"'));
  assert.ok(line, "agentLogos flag");
  assert.match(line, /griffin: true, karsara: true/);
  assert.match(src("components/Sidebar.jsx"), /logos \? <ChatAgentGlyphs/);
  assert.match(src("components/Board.jsx"), /logos \? <AgentGlyph/);
});

test("the update notice in the sidebar is neutral grey, not a status or palette colour", () => {
  // One slim line (owner 2026-10-24: «مثل کلاد کد»), the sidebar's and the one in Settings.
  const lines = src("components/UpdateNotice.jsx").split("\n").filter((l) => l.includes("g-update mx-2") || l.includes("g-update mb-4"));
  assert.ok(lines.length >= 1, "the notice");
  assert.match(lines.join("\n"), /h-8/, "one line high in the sidebar");
  for (const line of lines) {
    assert.match(line, /bg-muted/);
    assert.doesNotMatch(line, /signal|(?:text|bg|border)-primary/);
  }
});
