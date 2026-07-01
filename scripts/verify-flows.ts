import { loadEnvConfig } from "@next/env";
import assert from "node:assert/strict";
import { createLobby, joinLobby, getLobbyState, applyLobbyAction } from "../lib/multiplayer";
import { getPool, query } from "../lib/db";
import { loadGamePack } from "../lib/game-data";
import { POSITIONS, type Position, type PublicLobbyState, type Spin } from "../lib/types";
import { HARD_CAP_AMOUNT, salary, SOFT_CAP_AMOUNT } from "../lib/rules";

loadEnvConfig(process.cwd());

type TokenSet = Record<string, string>;

async function main() {
  await verifyCapAmounts();
  await verifyStaleAction();
  await verifyLineupMove();
  await verifyLineupSwap();
  await verifySnakeOffTurnLineupMove();
  await verifyParallelTie();
  await verifySnakeDraft();
  await getPool().end();
  console.log("Flow verification passed.");
}

async function verifyCapAmounts() {
  const soft = await createLobby({ name: "Soft Cap", mode: "parallel", capType: "soft", rerollsEnabled: true });
  const softState = await getLobbyState(soft.code, soft.token);
  assert.equal(softState.capType, "soft");
  assert.equal(softState.capAmount, SOFT_CAP_AMOUNT);

  const host = await createLobby({ name: "Cap Toggle", mode: "parallel", capType: "hard", rerollsEnabled: true });
  let state = await getLobbyState(host.code, host.token);
  assert.equal(state.capType, "hard");
  assert.equal(state.capAmount, HARD_CAP_AMOUNT);
  state = await applyLobbyAction(host.code, { token: host.token, expectedVersion: state.stateVersion, action: "settings", capType: "soft" });
  assert.equal(state.capType, "soft");
  assert.equal(state.capAmount, SOFT_CAP_AMOUNT);
}

async function verifyStaleAction() {
  const host = await createLobby({ name: "Host", mode: "parallel", capType: "hard", rerollsEnabled: true });
  await joinLobby(host.code, { name: "Friend" });
  const before = await getLobbyState(host.code, host.token);
  await applyLobbyAction(host.code, { token: host.token, expectedVersion: before.stateVersion, action: "start" });
  await assert.rejects(
    () => applyLobbyAction(host.code, { token: host.token, expectedVersion: before.stateVersion, action: "spin" }),
    /stale lobby state/i,
  );
  const reconnected = await getLobbyState(host.code, host.token);
  assert.equal(reconnected.status, "active");
  assert.equal(reconnected.viewerPlayerId, host.playerId);
}

async function verifyParallelTie() {
  const host = await createLobby({ name: "Tie A", mode: "parallel", capType: "hard", rerollsEnabled: true });
  const guest = await joinLobby(host.code, { name: "Tie B" });
  let state = await getLobbyState(host.code, host.token);
  state = await applyLobbyAction(host.code, { token: host.token, expectedVersion: state.stateVersion, action: "start" });
  assert.equal(state.activeMatch?.mode, "parallel");

  const lineup = cheapestLineup();
  for (const pick of lineup) {
    state = await forceSpinAndPick(host.code, host.token, pick.player.id, pick.position, pick.player.team, pick.player.era);
    state = await forceSpinAndPick(host.code, guest.token, pick.player.id, pick.position, pick.player.team, pick.player.era);
  }

  const tiedState = await getLobbyState(host.code, host.token);
  assert.equal(tiedState.status, "active");
  assert.equal(tiedState.activeMatch?.roundNo, 2);
  assert.equal(Boolean(tiedState.activeMatch?.tiebreakerOf), true);
  assert.deepEqual(new Set(tiedState.activeMatch?.participantIds), new Set([host.playerId, guest.playerId]));
}

async function verifyLineupMove() {
  const host = await createLobby({ name: "Move A", mode: "parallel", capType: "hard", rerollsEnabled: true });
  await joinLobby(host.code, { name: "Move B" });
  let state = await getLobbyState(host.code, host.token);
  state = await applyLobbyAction(host.code, { token: host.token, expectedVersion: state.stateVersion, action: "start" });

  const pick = cheapestMovablePick();
  const [fromPosition, toPosition] = pick.player.positions;
  assert.ok(fromPosition && toPosition, "movable player has two positions");
  state = await forceSpinAndPick(host.code, host.token, pick.player.id, fromPosition, pick.player.team, pick.player.era);
  state = await applyLobbyAction(host.code, { token: host.token, expectedVersion: state.stateVersion, action: "move-pick", fromPosition, position: toPosition });

  const run = state.activeMatch?.runs.find((candidate) => candidate.playerId === state.viewerPlayerId);
  assert.ok(run, "viewer run exists after move");
  assert.equal(run.lineup[fromPosition], undefined);
  assert.equal(run.lineup[toPosition]?.playerId, pick.player.id);
  assert.equal(run.lineup[toPosition]?.position, toPosition);
  assert.equal(run.picks.find((slot) => slot.playerId === pick.player.id)?.position, toPosition);
}

async function verifyLineupSwap() {
  const host = await createLobby({ name: "Swap A", mode: "parallel", capType: "hard", rerollsEnabled: true });
  await joinLobby(host.code, { name: "Swap B" });
  let state = await getLobbyState(host.code, host.token);
  state = await applyLobbyAction(host.code, { token: host.token, expectedVersion: state.stateVersion, action: "start" });

  const swap = swappablePair();
  state = await forceSpinAndPick(host.code, host.token, swap.source.id, swap.fromPosition, swap.source.team, swap.source.era);
  state = await forceSpinAndPick(host.code, host.token, swap.target.id, swap.position, swap.target.team, swap.target.era);
  state = await applyLobbyAction(host.code, { token: host.token, expectedVersion: state.stateVersion, action: "move-pick", fromPosition: swap.fromPosition, position: swap.position });

  const run = state.activeMatch?.runs.find((candidate) => candidate.playerId === state.viewerPlayerId);
  assert.ok(run, "viewer run exists after swap");
  assert.equal(run.lineup[swap.position]?.playerId, swap.source.id);
  assert.equal(run.lineup[swap.position]?.position, swap.position);
  assert.equal(run.lineup[swap.fromPosition]?.playerId, swap.target.id);
  assert.equal(run.lineup[swap.fromPosition]?.position, swap.fromPosition);
  assert.equal(run.picks.find((slot) => slot.playerId === swap.source.id)?.position, swap.position);
  assert.equal(run.picks.find((slot) => slot.playerId === swap.target.id)?.position, swap.fromPosition);
}

async function verifySnakeOffTurnLineupMove() {
  const host = await createLobby({ name: "Snake Move A", mode: "snake", capType: "hard", rerollsEnabled: true });
  const guest = await joinLobby(host.code, { name: "Snake Move B" });
  const tokens: TokenSet = {
    [host.playerId]: host.token,
    [guest.playerId]: guest.token,
  };
  let state = await getLobbyState(host.code, host.token);
  state = await applyLobbyAction(host.code, { token: host.token, expectedVersion: state.stateVersion, action: "start" });

  const pick = cheapestMovablePick();
  const [fromPosition, toPosition] = pick.player.positions;
  assert.ok(fromPosition && toPosition, "movable player has two positions");
  const currentPlayerId = state.activeMatch?.currentTurnPlayerId;
  assert.ok(state.activeMatch && currentPlayerId, "snake match and current drafter exist");
  const currentToken = tokens[currentPlayerId];
  assert.ok(currentToken, "current drafter token exists");
  await query(`UPDATE matches SET current_spin = $2::jsonb WHERE id = $1`, [state.activeMatch.id, JSON.stringify({ team: pick.player.team, era: pick.player.era })]);

  state = await getLobbyState(host.code, currentToken);
  assert.equal(state.activeMatch?.currentTurnPlayerId, currentPlayerId);
  assert.ok(state.activeMatch?.candidates.some((candidate) => candidate.id === pick.player.id && candidate.assignable));
  state = await applyLobbyAction(host.code, { token: currentToken, expectedVersion: state.stateVersion, action: "pick", playerSeasonId: pick.player.id, position: fromPosition });

  state = await getLobbyState(host.code, currentToken);
  assert.notEqual(state.activeMatch?.currentTurnPlayerId, currentPlayerId);
  state = await applyLobbyAction(host.code, { token: currentToken, expectedVersion: state.stateVersion, action: "move-pick", fromPosition, position: toPosition });

  const run = state.activeMatch?.runs.find((candidate) => candidate.playerId === currentPlayerId);
  assert.ok(run, "drafter run exists after off-turn move");
  assert.equal(run.lineup[fromPosition], undefined);
  assert.equal(run.lineup[toPosition]?.playerId, pick.player.id);
}

async function forceSpinAndPick(code: string, token: string, playerSeasonId: string, position: Position, team: string, era: string) {
  const state = await getLobbyState(code, token);
  const run = state.activeMatch?.runs.find((candidate) => candidate.playerId === state.viewerPlayerId);
  assert.ok(run, "viewer run exists");
  await query(`UPDATE runs SET current_spin = $2::jsonb, updated_at = now() WHERE id = $1`, [run.id, JSON.stringify({ team, era })]);
  const withSpin = await getLobbyState(code, token);
  assert.ok(withSpin.activeMatch?.candidates.some((candidate) => candidate.id === playerSeasonId && candidate.assignable));
  return applyLobbyAction(code, {
    token,
    expectedVersion: withSpin.stateVersion,
    action: "pick",
    playerSeasonId,
    position,
  });
}

async function verifySnakeDraft() {
  const host = await createLobby({ name: "Snake A", mode: "snake", capType: "hard", rerollsEnabled: true });
  const guestB = await joinLobby(host.code, { name: "Snake B" });
  const guestC = await joinLobby(host.code, { name: "Snake C" });
  const tokens: TokenSet = {
    [host.playerId]: host.token,
    [guestB.playerId]: guestB.token,
    [guestC.playerId]: guestC.token,
  };

  let state = await getLobbyState(host.code, host.token);
  state = await applyLobbyAction(host.code, { token: host.token, expectedVersion: state.stateVersion, action: "start" });
  const participants = state.activeMatch?.participantIds ?? [];
  assert.equal(participants.length, 3);

  const observedOrder: string[] = [];
  const firstMatch = state.activeMatch;
  assert.ok(firstMatch, "snake match exists");
  assert.ok(firstMatch.currentSpin, "initial snake spin exists");
  const firstSpin = firstMatch.currentSpin;
  const removedTeamEra = await query<{ count: number }>(
    `DELETE FROM team_eras WHERE team = $1 AND era = $2 RETURNING count`,
    [firstSpin.team, firstSpin.era],
  );
  assert.equal(removedTeamEra.rowCount, 1);

  try {
    assert.ok(firstMatch.currentTurnPlayerId, "current drafter exists");
    observedOrder.push(firstMatch.currentTurnPlayerId);
    state = await pickForCurrentSnakeDrafter(host.code, tokens, state);
    assert.deepEqual(state.activeMatch?.currentSpin, firstSpin, "snake spin stays fixed until each player drafts from it");
  } finally {
    await restoreTeamEra(firstSpin, removedTeamEra.rows[0].count);
  }

  for (let guard = 0; guard < 40; guard += 1) {
    const match: PublicLobbyState["activeMatch"] = state.activeMatch;
    assert.ok(match, "snake match exists");
    if (state.status === "results") break;
    const current: string | null = match.currentTurnPlayerId;
    assert.ok(current, "current drafter exists");
    observedOrder.push(current);
    state = await pickForCurrentSnakeDrafter(host.code, tokens, state);
    if (state.status === "results") break;
  }

  const expectedFirstSix = [participants[0], participants[1], participants[2], participants[2], participants[1], participants[0]];
  assert.deepEqual(observedOrder.slice(0, 6), expectedFirstSix);
  const final = await getLobbyState(host.code, host.token);
  assert.equal(final.status, "results");
  assert.equal(final.activeMatch?.runs.every((run) => run.picks.length === 5), true);
}

async function pickForCurrentSnakeDrafter(code: string, tokens: TokenSet, state: PublicLobbyState): Promise<PublicLobbyState> {
  const current = state.activeMatch?.currentTurnPlayerId;
  assert.ok(current, "current drafter exists");
  const token = tokens[current];
  const actorState = await getLobbyState(code, token);
  const candidate = cheapestAssignable(actorState);
  assert.ok(candidate, `assignable candidate for ${current}`);
  return applyLobbyAction(code, {
    token,
    expectedVersion: actorState.stateVersion,
    action: "pick",
    playerSeasonId: candidate.id,
    position: candidate.openPositions[0],
  });
}

async function restoreTeamEra(spin: Spin, count: number) {
  await query(
    `INSERT INTO team_eras(team, era, count)
     VALUES ($1, $2, $3)
     ON CONFLICT (team, era) DO UPDATE SET count = excluded.count`,
    [spin.team, spin.era, count],
  );
}

function cheapestAssignable(state: PublicLobbyState) {
  return [...(state.activeMatch?.candidates ?? [])].filter((candidate) => candidate.assignable).sort((a, b) => a.cost - b.cost || a.player.localeCompare(b.player))[0];
}

function cheapestMovablePick() {
  const player = loadGamePack().players
    .filter((candidate) => candidate.positions.length >= 2)
    .map((candidate) => ({ player: candidate, cost: salary(candidate) }))
    .sort((a, b) => a.cost - b.cost || a.player.player.localeCompare(b.player.player))[0];
  assert.ok(player, "multi-position player exists");
  return player;
}

function swappablePair() {
  const players = loadGamePack().players;
  const options = players.flatMap((source) =>
    players.flatMap((target) => {
      if (source.id === target.id) return [];
      return source.positions.flatMap((fromPosition) =>
        target.positions
          .filter((position) => position !== fromPosition && source.positions.includes(position) && target.positions.includes(fromPosition))
          .map((position) => ({ source, target, fromPosition, position, cost: salary(source) + salary(target) })),
      );
    }),
  );
  const swap = options.sort((a, b) => a.cost - b.cost || a.source.player.localeCompare(b.source.player) || a.target.player.localeCompare(b.target.player))[0];
  assert.ok(swap, "swappable player pair exists");
  return swap;
}

function cheapestLineup() {
  const pack = loadGamePack();
  const used = new Set<string>();
  return POSITIONS.map((position) => {
    const player = pack.players
      .filter((candidate) => candidate.positions.includes(position) && !used.has(candidate.id))
      .map((candidate) => ({ player: candidate, cost: salary(candidate) }))
      .sort((a, b) => a.cost - b.cost || a.player.player.localeCompare(b.player.player))[0];
    assert.ok(player, `cheap ${position} exists`);
    used.add(player.player.id);
    return { position, player: player.player };
  });
}

main().catch(async (error) => {
  console.error(error);
  await getPool().end().catch(() => undefined);
  process.exit(1);
});
