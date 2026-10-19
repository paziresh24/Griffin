// The message search's backfill on its own thread and connection (db.mjs indexSearchStep), so its
// writes and the WAL checkpoints they set off never hold the server's event loop. index.mjs asks for
// one step at a time and paces them; each answer is { more, error }. A step is one short transaction
// and a checkpoint (db.mjs indexSearchStep).
import { parentPort, workerData } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
import { enableSearchSchema, indexSearchStep } from "./db.mjs";

const db = new DatabaseSync(workerData.file);
db.exec("PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;");
parentPort.on("message", () => {
  try {
    enableSearchSchema(db); // the first time only: the index and its cursor
    parentPort.postMessage({ more: indexSearchStep(db) });
  } catch (error) {
    parentPort.postMessage({ more: false, error: error.message });
  }
});
