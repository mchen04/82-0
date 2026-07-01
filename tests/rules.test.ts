import test from "node:test";
import assert from "node:assert/strict";
import { loadGamePack } from "../lib/game-data";
import { capAmountFor, HARD_CAP_AMOUNT, isLegalCost, maxLegalCost, scoreLineup, SOFT_CAP_AMOUNT, salary } from "../lib/rules";

test("salary is deterministic and bounded for public game data", () => {
  const players = loadGamePack().players.slice(0, 250);
  for (const player of players) {
    const cost = salary(player);
    assert.equal(Number.isInteger(cost), true);
    assert.equal(cost >= 3, true);
    assert.equal(cost <= 38, true);
    assert.equal(salary(player), cost);
  }
});

test("hard cap reserves minimum budget for remaining lineup slots", () => {
  assert.equal(maxLegalCost("hard", HARD_CAP_AMOUNT, 70, 3), 15);
  assert.equal(isLegalCost(15, "hard", HARD_CAP_AMOUNT, 70, 3), true);
  assert.equal(isLegalCost(16, "hard", HARD_CAP_AMOUNT, 70, 3), false);
});

test("cap type selects the correct budget", () => {
  assert.equal(capAmountFor("hard"), 88);
  assert.equal(capAmountFor("soft"), 100);
});

test("soft cap permits overspend and applies deterministic win penalty", () => {
  const pack = loadGamePack();
  const lineup = [
    pack.players.find((player) => player.positions.includes("PG"))!,
    pack.players.find((player) => player.positions.includes("SG"))!,
    pack.players.find((player) => player.positions.includes("SF"))!,
    pack.players.find((player) => player.positions.includes("PF"))!,
    pack.players.find((player) => player.positions.includes("C"))!,
  ];
  const hardish = scoreLineup(lineup, "hard", HARD_CAP_AMOUNT, HARD_CAP_AMOUNT);
  const soft = scoreLineup(lineup, "soft", SOFT_CAP_AMOUNT, SOFT_CAP_AMOUNT + 8);
  assert.equal(typeof hardish.wins, "number");
  assert.equal(soft.softOverspend, 8);
  assert.equal(soft.softPenaltyWins, 4);
  assert.equal(soft.wins, Math.max(0, hardish.wins - 4));
});
