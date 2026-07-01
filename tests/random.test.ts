import assert from "node:assert/strict";
import test from "node:test";
import { shuffleBySeed } from "../lib/random";

test("seeded shuffle keeps a stable permutation and varies by seed", () => {
  const players = ["a", "b", "c", "d", "e"];
  const firstRound = shuffleBySeed(players, "round-1");
  const secondRound = shuffleBySeed(players, "round-2");

  assert.deepEqual(firstRound, ["e", "a", "b", "d", "c"]);
  assert.deepEqual(secondRound, ["d", "a", "b", "c", "e"]);
  assert.deepEqual([...firstRound].sort(), players);
  assert.deepEqual([...secondRound].sort(), players);
});
