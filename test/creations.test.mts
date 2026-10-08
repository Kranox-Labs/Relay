import assert from "node:assert/strict";
import { test } from "node:test";
import { CreationKeys } from "../src/creations.mts";

test("forgets a creation after its time, and the oldest first when it holds too many", async () => {
  let now = 0;
  let made = 0;
  const create = async () => ++made;
  const keys = new CreationKeys(1_000, 2, () => now);
  const request = { route: "pay" };
  assert.equal(await keys.run("aaaaaaaaaaaaaaaa", request, create), 1);
  assert.equal(await keys.run("aaaaaaaaaaaaaaaa", request, create), 1);
  now = 1_000;
  assert.equal(await keys.run("aaaaaaaaaaaaaaaa", request, create), 2, "the time of the key ran out");

  assert.equal(await keys.run("bbbbbbbbbbbbbbbb", request, create), 3);
  assert.equal(await keys.run("cccccccccccccccc", request, create), 4);
  assert.equal(await keys.run("aaaaaaaaaaaaaaaa", request, create), 5, "the oldest key went for a third one");
  assert.equal(await keys.run(undefined, request, create), 6);
  assert.equal(await keys.run(undefined, request, create), 7, "without a key, each call creates");
});
