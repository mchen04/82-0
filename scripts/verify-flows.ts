import { loadEnvConfig } from "@next/env";
import assert from "node:assert/strict";
import { createLobby, joinLobby, getLobbyState, applyLobbyAction } from "../lib/multiplayer";
import { getPool, query } from "../lib/db";
import { loadGamePack } from "../lib/game-data";
import { POSITIONS, type Position, type PublicLobbyState } from "../lib/types";
import { salary } from "../lib/rules";

loadEnvConfig(process.cwd());

type TokenSet = Record<string, string>;

async function main() {
  await verifyStaleAction();
  await verifyParallelTie();
  await verifySnakeDraft();
  await getPool().end();
  console.log("Flow verification passed.");
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
  for (let guard = 0; guard < 40; guard += 1) {
    const match = state.activeMatch;
    assert.ok(match, "snake match exists");
    if (state.status === "results") break;
    const current = match.currentTurnPlayerId;
    assert.ok(current, "current drafter exists");
    observedOrder.push(current);
    const token = tokens[current];
    const actorState = await getLobbyState(host.code, token);
    const candidate = cheapestAssignable(actorState);
    assert.ok(candidate, `assignable candidate for ${current}`);
    state = await applyLobbyAction(host.code, {
      token,
      expectedVersion: actorState.stateVersion,
      action: "pick",
      playerSeasonId: candidate.id,
      position: candidate.openPositions[0],
    });
    if (state.status === "results") break;
  }

  const expectedFirstSix = [participants[0], participants[1], participants[2], participants[2], participants[1], participants[0]];
  assert.deepEqual(observedOrder.slice(0, 6), expectedFirstSix);
  const final = await getLobbyState(host.code, host.token);
  assert.equal(final.status, "results");
  assert.equal(final.activeMatch?.runs.every((run) => run.picks.length === 5), true);
}

function cheapestAssignable(state: PublicLobbyState) {
  return [...(state.activeMatch?.candidates ?? [])].filter((candidate) => candidate.assignable).sort((a, b) => a.cost - b.cost || a.player.localeCompare(b.player))[0];
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
