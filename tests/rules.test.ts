import test from "node:test";
import assert from "node:assert/strict";
import { loadGamePack } from "../lib/game-data";
import { capAmountFor, effectiveOverall, HARD_CAP_AMOUNT, isLegalCost, legalPlacementOptions, maxLegalCost, placePlayerInLineup, scoreLineup, SOFT_CAP_AMOUNT, salary } from "../lib/rules";
import type { LineupSlot, PlayerSeason, Position } from "../lib/types";

const ratings = { creation: 70, defense: 70, efficiency: 70, rebounding: 70, rimProtection: 70, scoring: 70, shootingGravity: 70, turnoverControl: 70 };
const perGame = { ppg: 10, apg: 2, rpg: 5 };

function player(id: string, positions: Position[]): PlayerSeason {
  return { id, player: id, team: "TST", era: "2020s", positions, overall: 70, perGame, ratings };
}

function slot(position: Position, id: string, positions: Position[]): LineupSlot {
  return { position, playerId: id, player: id, team: "TST", era: "2020s", cost: 10, overall: 70, positions, perGame, ratings };
}

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

test("placement options move flexible roles to make room for a new pick", () => {
  const lineup = { C: slot("C", "big", ["C", "PF"]) };
  const incoming = player("center", ["C"]);

  const options = legalPlacementOptions(lineup, incoming);
  assert.deepEqual(options, [{ position: "C", moves: [{ playerId: "big", player: "big", fromPosition: "C", position: "PF" }] }]);

  const placed = placePlayerInLineup(lineup, incoming, 8, "C");
  assert.equal(placed?.lineup.C?.playerId, "center");
  assert.equal(placed?.lineup.PF?.playerId, "big");
  assert.equal(placed?.lineup.PF?.position, "PF");
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

test("effective overall ranks soft-cap lineups by penalized strength", () => {
  const base = { losses: 0, grade: "A", label: "", reasons: [] };
  const expensive = { ...base, team_ovr: 90, wins: 61, softPenaltyWins: 15, softOverspend: 30 };
  const value = { ...base, team_ovr: 89, wins: 74, softPenaltyWins: 1, softOverspend: 2 };
  const clean = { ...base, team_ovr: 89, wins: 75 };
  const partialPenalized = { ...base, team_ovr: 55.2, wins: null, grade: null, label: "PARTIAL", softPenaltyWins: 6, softOverspend: 12 };

  assert.equal(effectiveOverall(clean), 89);
  assert.equal(effectiveOverall(partialPenalized), 55.2);
  assert.equal(effectiveOverall(value) > effectiveOverall(expensive), true);
});
