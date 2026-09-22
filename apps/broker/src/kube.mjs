import { gunzipSync } from "node:zlib";
import { shellQuote } from "./ssh.mjs";

// Clusters come from the site config (see site.mjs). Each one has a public API endpoint and,
// where one exists, an emergency SSH path straight to a node with kubectl. The emergency path is
// what keeps the agent useful when the API gateway or the SSO in front of it is down.
//
//   "clusters": {
//     "prod": { "api": "https://k8s.example.com",
//               "emergency": { "host": "203.0.113.10", "port": 22, "user": "root", "kubectl": "kubectl" } }
//   }
export const DEFAULT_CLUSTERS = {};

export const K8S_NAME = /^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/;

export class ToolInputError extends Error {}
class AuthError extends Error {}

export function createKube({ vault, sshRun, clusters = DEFAULT_CLUSTERS, fetchImpl = fetch, publicTimeoutMs = 8_000 }) {
  let authCache = null;

  function clusterConfig(name) {
    const known = Object.keys(clusters);
    if (!known.length) throw new ToolInputError("no clusters configured — add a \"clusters\" section to the site config");
    const config = clusters[name];
    if (!config) throw new ToolInputError(`unknown cluster "${name}" (known: ${known.join(", ")})`);
    return config;
  }

  async function authorization(cluster) {
    if (authCache && authCache.cluster === cluster && Date.now() < authCache.expires) return authCache.value;
    let stored;
    try {
      stored = await vault.item("kube__token");
    } catch (error) {
      throw new AuthError(error.message);
    }
    let credential;
    try {
      credential = JSON.parse(stored);
    } catch {
      return `Bearer ${stored}`;
    }
    if (credential?.type === "authentik-basic" && credential.username && credential.app_password) {
      return `Basic ${Buffer.from(`${credential.username}:${credential.app_password}`).toString("base64")}`;
    }
    const clientId = credential?.client_ids?.[cluster];
    if (credential?.type !== "authentik-m2m" || !credential.username || !credential.app_password || !clientId) {
      throw new AuthError("invalid Kubernetes credential in vault");
    }
    if (!credential.token_url) throw new AuthError("credential is missing token_url (the OIDC token endpoint)");
    const response = await fetchImpl(credential.token_url, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: clientId,
        username: credential.username,
        password: credential.app_password,
        scope: "openid profile email",
      }),
      redirect: "manual",
      signal: AbortSignal.timeout(publicTimeoutMs),
    });
    if (!response.ok) throw new AuthError(`Authentik token http_${response.status}`);
    const token = (await response.json())?.access_token;
    if (!token) throw new AuthError("Authentik token missing");
    authCache = { cluster, value: `Bearer ${token}`, expires: Date.now() + 4 * 60_000 };
    return authCache.value;
  }

  async function publicRequest(cluster, apiPath, { accept = "application/json" } = {}) {
    const { api } = clusterConfig(cluster);
    const response = await fetchImpl(`${api}${apiPath}`, {
      headers: { Authorization: await authorization(cluster), Accept: accept },
      redirect: "manual",
      signal: AbortSignal.timeout(publicTimeoutMs),
    });
    if ([301, 302, 401, 403].includes(response.status)) throw new AuthError(`gateway auth rejected http_${response.status}`);
    if (response.status === 404) return { notFound: true };
    if (!response.ok) throw new Error(`API http_${response.status}`);
    if (accept === "application/json") {
      if (!(response.headers.get("content-type") || "").includes("json")) throw new Error("API returned non-JSON");
      return { body: await response.json() };
    }
    return { body: await response.text() };
  }

  // Writes go only through the public API (authenticated, audited by the apiserver); never over SSH.
  async function publicWrite(cluster, apiPath, { method = "POST", body } = {}) {
    const { api } = clusterConfig(cluster);
    const response = await fetchImpl(`${api}${apiPath}`, {
      method,
      headers: { Authorization: await authorization(cluster), Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify(body),
      redirect: "manual",
      signal: AbortSignal.timeout(publicTimeoutMs),
    });
    if ([301, 302, 401, 403].includes(response.status)) throw new AuthError(`gateway auth rejected http_${response.status}`);
    const text = await response.text();
    if (!response.ok) {
      const error = new Error(`API http_${response.status}: ${text.slice(0, 300)}`);
      error.status = response.status;
      throw error;
    }
    return text ? JSON.parse(text) : null;
  }

  async function emergency(cluster, kubectlArgs, options) {
    const { emergency: target } = clusterConfig(cluster);
    if (!target) throw new Error(`no emergency SSH path is configured for ${cluster}`);
    // Full pod lists can be several MB of JSON; gzip on the node keeps the transfer small.
    const command = `${target.kubectl} ${kubectlArgs.map(shellQuote).join(" ")} | gzip -c`;
    const { stdout, stderr } = await sshRun(target, command, { ...options, binary: true });
    const text = stdout.length ? gunzipSync(stdout).toString("utf8") : "";
    // the pipe hides kubectl's exit code: empty output plus stderr means it failed
    if (!text.trim() && stderr.trim()) throw new Error(`kubectl on ${target.host}: ${stderr.trim().slice(-400)}`);
    return text;
  }

  // Tries the public API first, then the emergency path. Reports every attempt.
  async function withFallback(cluster, { viaApi, viaSsh }) {
    const config = clusterConfig(cluster);
    const attempts = [];
    if (viaApi) {
      try {
        const value = await viaApi();
        return { value, source: `public-api ${config.api}`, attempts: [...attempts, { path: "public-api", ok: true }] };
      } catch (error) {
        attempts.push({ path: "public-api", ok: false, error: errorText(error) });
      }
    }
    if (viaSsh && config.emergency) {
      try {
        const value = await viaSsh();
        const { host, port } = config.emergency;
        return { value, source: `emergency-ssh ${host}:${port}`, attempts: [...attempts, { path: "emergency-ssh", ok: true }] };
      } catch (error) {
        attempts.push({ path: "emergency-ssh", ok: false, error: errorText(error) });
      }
    } else if (viaSsh) {
      attempts.push({ path: "emergency-ssh", ok: false, error: `no emergency path configured for ${cluster}` });
    }
    const failure = new Error(`all paths failed for ${cluster}`);
    failure.attempts = attempts;
    throw failure;
  }

  return { clusterConfig, publicRequest, publicWrite, emergency, withFallback };
}

function errorText(error) {
  const text = String(error?.name === "TimeoutError" ? "timeout" : error?.message || error);
  return text.slice(0, 400);
}
