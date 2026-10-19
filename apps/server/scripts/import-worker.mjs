// Runs one history import off the main thread (history-import.mjs): reading hundreds of transcripts
// and synchronous SQLite must not freeze the app.
import { parentPort, workerData } from "node:worker_threads";
import { importProjects } from "./from-claude-desktop.mjs";

parentPort.postMessage(importProjects(workerData));
