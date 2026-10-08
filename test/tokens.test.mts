import assert from "node:assert/strict";
import { test } from "node:test";
import { SwapTokens } from "../src/tokens.mts";

test("a token belongs to one swap under one secret", () => {
  const tokens = new SwapTokens("a secret of the test");
  const token = tokens.issue("3a2360771439a3");
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(tokens.matches("3a2360771439a3", token), true);
  assert.equal(tokens.matches("9f4e2c71b03ad1", token), false);
  assert.equal(new SwapTokens("another secret").matches("3a2360771439a3", token), false);
  assert.equal(tokens.matches("3a2360771439a3", ""), false);
  assert.throws(() => new SwapTokens(""));
});
