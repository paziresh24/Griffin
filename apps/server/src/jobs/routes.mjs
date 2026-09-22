import { TriggerError } from "./triggers.mjs";

export function jobRoutes(app, jobs, { targets = () => [] } = {}) {
  const fail = (c, error) => (error instanceof TriggerError ? c.json({ error: error.message }, 400) : Promise.reject(error));

  app.get("/api/jobs", (c) => c.json({ jobs: jobs.list(), kinds: jobs.kinds(), targets: targets() }));

  app.post("/api/jobs", async (c) => {
    try {
      return c.json({ job: jobs.view(jobs.create(await body(c))) }, 201);
    } catch (error) {
      return fail(c, error);
    }
  });

  app.patch("/api/jobs/:id", async (c) => {
    try {
      const job = jobs.update(c.req.param("id"), await body(c));
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
    jobs.run(id, "manual").catch(() => {});
    return c.json({ started: true }, 202);
  });
}

async function body(c) {
  try {
    const value = await c.req.json();
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}
