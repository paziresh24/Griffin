# AGENTS.md

Same rules as `CLAUDE.md` — read it. In short:

- `npm ci && npm test && npm run build` before proposing a change.
- No secrets in the repo, no environment-specific values in the code (see `config/site.example.json`).
- Guards belong in `apps/broker/src/`, not in prompt text.
- In chat answers, wrap right-to-left paragraphs in `<div dir="rtl">…</div>` so mixed
  Persian/English sentences do not break; code blocks and tables stay LTR.
