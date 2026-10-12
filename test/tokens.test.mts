import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { SwapTokens } from "../src/tokens.mts";

test("issues a token that matches its swap at its exchanger and nothing else", () => {
  const tokens = new SwapTokens("a secret of the test");
  const token = tokens.issue("3a2360771439a3", "changenow");
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(tokens.matches("3a2360771439a3", "changenow", token), true);
  assert.equal(tokens.matches("9f4e2c71b03ad1", "changenow", token), false);
  assert.equal(tokens.matches("3a2360771439a3", "simpleswap", token), false, "another exchanger, the same id");
  assert.equal(new SwapTokens("another secret").matches("3a2360771439a3", "changenow", token), false);
  assert.equal(tokens.matches("3a2360771439a3", "changenow", ""), false);
  const simple = tokens.issue("pch7l7kd1v2mzh1", "simpleswap");
  assert.equal(tokens.matches("pch7l7kd1v2mzh1", "simpleswap", simple), true);
  assert.equal(tokens.matches("pch7l7kd1v2mzh1", "changenow", simple), false);
});

test("keeps the first form of a token of ChangeNOW, which the apps already hold", () => {
  const tokens = new SwapTokens("a secret of the test");
  const first = createHmac("sha256", "a secret of the test").update("kranox-swap:3a2360771439a3").digest("base64url");
  assert.equal(tokens.issue("3a2360771439a3", "changenow"), first);
});

test("refuses an empty secret", () => {
  assert.throws(() => new SwapTokens(""), /must not be empty/);
});
