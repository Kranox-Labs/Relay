import assert from "node:assert/strict";
import { test } from "node:test";
import { checkCreationKeys, CREATION_KEY_ENTRIES, CREATION_KEY_MS, UPSTREAM_CALLS_PER_SECOND } from "../src/config.mts";
import { CreationKeys, CreationKeysFull } from "../src/creations.mts";

test("takes a lifetime and a capacity of whole numbers above zero only", () => {
  for (const [lifetime, capacity] of [
    [0, 2],
    [-1, 2],
    [Number.NaN, 2],
    [1_000, 0],
    [1_000, Number.POSITIVE_INFINITY],
    [1_000, 2.5],
  ]) {
    assert.throws(() => new CreationKeys(lifetime, capacity), /whole numbers above zero/, `${lifetime}, ${capacity}`);
  }
});

test("starts only while the creation keys outnumber the calls to ChangeNOW in the lifetime of a key", () => {
  assert.doesNotThrow(() => checkCreationKeys(UPSTREAM_CALLS_PER_SECOND, CREATION_KEY_MS, CREATION_KEY_ENTRIES));
  assert.throws(() => checkCreationKeys(40, CREATION_KEY_MS, CREATION_KEY_ENTRIES), /outnumber/);
  assert.throws(() => checkCreationKeys(UPSTREAM_CALLS_PER_SECOND, Number.NaN, CREATION_KEY_ENTRIES), /outnumber/);
});

test("forgets a creation after its time, and refuses a new key while it holds too many live ones (O-008)", async () => {
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
  await assert.rejects(keys.run("cccccccccccccccc", request, create), CreationKeysFull);
  assert.equal(await keys.run("aaaaaaaaaaaaaaaa", request, create), 2, "a flood of keys pushes out no live key");
  assert.equal(await keys.run("bbbbbbbbbbbbbbbb", request, create), 3);
  assert.equal(made, 3, "the refused key made no exchange");

  now = 2_000;
  assert.equal(await keys.run("cccccccccccccccc", request, create), 4, "a key that ran out leaves room");
  assert.equal(await keys.run(undefined, request, create), 5);
  assert.equal(await keys.run(undefined, request, create), 6, "without a key, each call creates");
});
