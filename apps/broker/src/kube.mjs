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
// An emergency entry may name its own vault key ("keySlug"); a dedicated unprivileged node user with
// its own key is better than root with the owner's.
export const DEFAULT_CLUSTERS = {};

export const K8S_NAME = /^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/;

export class ToolInputError extends Error {}
class AuthError extends Error {}
// The gateway let the credential through and the apiserver's RBAC said no. That is the answer, not
// an outage: the emergency path runs as the same kind of identity, so it is not tried.
export class ForbiddenError extends Error {
  constructor(message) {
    super(message);
    this.forbidden = true;
  }
}

// A 403 is RBAC only when the apiserver wrote it (a Status object); the gateway's own 403 is HTML.
async function rejection(response) {
  if (response.status === 403 && (response.headers.get("content-type") || "").includes("json")) {
    const body = await response.json().catch(() => null);
    if (body?.kind === "Status") return new ForbiddenError(`forbidden: ${String(body.message || "RBAC denied").slice(0, 300)}`);
  }
  return new AuthError(`gateway auth rejected http_${response.status}`);
}

export function createKube({ vault, sshRun, clusters = DEFAULT_CLUSTERS, fetchImpl = fetch, publicTimeoutMs = 8_000, webSocketImpl = globalThis.WebSocket, homeNamespaceEnv = process.env.GRIFFIN_KUBE_NAMESPACE }) {
  let authCache = null;
  const homes = new Map(); // cluster -> { at, value: Promise<string|null> }

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
    if ([301, 302, 401, 403].includes(response.status)) throw await rejection(response);
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
    if ([301, 302, 401, 403].includes(response.status)) throw await rejection(response);
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

  // The one namespace a namespace-bound credential (a colleague's install) may read: GRIFFIN_KUBE_NAMESPACE,
  // else the credential's own username (owners' namespaces are named after them) once a
  // SelfSubjectAccessReview says it may list pods there. null for a cluster-wide credential's caller
  // who has no such namespace. Cached 10 minutes; never throws.
  function homeNamespace(cluster) {
    const hit = homes.get(cluster);
    if (hit && Date.now() - hit.at < 10 * 60_000) return hit.value;
    const value = (async () => {
      try {
        let candidate = homeNamespaceEnv && K8S_NAME.test(homeNamespaceEnv) ? homeNamespaceEnv : "";
        if (!candidate) {
          const review = await publicWrite(cluster, "/apis/authentication.k8s.io/v1/selfsubjectreviews", {
            body: { apiVersion: "authentication.k8s.io/v1", kind: "SelfSubjectReview" },
          });
          candidate = String(review?.status?.userInfo?.username || "");
          if (!K8S_NAME.test(candidate) || candidate.length > 63) return null;
        }
        const access = await publicWrite(cluster, "/apis/authorization.k8s.io/v1/selfsubjectaccessreviews", {
          body: { apiVersion: "authorization.k8s.io/v1", kind: "SelfSubjectAccessReview", spec: { resourceAttributes: { namespace: candidate, verb: "list", resource: "pods" } } },
        });
        return access?.status?.allowed ? candidate : null;
      } catch {
        return null;
      }
    })();
    homes.set(cluster, { at: Date.now(), value });
    return value;
  }

  // kubectl exec over the public API (websocket, v5/v4 channel protocol): the path a credential
  // without the emergency SSH key has. Resolves stdout; rejects with stderr when the command fails.
  async function apiExec(cluster, { namespace, pod, container, command, timeoutMs = 60_000, maxBytes = 4 * 1024 * 1024 }) {
    if (typeof webSocketImpl !== "function") throw new Error("this runtime has no WebSocket");
    const { api } = clusterConfig(cluster);
    const query = new URLSearchParams({ stdout: "true", stderr: "true", ...(container ? { container } : {}) });
    for (const part of command) query.append("command", part);
    const url = `${api.replace(/^http/, "ws")}/api/v1/namespaces/${namespace}/pods/${pod}/exec?${query}`;
    const authorizationHeader = await authorization(cluster);
    return new Promise((resolve, reject) => {
      const out = [];
      const err = [];
      let size = 0;
      let status = null;
      let settled = false;
      const ws = new webSocketImpl(url, { protocols: ["v5.channel.k8s.io", "v4.channel.k8s.io"], headers: { Authorization: authorizationHeader } });
      ws.binaryType = "arraybuffer";
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { ws.close(); } catch {}
        error ? reject(error) : resolve(value);
      };
      const timer = setTimeout(() => finish(Object.assign(new Error("timeout"), { name: "TimeoutError" })), timeoutMs);
      ws.onmessage = (message) => {
        const bytes = Buffer.from(message.data);
        if (!bytes.length) return;
        const data = bytes.subarray(1);
        if (bytes[0] === 1 || bytes[0] === 2) {
          size += data.length;
          if (size > maxBytes) return finish(new Error(`output over ${maxBytes} bytes`));
          (bytes[0] === 1 ? out : err).push(data);
        } else if (bytes[0] === 3) {
          try { status = JSON.parse(data.toString("utf8")); } catch { status = { status: "Failure", message: data.toString("utf8") }; }
        }
      };
      ws.onerror = (event) => finish(new Error(`exec websocket: ${event?.message || event?.error?.message || "connection failed (gateway or RBAC: pods/exec)"}`));
      ws.onclose = () => {
        const stdout = Buffer.concat(out).toString("utf8");
        const stderr = Buffer.concat(err).toString("utf8");
        if (status && status.status !== "Success") {
          return finish(new Error((stderr.trim() || String(status.message || "command failed")).slice(-400)));
        }
        if (!status && !stdout && !stderr) return finish(new Error("exec websocket closed without output (no pods/exec permission?)"));
        finish(null, stdout);
      };
    });
  }

  // A command inside a pod: emergency SSH first (as before), then the API exec.
  function exec(cluster, { namespace, pod, container, command, timeoutMs, maxBytes }) {
    const kubectlArgs = ["exec", "-n", namespace, pod, ...(container ? ["-c", container] : []), "--", ...command];
    return withFallback(cluster, {
      viaSsh: () => emergency(cluster, kubectlArgs, { ...(timeoutMs ? { timeoutMs } : {}), ...(maxBytes ? { maxBytes } : {}) }),
      viaApiExec: () => apiExec(cluster, { namespace, pod, container, command, timeoutMs, maxBytes }),
    });
  }

  // Tries the public API first, then the emergency path. Reports every attempt.
  // An RBAC refusal from the API ends it there (with the namespace this credential may read, if any).
  async function withFallback(cluster, { viaApi, viaSsh, viaApiExec }) {
    const config = clusterConfig(cluster);
    const attempts = [];
    if (viaApi) {
      try {
        const value = await viaApi();
        return { value, source: `public-api ${config.api}`, attempts: [...attempts, { path: "public-api", ok: true }] };
      } catch (error) {
        attempts.push({ path: "public-api", ok: false, error: errorText(error) });
        if (error?.forbidden) throw await forbidden(cluster, error, attempts);
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
    if (viaApiExec) {
      try {
        const value = await viaApiExec();
        return { value, source: `public-api exec ${config.api}`, attempts: [...attempts, { path: "public-api-exec", ok: true }] };
      } catch (error) {
        attempts.push({ path: "public-api-exec", ok: false, error: errorText(error) });
      }
    }
    const failure = new Error(`all paths failed for ${cluster}`);
    failure.attempts = attempts;
    throw failure;
  }

  async function forbidden(cluster, error, attempts) {
    const home = await homeNamespace(cluster);
    const hint = home ? ` — this credential may read namespace "${home}"; pass namespace: "${home}"` : "";
    const failure = new ForbiddenError(`${error.message}${hint}`);
    failure.attempts = attempts;
    failure.homeNamespace = home;
    return failure;
  }

  return { clusterConfig, publicRequest, publicWrite, emergency, withFallback, homeNamespace, apiExec, exec };
}

function errorText(error) {
  const text = String(error?.name === "TimeoutError" ? "timeout" : error?.message || error);
  return text.slice(0, 400);
}
