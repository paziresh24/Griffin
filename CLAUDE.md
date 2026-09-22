# Griffin

- `npm ci && npm test && npm run build` before proposing a change.
- Never commit secrets: vault tokens, age identities, API keys, session strings, owner tokens.
- Nothing environment-specific belongs in the code. Clusters, routers, hosts, endpoints and buckets
  come from the site config (`config/site.example.json`); tests declare their own fixture site.
- Tool guards live in the broker (`apps/broker/src/`), not in prompt text. A prompt rule is a hint;
  the code is the control.
- Do not change a cluster PVC/PV, merge, or run any irreversible action on someone's infrastructure
  without the owner asking for it in the same breath.
