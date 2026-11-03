// Joins the streamed pieces stored before db.mjs appendEvent coalesced them (db.mjs
// compactStreamStep), on its own thread and connection so its writes never hold the server's event
// loop. index.mjs asks for one step at a time and paces them; each answer is { more, error }.
import { parentPort, workerData } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
import { compactStreamStep } from "./db.mjs";

const db = new DatabaseSync(workerData.file);
db.exec("PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;");
parentPort.on("message", () => {
  try {
    parentPort.postMessage({ more: compactStreamStep(db) });
  } catch (error) {
    parentPort.postMessage({ more: false, error: error.message });
  }
});
