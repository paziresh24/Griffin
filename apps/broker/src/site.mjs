import fs from "node:fs";
import { genv } from "./env.mjs";

// Everything site-specific lives in one JSON file so this repo carries no environment of its own.
// Point GRIFFIN_SITE_CONFIG at your copy (config/site.example.json is the shape); every section is
// optional and a tool whose section is missing says so instead of guessing an endpoint.
//
//   { "clusters": { "<name>": { "api": "https://…", "emergency": { host, port, user, kubectl },
//                               "grafana": "https://…", "alerts": true } },
//     "defaultCluster": "<name>",
//     "gitlab": { "url": "https://gitlab.example.com" },
//     "s3": { "cluster", "endpoint", "region", "secret": { namespace, name } },
//     "routers": { "<name>": { … see mikrotik.mjs … } },
//     "debugHosts": { "<name>": { host, port, user } },
//     "sshKnownHosts": "/config/ssh_known_hosts" }

export const EMPTY_SITE = Object.freeze({ clusters: {}, routers: {}, debugHosts: {} });

export function loadSite({ file = genv("SITE_CONFIG", "/config/site.json"), log = console } = {}) {
  if (!file) return { ...EMPTY_SITE };
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    log?.info?.(`[broker] no site config at ${file}; site tools stay unconfigured`);
    return { ...EMPTY_SITE };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`site config ${file} is not valid JSON: ${error.message}`);
  }
  return {
    ...EMPTY_SITE,
    ...parsed,
    clusters: parsed.clusters || {},
    routers: parsed.routers || {},
    debugHosts: parsed.debugHosts || {},
  };
}

// The cluster a tool falls back to when the caller did not name one.
export function defaultCluster(site) {
  return site?.defaultCluster || Object.keys(site?.clusters || {})[0] || null;
}
