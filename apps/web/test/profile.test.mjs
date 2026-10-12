import test from "node:test";
import assert from "node:assert/strict";
import { ownerView } from "../src/profile.js";

test("no profile (not loaded, or nothing connected): the app icon and «Owner», as before", () => {
  for (const profile of [null, undefined, {}, { name: null, photo: null }]) {
    assert.deepEqual(ownerView(profile), { name: "Owner", photo: "/icon.svg", isPhoto: false });
  }
});

test("the owner's name and Telegram photo when the server has them; a name alone keeps the icon", () => {
  assert.deepEqual(ownerView({ name: "آقای نمونه", photo: "/api/profile/photo?v=abc" }), { name: "آقای نمونه", photo: "/api/profile/photo?v=abc", isPhoto: true });
  assert.deepEqual(ownerView({ name: "آقای نمونه", photo: null }), { name: "آقای نمونه", photo: "/icon.svg", isPhoto: false });
});
