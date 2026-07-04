import test from "node:test";
import assert from "node:assert/strict";
import { evaluateTiannaBoard } from "../components/tianna-analysis";
import { scoreLineupProgress } from "../lib/rules";
import type { Candidate, LineupSlot, PlayerSeason, Position, PublicLobbyState, PublicRun } from "../lib/types";

const ratings = { creation: 80, defense: 75, efficiency: 70, rebounding: 70, rimProtection: 80, scoring: 85, shootingGravity: 80, turnoverControl: 60 };
const perGame = { ppg: 20, apg: 5, rpg: 6 };

function baseSlot(position: Position, overall: number): LineupSlot {
  return { position, playerId: `base-${position}`, player: `Base ${position}`, team: "TST", era: "2020s", cost: 20, overall, positions: [position], perGame, ratings };
}

function center(id: string, cost: number, overall: number): Candidate {
  return { id, player: id, team: "TST", era: "2020s", positions: ["C"], overall, perGame, ratings, cost, assignable: true, affordable: true, openPositions: ["C"] };
}

const lineup = { PG: baseSlot("PG", 90), SG: baseSlot("SG", 88), SF: baseSlot("SF", 86), PF: baseSlot("PF", 84) };
const expensive = center("expensive", 35, 95);
const value = center("value", 7, 92);

function evaluate(capSpent: number) {
  const state = { capType: "soft", capAmount: 100 } as PublicLobbyState;
  const run = { capSpent, lineup } as PublicRun;
  return evaluateTiannaBoard(state, run, [expensive, value]);
}

function fullLineup(last: Candidate): PlayerSeason[] {
  return [
    ...Object.values(lineup).map((slot) => ({ ...slot, id: slot.playerId })),
    { id: last.id, player: last.player, team: last.team, era: last.era, positions: last.positions, overall: last.overall, perGame: last.perGame, ratings: last.ratings },
  ];
}

test("board evaluation ranks the soft-cap final pick by penalized strength", () => {
  const rawExpensive = scoreLineupProgress(fullLineup(expensive), "soft", 100, 95 + expensive.cost);
  const rawValue = scoreLineupProgress(fullLineup(value), "soft", 100, 95 + value.cost);
  assert.equal(rawExpensive.team_ovr > rawValue.team_ovr, true);
  assert.equal((rawExpensive.wins ?? 0) < (rawValue.wins ?? 0), true);

  const board = evaluate(95);
  assert.equal(board?.options.length, 2);
  assert.equal(board?.best?.candidateId, "value");
});

test("board evaluation keeps raw ranking when the soft cap is not exceeded", () => {
  const board = evaluate(40);
  assert.equal(board?.best?.candidateId, "expensive");
});
