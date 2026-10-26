import test from "node:test";
import assert from "node:assert/strict";
import { loginError, waitText } from "../src/login-error.js";

test("login errors say exactly how long to wait or how many tries are left", () => {
  assert.equal(waitText(45), "۴۵ ثانیه");
  assert.equal(waitText(61), "۲ دقیقه");
  assert.match(loginError(429, { retryAfter: 600 }), /۱۰ دقیقه دیگر/);
  assert.match(loginError(401, { remaining: 2 }), /۲ بار دیگر/);
  assert.equal(loginError(401, { remaining: 4 }), "توکن درست نیست.");
  assert.match(loginError(401, { remaining: 0, retryAfter: 900 }), /۱۵ دقیقه/);
  assert.match(loginError(403), /نشانی اصلی/);
  assert.match(loginError(0), /سرور در دسترس نیست/);
  assert.match(loginError(500), /۵۰۰/);
});

test("with two-step sign-in a wrong code says so, not «توکن درست نیست»", () => {
  assert.match(loginError(401, { needCode: true, remaining: 3 }), /کد درست نیست/);
  assert.match(loginError(401, { needCode: true, remaining: 0, retryAfter: 900 }), /۱۵ دقیقه/);
  assert.match(loginError(429, { needCode: true, retryAfter: 300 }), /کد اشتباه.*۵ دقیقه/);
});
