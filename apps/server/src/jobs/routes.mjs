import { TriggerError } from "./triggers.mjs";

// Who a jobs write over HTTP is from, by the credential the request carried (auth.mjs ownerVia):
// the page's login cookie = "owner"; the owner token (a script, the CLI — or a job's Bash), or no
// credential at all (AUTH=off) = "unknown". An "unknown" write marks the job's writer "unknown",
// whatever it changed, and a run it starts is not the owner's.
export const requestWriter = (c) => (c?.get?.("ownerVia") === "cookie" ? "owner" : "unknown");

export function jobRoutes(app, jobs, { targets = () => [] } = {}) {
  const fromPage = (c, input) => (requestWriter(c) === "owner" ? input : { ...input, promptChatId: "unknown" });
  const fail = (c, error) => (error instanceof TriggerError ? c.json({ error: error.message }, 400) : Promise.reject(error));

  app.get("/api/jobs", (c) => c.json({ jobs: jobs.list(), kinds: jobs.kinds(), targets: targets() }));

  app.post("/api/jobs", async (c) => {
    try {
      return c.json({ job: jobs.view(jobs.create(fromPage(c, await body(c)))) }, 201);
    } catch (error) {
      return fail(c, error);
    }
  });

  app.patch("/api/jobs/:id", async (c) => {
    try {
      const job = jobs.update(c.req.param("id"), fromPage(c, await body(c)));
      return job ? c.json({ job: jobs.view(job) }) : c.json({ error: "not found" }, 404);
    } catch (error) {
      return fail(c, error);
    }
  });

  app.delete("/api/jobs/:id", (c) => (jobs.remove(c.req.param("id")) ? c.json({ ok: true }) : c.json({ error: "not found" }, 404)));

  app.get("/api/jobs/:id/runs", (c) => c.json({ runs: jobs.runs(c.req.param("id"), 20) }));

  // Fire now, without waiting for the answer: the UI follows the run in the job's history.
  app.post("/api/jobs/:id/run", (c) => {
    const id = c.req.param("id");
    if (!jobs.get(id)) return c.json({ error: "not found" }, 404);
    if (jobs.isRunning(id)) return c.json({ error: "این جاب همین حالا در حال اجراست" }, 409);
    jobs.run(id, "manual", { by: requestWriter(c) }).catch(() => {});
    return c.json({ started: true }, 202);
  });
}

async function body(c) {
  try {
    const value = await c.req.json();
    if (!value || typeof value !== "object") return {};
    // The jobs page is the owner himself: a prompt set here is his (jobs/owner-jobs.mjs), and a
    // body cannot name another writer.
    const { promptChatId: _writer, ...rest } = value;
    return rest;
  } catch {
    return {};
  }
}
