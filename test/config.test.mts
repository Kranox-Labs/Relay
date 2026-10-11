import assert from "node:assert/strict";
import { test } from "node:test";
import { checkOrigin, parseOrigins } from "../src/config.mts";

test("takes the origins of the web app as a browser sends them", () => {
  assert.deepEqual(parseOrigins(undefined, "ALLOWED_ORIGINS"), []);
  assert.deepEqual(parseOrigins("  ", "ALLOWED_ORIGINS"), []);
  assert.deepEqual(parseOrigins("https://app.kranox.cash", "ALLOWED_ORIGINS"), ["https://app.kranox.cash"]);
  assert.deepEqual(parseOrigins(" https://app.kranox.cash , http://localhost:5173 ", "ALLOWED_ORIGINS"), [
    "https://app.kranox.cash",
    "http://localhost:5173",
  ]);
  assert.deepEqual(parseOrigins("http://127.0.0.1:5181,https://app.kranox.cash:8443", "ALLOWED_ORIGINS"), [
    "http://127.0.0.1:5181",
    "https://app.kranox.cash:8443",
  ]);
  assert.equal(checkOrigin("http://[::1]:5173", "x"), "http://[::1]:5173");
});

test("refuses an origin of another form, and names it", () => {
  const cases: [string, RegExp][] = [
    ["app.kranox.cash", /no origin/],
    ["*", /no origin/],
    ["https://app.kranox.cash,", /no origin/],
    ["https://app.kranox.cash/", /slash at the end/],
    ["https://app.kranox.cash/door", /without a path/],
    ["https://APP.kranox.cash", /lowercase/],
    ["HTTPS://app.kranox.cash", /lowercase/],
    ["https://app.kranox.cash:443", /default port/],
    ["https://user@app.kranox.cash", /not an origin/],
    ["null", /no origin/],
    ["http://app.kranox.cash", /not HTTPS/],
    ["ws://app.kranox.cash", /not HTTPS/],
    ["file:///door", /not an origin/],
    ["https://app.kranox.cash, https://app.kranox.cash", /twice/],
  ];
  for (const [value, expected] of cases) {
    assert.throws(() => parseOrigins(value, "ALLOWED_ORIGINS"), expected, value);
  }
  assert.throws(
    () => parseOrigins("http://app.kranox.cash", "ALLOWED_ORIGINS"),
    /ALLOWED_ORIGINS holds "http:\/\/app\.kranox\.cash"/,
  );
});
