import assert from "node:assert/strict";
import test from "node:test";
import { fullModeNote } from "../src/providers/claude.mjs";

test("a host run is told a refused user is a wrong guess, not a missing access", () => {
  const note = fullModeNote({ host: true, onHost: true });
  assert.match(note, /own Unix user/);
  assert.match(note, /wrong guess, not «no access»/);
  assert.doesNotMatch(note, /inside the app container/);
});

test("a run that fell back to the container says so instead of asking for access", () => {
  const note = fullModeNote({ host: false, onHost: true });
  assert.match(note, /inside the app container/);
  assert.match(note, /never raise an access card/);
});

test("an install without the host option gets the plain note; a job its own", () => {
  assert.doesNotMatch(fullModeNote({}), /container/);
  assert.match(fullModeNote({ ownerJob: true, host: true }), /scheduled job/);
});
