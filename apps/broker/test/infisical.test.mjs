import test from "node:test";
import assert from "node:assert/strict";
import { createInfisicalTools } from "../src/infisical.mjs";

function setup({ items = {}, existing = new Set() } = {}) {
  const vault = { item: async (slug) => (slug in items ? items[slug] : (() => { throw new Error("not found"); })()) };
  const calls = [];
  const store = { HAMI_DB_PASSWORD: existing.has("HAMI_DB_PASSWORD") ? "old" : undefined };
  const projects = [];
  const fetchImpl = async (url, init) => {
    const u = new URL(url);
    calls.push({ path: u.pathname, method: init.method, body: init.body ? JSON.parse(init.body) : null, query: Object.fromEntries(u.searchParams) });
    if (u.pathname === "/api/v1/auth/universal-auth/login") {
      const b = JSON.parse(init.body);
      if (b.clientSecret !== "sekret") return Response.json({ message: "invalid" }, { status: 401 });
      return Response.json({ accessToken: "AT", expiresIn: 3600 });
    }
    const name = decodeURIComponent(u.pathname.split("/").pop());
    if (u.pathname.startsWith("/api/v3/secrets/raw/")) {
      if (init.method === "PATCH") return store[name] === undefined ? Response.json({ message: "not found" }, { status: 404 }) : (store[name] = JSON.parse(init.body).secretValue, Response.json({ secret: { secretKey: name } }));
      if (init.method === "POST") { store[name] = JSON.parse(init.body).secretValue; return Response.json({ secret: { secretKey: name } }); }
      return store[name] === undefined ? Response.json({ message: "not found" }, { status: 404 }) : Response.json({ secret: { secretKey: name, secretValue: store[name] } });
    }
    if (u.pathname === "/api/v3/secrets/raw") return Response.json({ secrets: Object.entries(store).filter(([, v]) => v !== undefined).map(([k]) => ({ secretKey: k })) });
    if (u.pathname === "/api/v1/folders") return Response.json({ folders: [{ name: "hami" }] });
    if (u.pathname === "/api/v1/workspace") return Response.json({ workspaces: [{ id: "P1", name: "acme-ops", environments: [{ slug: "prod" }] }, ...projects] });
    if (u.pathname === "/api/v2/workspace" && init.method === "POST") {
      const made = { id: `P${projects.length + 2}`, name: JSON.parse(init.body).projectName, environments: [{ slug: "dev" }, { slug: "prod" }] };
      projects.push(made);
      return Response.json({ project: made });
    }
    return Response.json({ message: "nope" }, { status: 404 });
  };
  return { tools: createInfisicalTools({ vault, fetchImpl }), calls, store };
}

const cfg = JSON.stringify({ host: "https://secrets.example.com", clientId: "id", clientSecret: "sekret", projectId: "acme-ops" });
const parse = (r) => JSON.parse(r.content ? r.content[0].text : JSON.stringify(r));

test("upsert creates then updates; login cached; value never in result", async () => {
  const { tools, calls } = setup({ items: { "infisical__universal-auth": cfg } });
  const created = await tools.infisical_upsert.execute({ name: "HAMI_DB_PASSWORD", value: "s3cr3t", path: "/hami", comment: "rotated" });
  assert.equal(created.action, "created");
  assert.equal(created.project, "P1");
  assert.match(created.consoleUrl, /\/project\/P1\/secrets\/prod$/);
  assert.equal(JSON.stringify(created).includes("s3cr3t"), false, "value not echoed");
  const post = calls.find((c) => c.method === "POST" && c.path.endsWith("/HAMI_DB_PASSWORD"));
  assert.equal(post.body.secretValue, "s3cr3t");
  assert.equal(post.body.secretPath, "/hami");

  const again = await tools.infisical_upsert.execute({ name: "HAMI_DB_PASSWORD", value: "n3w" });
  assert.equal(again.action, "updated");
  assert.equal(calls.filter((c) => c.path.endsWith("/universal-auth/login")).length, 1, "token cached across calls");
});

test("get returns the value; list omits values", async () => {
  const { tools } = setup({ items: { "infisical__universal-auth": cfg }, existing: new Set(["HAMI_DB_PASSWORD"]) });
  assert.equal((await tools.infisical_get.execute({ name: "HAMI_DB_PASSWORD" })).value, "old");
  const list = await tools.infisical_list.execute({ path: "/" });
  assert.deepEqual(list.folders, ["hami"]);
  assert.ok(list.secrets.includes("HAMI_DB_PASSWORD"));
  assert.equal(JSON.stringify(list).includes("\"old\""), false); // "folders" contains the substring "old"
});

test("clear errors when not configured or misconfigured", async () => {
  const missing = setup({ items: {} });
  await assert.rejects(missing.tools.infisical_list.execute({}), /not connected/);
  const noProject = setup({ items: { "infisical__universal-auth": JSON.stringify({ clientId: "i", clientSecret: "sekret" }) } });
  await assert.rejects(noProject.tools.infisical_upsert.execute({ name: "X", value: "y" }), /projectId is required/);
  await assert.rejects(missing.tools.infisical_upsert.execute({ name: "bad name!", value: "y" }).catch((e) => { throw e; }), /not connected/);
});

test("create_project makes one per person, is create-only, and refuses odd names", async () => {
  const { tools, calls } = setup({ items: { "infisical__universal-auth": cfg } });
  const made = await tools.infisical_create_project.execute({ name: "reza-nouri" });
  assert.equal(made.action, "created");
  assert.equal(made.name, "reza-nouri");
  assert.ok(made.projectId);
  assert.ok(made.environments.includes("prod"));

  // Calling again finds the existing one instead of creating a second.
  const again = await tools.infisical_create_project.execute({ name: "reza-nouri" });
  assert.equal(again.action, "exists");
  assert.equal(again.projectId, made.projectId);
  assert.equal(calls.filter((c) => c.path === "/api/v2/workspace" && c.method === "POST").length, 1);

  await assert.rejects(() => tools.infisical_create_project.execute({ name: "Nouri Project" }), /invalid project name/);
  await assert.rejects(() => tools.infisical_create_project.execute({ name: "../etc" }), /invalid project name/);
});

// Finding where a credential lives used to mean listing folders one at a time — a live run burned
// its whole per-run tool budget walking ~80 folders and never found the one it needed.
function treeSetup() {
  const tree = {
    "/": ["ROOT_KEY"],
    "/infrastructure": [],
    "/infrastructure/edge": ["ESXI_YZD04_HOST"],
    "/cursor-local": [],
    "/cursor-local/mt-office": ["MT_HOST", "MT_USER", "MT_PASS"],
    "/cursor-local/arvan-api": ["VALUE"],
  };
  const kids = (path) =>
    Object.keys(tree)
      .filter((p) => p !== path && p.startsWith(path === "/" ? "/" : `${path}/`))
      .map((p) => p.slice(path === "/" ? 1 : path.length + 1))
      .filter((rest) => rest && !rest.includes("/"));
  const vault = { item: async () => cfg };
  const fetchImpl = async (url, init) => {
    const u = new URL(url);
    if (u.pathname === "/api/v1/auth/universal-auth/login") return Response.json({ accessToken: "AT", expiresIn: 3600 });
    const path = u.searchParams.get("secretPath") || u.searchParams.get("path") || "/";
    if (u.pathname === "/api/v3/secrets/raw") return Response.json({ secrets: (tree[path] || []).map((k) => ({ secretKey: k })) });
    if (u.pathname === "/api/v1/folders") return Response.json({ folders: kids(path).map((name) => ({ name })) });
    if (u.pathname === "/api/v1/workspace") return Response.json({ workspaces: [{ id: "P1", name: "acme-ops", environments: [{ slug: "prod" }] }] });
    return Response.json({ message: "nope" }, { status: 404 });
  };
  return createInfisicalTools({ vault, fetchImpl });
}

test("list can search the whole project recursively, and still never returns a value", async () => {
  const tools = treeSetup();
  const found = await tools.infisical_list.execute({ search: "MT_" });
  assert.deepEqual(
    found.matches.map((m) => `${m.path}:${m.name}`).sort(),
    ["/cursor-local/mt-office:MT_HOST", "/cursor-local/mt-office:MT_PASS", "/cursor-local/mt-office:MT_USER"],
  );
  assert.ok(found.foldersScanned >= 5, "it walked the tree in one call");
  assert.equal(found.truncated, false);
  assert.equal(JSON.stringify(found).includes("secretValue"), false);

  // A folder name matches too, so "where is the office router?" finds it.
  const byFolder = await tools.infisical_list.execute({ search: "mt-office" });
  assert.equal(byFolder.matches.length, 3);
  assert.deepEqual(byFolder.folders, ["/cursor-local/mt-office"]);

  // Plain listing is unchanged.
  const flat = await tools.infisical_list.execute({ path: "/cursor-local/mt-office" });
  assert.deepEqual(flat.secrets, ["MT_HOST", "MT_USER", "MT_PASS"]);
  assert.equal(flat.matches, undefined);
});

// Writing a credential to a path that does not exist yet used to fail and leave the secret at the
// project root — exactly what happened while issuing a VPN account into /vpn.
test("upsert creates the folder when the path does not exist yet", async () => {
  const folders = { "/": [] };
  const stored = [];
  const vault = { item: async () => cfg };
  const fetchImpl = async (url, init) => {
    const u = new URL(url);
    const path = u.searchParams.get("secretPath") || u.searchParams.get("path") || (init.body ? JSON.parse(init.body).secretPath || JSON.parse(init.body).path : "/") || "/";
    if (u.pathname === "/api/v1/auth/universal-auth/login") return Response.json({ accessToken: "AT", expiresIn: 3600 });
    if (u.pathname === "/api/v1/workspace") return Response.json({ workspaces: [{ id: "P1", name: "ops-team", environments: [{ slug: "prod" }] }] });
    if (u.pathname === "/api/v1/folders" && init.method === "POST") {
      const body = JSON.parse(init.body);
      folders[body.path] = [...(folders[body.path] || []), body.name];
      folders[body.path === "/" ? `/${body.name}` : `${body.path}/${body.name}`] = [];
      return Response.json({ folder: { name: body.name } });
    }
    if (u.pathname === "/api/v1/folders") return Response.json({ folders: (folders[path] || []).map((name) => ({ name })) });
    if (u.pathname.startsWith("/api/v3/secrets/raw/")) {
      const body = JSON.parse(init.body);
      if (folders[body.secretPath] === undefined) return Response.json({ message: "folder not found" }, { status: 404 });
      if (init.method === "POST") {
        stored.push(body.secretPath);
        return Response.json({ secret: { secretKey: "X" } });
      }
      return Response.json({ message: "not found" }, { status: 404 });
    }
    return Response.json({ message: "nope" }, { status: 404 });
  };
  const tools = createInfisicalTools({ vault, fetchImpl });
  const out = await tools.infisical_upsert.execute({ name: "VPN_PASSWORD", value: "x", path: "/vpn", projectId: "ops-team" });
  assert.equal(out.action, "created");
  assert.equal(out.path, "/vpn");
  assert.deepEqual(stored, ["/vpn"], "it landed in the folder, not at the root");
  assert.deepEqual(folders["/"], ["vpn"], "the folder was created on the way");
});

// A folder-create failure must surface, not vanish: swallowed errors turned into un-actionable
// "Folder not found" dead ends (ticket 802798) with no hint of the real cause.
test("upsert reports the folder failure when the write still fails", async () => {
  const vault = { item: async () => cfg };
  const fetchImpl = async (url, init) => {
    const u = new URL(url);
    if (u.pathname === "/api/v1/auth/universal-auth/login") return Response.json({ accessToken: "AT", expiresIn: 3600 });
    if (u.pathname === "/api/v1/workspace") return Response.json({ workspaces: [{ id: "P1", name: "ops-team", environments: [{ slug: "prod" }] }] });
    if (u.pathname === "/api/v1/folders") return Response.json({ message: "not allowed by role" }, { status: 403 });
    if (u.pathname.startsWith("/api/v3/secrets/raw/")) return Response.json({ message: "Folder with path '/x' not found" }, { status: 404 });
    return Response.json({ message: "nope" }, { status: 404 });
  };
  const tools = createInfisicalTools({ vault, fetchImpl });
  await assert.rejects(
    tools.infisical_upsert.execute({ name: "VPN_PASSWORD", value: "x", path: "/x", projectId: "ops-team" }),
    /creating the folder failed too/,
  );
});
