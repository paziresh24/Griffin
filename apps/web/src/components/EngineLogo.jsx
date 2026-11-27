import { Cpu } from "lucide-react";
import { ENGINE_LOGOS } from "../engine-logos.js";

const sized = (svg) => svg.replace("<svg ", '<svg width="100%" height="100%" ');
const dataUrl = (svg) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
const IMG = Object.fromEntries(Object.entries(ENGINE_LOGOS).filter(([, l]) => l.kind === "color").map(([id, l]) => [id, dataUrl(sized(l.svg))]));

/** Which brand an engine account is: its plan, its vendor endpoint, its base URL, else its kind. */
export function engineLogoId(p) {
  if (!p) return null;
  if (p.plan) return p.plan; // codex | antigravity
  if (p.kind === "cursor") return "cursor";
  if (p.kind === "claude") return p.endpoint === "zai" ? "zai" : p.endpoint === "openrouter" ? "openrouter" : p.endpoint ? null : "claude";
  const url = String(p.baseUrl || "");
  if (/\bz\.ai\b|bigmodel\.cn/.test(url)) return "zai";
  if (/openrouter\.ai/.test(url)) return "openrouter";
  if (/api\.openai\.com/.test(url)) return "openai";
  if (/:11434\b|ollama/.test(url)) return "ollama";
  return null;
}

/** The vendor's own mark on a soft tile; an unknown service gets a plain chip icon. */
export function EngineLogo({ id, className = "size-10", bare = false }) {
  const logo = id ? ENGINE_LOGOS[id] : null;
  const tile = `inline-flex shrink-0 items-center justify-center ${bare ? "" : "rounded-xl bg-muted"} ${className}`;
  if (!logo) {
    return (
      <span className={`${tile} text-muted-foreground`} aria-hidden>
        <Cpu className="size-[55%]" />
      </span>
    );
  }
  return (
    <span className={`${tile} text-foreground`} aria-hidden>
      {logo.kind === "color" ? (
        <img src={IMG[id]} alt="" className={bare ? "size-full" : "size-[62%]"} draggable={false} />
      ) : (
        <span className={`block ${bare ? "size-full" : "size-[58%]"}`} dangerouslySetInnerHTML={{ __html: sized(logo.svg) }} />
      )}
    </span>
  );
}
