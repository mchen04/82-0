import { loadEnvConfig } from "@next/env";
import assert from "node:assert/strict";
import test, { after } from "node:test";
import { getPool, query } from "../lib/db";
import { isAppError } from "../lib/errors";
import { loadGamePack } from "../lib/game-data";
import { applyLobbyAction, cleanupExpiredLobbies, createLobby, getLobbyState, getLobbyStateIfChanged, joinLobby } from "../lib/multiplayer";

loadEnvConfig(process.cwd());

after(async () => {
  await getPool().end().catch(() => undefined);
});

test("expired open lobby closes and rejects tokens", async () => {
  const host = await createLobby({ name: "Lifecycle A", mode: "parallel", capType: "hard", rerollsEnabled: true });
  await query(
    `UPDATE lobbies
     SET last_activity_at = now() - interval '25 hours',
         expires_at = now() - interval '1 minute'
     WHERE code = $1`,
    [host.code],
  );

  await assert.rejects(() => getLobbyState(host.code, host.token), isExpiredLobbyError);

  const closed = await query<{ status: string; closed_at: Date | null; close_reason: string | null }>(
    `SELECT status, closed_at, close_reason FROM lobbies WHERE code = $1`,
    [host.code],
  );
  assert.equal(closed.rows[0]?.status, "closed");
  assert.ok(closed.rows[0]?.closed_at);
  assert.equal(closed.rows[0]?.close_reason, "expired");

  await assert.rejects(() => joinLobby(host.code, { name: "Late" }), isExpiredLobbyError);
  await assert.rejects(
    () => applyLobbyAction(host.code, { token: host.token, action: "settings", mode: "snake" }),
    isExpiredLobbyError,
  );
});

test("results stay readable until their expiry then close", async () => {
  const host = await createLobby({ name: "Results A", mode: "parallel", capType: "hard", rerollsEnabled: true });
  await joinLobby(host.code, { name: "Results B" });
  await query(
    `UPDATE lobbies
     SET status = 'results',
         expires_at = now() + interval '1 hour',
         last_activity_at = now()
     WHERE code = $1`,
    [host.code],
  );

  const viewable = await getLobbyState(host.code, host.token);
  assert.equal(viewable.status, "results");

  await query(`UPDATE lobbies SET expires_at = now() - interval '1 minute' WHERE code = $1`, [host.code]);
  await assert.rejects(() => getLobbyState(host.code, host.token), isExpiredLobbyError);
});

test("cleanup hard-deletes closed lobbies after retention", async () => {
  const host = await createLobby({ name: "Cleanup A", mode: "parallel", capType: "hard", rerollsEnabled: true });
  await query(
    `UPDATE lobbies
     SET status = 'closed',
         closed_at = now() - interval '31 days',
         close_reason = 'expired',
         expires_at = now() - interval '31 days'
     WHERE code = $1`,
    [host.code],
  );

  const result = await cleanupExpiredLobbies();
  assert.ok(result.deleted >= 1);

  const remaining = await query<{ count: string }>(`SELECT count(*)::text AS count FROM lobbies WHERE code = $1`, [host.code]);
  assert.equal(Number(remaining.rows[0]?.count ?? 0), 0);
});

test("conditional lobby reads skip unchanged state", async () => {
  const host = await createLobby({ name: "Poll A", mode: "parallel", capType: "hard", rerollsEnabled: true });
  const initial = await getLobbyState(host.code, host.token);

  const unchanged = await getLobbyStateIfChanged(host.code, host.token, initial.stateVersion);
  assert.equal(unchanged.changed, false);

  const futureVersion = await getLobbyStateIfChanged(host.code, host.token, initial.stateVersion + 10);
  assert.equal(futureVersion.changed, true);

  await joinLobby(host.code, { name: "Poll B" });
  const changed = await getLobbyStateIfChanged(host.code, host.token, initial.stateVersion);
  assert.equal(changed.changed, true);
  if (changed.changed) assert.equal(changed.state.players.length, 2);
});

test("parallel rerolls respect lobby setting", async () => {
  const host = await createLobby({ name: "No Reroll A", mode: "parallel", capType: "hard", rerollsEnabled: false });
  await joinLobby(host.code, { name: "No Reroll B" });
  let state = await getLobbyState(host.code, host.token);
  state = await applyLobbyAction(host.code, { token: host.token, expectedVersion: state.stateVersion, action: "start" });

  const run = state.activeMatch?.runs.find((candidate) => candidate.playerId === state.viewerPlayerId);
  assert.ok(run, "viewer run exists");
  const spin = loadGamePack().teamEras[0];
  assert.ok(spin, "team era exists");
  await query(`UPDATE runs SET current_spin = $2::jsonb, updated_at = now() WHERE id = $1`, [
    run.id,
    JSON.stringify({ team: spin.team, era: spin.era }),
  ]);

  await assert.rejects(
    () => applyLobbyAction(host.code, { token: host.token, expectedVersion: state.stateVersion, action: "reroll-team" }),
    (error) => {
      assert.ok(isAppError(error), "expected AppError");
      assert.equal(error.status, 409);
      assert.equal(error.code, "rerolls_disabled");
      return true;
    },
  );
});

function isExpiredLobbyError(error: unknown) {
  assert.ok(isAppError(error), "expected AppError");
  assert.equal(error.status, 410);
  assert.equal(error.code, "lobby_expired");
  return true;
}
