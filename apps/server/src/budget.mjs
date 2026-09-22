// Per-run tool-call budget for the custom tools. A model stuck in a loop must hit a wall in code,
// not in prompt text (seen 2026-09-20, ops room: 161× incident_update and 52× ask_agent in one
// run, 28 minutes, no decision). Identical calls are refused almost at once; a per-tool budget
// forces the model to stop, summarize what it has, or ask the owner. Counters reset when a new
// run starts (feed the chat's bus events to noteEvent). SDK built-ins (read/grep/glob/…) are not
// wrapped — this is for the custom (broker + app) tools only.

export function createToolBudget({ limit = 20, identicalLimit = 3 } = {}) {
  let counts = new Map(); // tool name -> calls in this run
  let seen = new Map(); // `${name}\0${args-key}` -> calls in this run

  return {
    // Feed the chat's events; a new run resets the counters.
    noteEvent(event) {
      if (event?.type === "run.started") {
        counts = new Map();
        seen = new Map();
      }
    },

    wrap(tools) {
      const out = {};
      for (const [name, tool] of Object.entries(tools || {})) {
        if (!tool || typeof tool.execute !== "function") {
          out[name] = tool;
          continue;
        }
        out[name] = {
          ...tool,
          async execute(args) {
            const n = (counts.get(name) || 0) + 1;
            counts.set(name, n);
            if (n > limit) {
              return {
                isError: true,
                content: [{
                  type: "text",
                  text: `سقف ابزار: «${name}» را ${n - 1} بار در همین run صدا زده‌ای. بایست: آنچه را تا حالا به دست آورده‌ای جمع‌بندی کن و جواب بده؛ اگر ادامهٔ واقعاً لازم است با ask_owner توضیح بده چرا. تکرار بی‌پایان ممنوع.`,
                }],
              };
            }
            const key = `${name}\u0000${safeKey(args)}`;
            const m = (seen.get(key) || 0) + 1;
            seen.set(key, m);
            if (m > identicalLimit) {
              return {
                isError: true,
                content: [{
                  type: "text",
                  text: `سقف ابزار: همین فراخوانِ «${name}» را عیناً ${m - 1} بار زده‌ای و نتیجه‌اش را داری — همان را استفاده کن، دوباره نزن.`,
                }],
              };
            }
            return tool.execute(args);
          },
        };
      }
      return out;
    },
  };
}

function safeKey(args) {
  try {
    return JSON.stringify(args ?? {});
  } catch {
    return String(args);
  }
}
