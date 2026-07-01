import type { PoolClient } from "pg";
import { z } from "zod";
import { getPool, type DbClient, query, withTransaction } from "./db";
import { AppError } from "./errors";
import { getLocalPlayer } from "./game-data";
import { capAmountFor, isLegalCost, maxLegalCost, openPositions, scoreLineup, selectedPlayerIds, slotCount, toLineupSlot } from "./rules";
import { id, lobbyCode, pickRandom, secretToken } from "./random";
import { POSITIONS, type Candidate, type CapType, type Lineup, type LobbyMode, type PlayerSeason, type Position, type PublicLobbyState, type PublicMatch, type PublicRun, type Spin } from "./types";

type LobbyRow = {
  id: string;
  code: string;
  mode: LobbyMode;
  cap_type: CapType;
  cap_amount: number;
  status: "lobby" | "active" | "results";
  rerolls_enabled: boolean;
  host_player_id: string | null;
  active_match_id: string | null;
  state_version: number;
};

type LobbyPlayerRow = {
  id: string;
  lobby_id: string;
  name: string;
  token: string;
  active: boolean;
  joined_at: Date;
};

type MatchRow = {
  id: string;
  lobby_id: string;
  mode: LobbyMode;
  round_no: number;
  status: "active" | "complete";
  participant_ids: string[];
  current_turn_player_id: string | null;
  current_pick_index: number;
  current_spin: Spin | null;
  winner_ids: string[];
  tiebreaker_of: string | null;
};

type RunRow = {
  id: string;
  lobby_id: string;
  match_id: string;
  player_id: string;
  status: "active" | "finished" | "lost";
  round: number;
  cap_spent: number;
  team_reroll_used: boolean;
  decade_reroll_used: boolean;
  current_spin: Spin | null;
  lineup: Lineup;
  final_result: PublicRun["finalResult"];
  lost_reason: string | null;
};

type PlayerSeasonRow = {
  player_id: string;
  player_name: string;
  team: string;
  era: string;
  positions: Position[];
  cost: number;
  data: PlayerSeason;
};

const CreateLobbySchema = z.object({
  name: z.string().trim().min(1).max(32).default("Player 1"),
  mode: z.enum(["parallel", "snake"]).default("parallel"),
  capType: z.enum(["hard", "soft"]).default("hard"),
  rerollsEnabled: z.boolean().default(true),
});

const JoinLobbySchema = z.object({
  name: z.string().trim().min(1).max(32).default("Friend"),
});

const ActionSchema = z.object({
  token: z.string().min(16),
  expectedVersion: z.number().int().nonnegative().optional(),
  action: z.enum(["settings", "start", "spin", "reroll-team", "reroll-decade", "pick", "next-match"]),
  mode: z.enum(["parallel", "snake"]).optional(),
  capType: z.enum(["hard", "soft"]).optional(),
  rerollsEnabled: z.boolean().optional(),
  playerSeasonId: z.string().optional(),
  position: z.enum(POSITIONS).optional(),
});

export type CreateLobbyInput = z.input<typeof CreateLobbySchema>;
export type JoinLobbyInput = z.input<typeof JoinLobbySchema>;
export type ActionInput = z.input<typeof ActionSchema>;

export async function createLobby(input: CreateLobbyInput) {
  const parsed = CreateLobbySchema.parse(input);
  return withTransaction(async (client) => {
    const code = await createUniqueCode(client);
    const lobbyId = id();
    const playerId = id();
    const token = secretToken();

    await client.query(
      `INSERT INTO lobbies(id, code, mode, cap_type, cap_amount, status, rerolls_enabled, host_player_id)
       VALUES ($1, $2, $3, $4, $5, 'lobby', $6, $7)`,
      [lobbyId, code, parsed.mode, parsed.capType, capAmountFor(parsed.capType), parsed.rerollsEnabled, playerId],
    );
    await client.query(
      `INSERT INTO lobby_players(id, lobby_id, name, token) VALUES ($1, $2, $3, $4)`,
      [playerId, lobbyId, parsed.name, token],
    );
    await client.query(
      `INSERT INTO standings(lobby_id, player_id) VALUES ($1, $2)`,
      [lobbyId, playerId],
    );
    await recordEvent(client, lobbyId, null, playerId, "lobby.created", { mode: parsed.mode, capType: parsed.capType });
    await bumpLobbyVersion(client, lobbyId);

    return { code, token, playerId };
  });
}

export async function joinLobby(code: string, input: JoinLobbyInput) {
  const parsed = JoinLobbySchema.parse(input);
  return withTransaction(async (client) => {
    const lobby = await lockLobbyByCode(client, code);
    if (lobby.status !== "lobby") throw new AppError(409, "lobby_started", "This lobby has already started.");

    const playerId = id();
    const token = secretToken();
    await client.query(
      `INSERT INTO lobby_players(id, lobby_id, name, token) VALUES ($1, $2, $3, $4)`,
      [playerId, lobby.id, parsed.name, token],
    );
    await client.query(
      `INSERT INTO standings(lobby_id, player_id) VALUES ($1, $2)`,
      [lobby.id, playerId],
    );
    await recordEvent(client, lobby.id, null, playerId, "player.joined", { name: parsed.name });
    await bumpLobbyVersion(client, lobby.id);
    return { code: lobby.code, token, playerId };
  });
}

export async function getLobbyState(code: string, token?: string | null): Promise<PublicLobbyState> {
  const lobbyResult = await query<LobbyRow>(`SELECT * FROM lobbies WHERE upper(code) = upper($1)`, [code]);
  const lobby = lobbyResult.rows[0];
  if (!lobby) throw new AppError(404, "not_found", "Lobby not found.");

  const playersResult = await query<LobbyPlayerRow>(
    `SELECT * FROM lobby_players WHERE lobby_id = $1 AND active = true ORDER BY joined_at ASC`,
    [lobby.id],
  );
  const viewer = token ? playersResult.rows.find((player) => player.token === token) ?? null : null;
  const activeMatch = lobby.active_match_id ? await buildPublicMatch(getPool(), lobby, lobby.active_match_id, viewer?.id ?? null) : null;
  const standings = await query<{
    player_id: string;
    wins: number;
    losses: number;
    ties: number;
    total_matches: number;
  }>(
    `SELECT player_id, wins, losses, ties, total_matches FROM standings WHERE lobby_id = $1 ORDER BY wins DESC, ties DESC, updated_at ASC`,
    [lobby.id],
  );
  const events = await query<{
    id: string;
    player_id: string | null;
    type: string;
    payload: Record<string, unknown>;
    created_at: Date;
  }>(
    `SELECT id, player_id, type, payload, created_at FROM events WHERE lobby_id = $1 ORDER BY created_at DESC LIMIT 30`,
    [lobby.id],
  );

  return {
    code: lobby.code,
    status: lobby.status,
    mode: lobby.mode,
    capType: lobby.cap_type,
    capAmount: lobby.cap_amount,
    rerollsEnabled: lobby.rerolls_enabled,
    stateVersion: lobby.state_version,
    hostPlayerId: lobby.host_player_id,
    viewerPlayerId: viewer?.id ?? null,
    players: playersResult.rows.map((player) => ({
      id: player.id,
      name: player.name,
      joinedAt: player.joined_at.toISOString(),
      isYou: player.id === viewer?.id,
    })),
    activeMatch,
    standings: standings.rows.map((row) => ({
      playerId: row.player_id,
      wins: Number(row.wins),
      losses: Number(row.losses),
      ties: Number(row.ties),
      totalMatches: Number(row.total_matches),
    })),
    events: events.rows.map((event) => ({
      id: event.id,
      playerId: event.player_id,
      type: event.type,
      payload: event.payload,
      createdAt: event.created_at.toISOString(),
    })),
  };
}

export async function applyLobbyAction(code: string, input: ActionInput) {
  const parsed = ActionSchema.parse(input);
  await withTransaction(async (client) => {
    const lobby = await lockLobbyByCode(client, code);
    if (typeof parsed.expectedVersion === "number" && parsed.expectedVersion !== lobby.state_version) {
      throw new AppError(409, "stale_state", "This action was based on stale lobby state. Refresh and try again.");
    }
    const actor = await requirePlayerByToken(client, lobby.id, parsed.token);

    if (parsed.action === "settings") {
      await updateSettings(client, lobby, actor, parsed);
    } else if (parsed.action === "start") {
      await startMatch(client, lobby, actor);
    } else if (parsed.action === "next-match") {
      await startNextMatch(client, lobby, actor);
    } else {
      const match = await requireActiveMatch(client, lobby);
      if (match.mode === "parallel") await applyParallelAction(client, lobby, match, actor, parsed);
      else await applySnakeAction(client, lobby, match, actor, parsed);
      await maybeCompleteMatch(client, lobby, match.id);
    }

    await bumpLobbyVersion(client, lobby.id);
  });

  return getLobbyState(code, parsed.token);
}

async function createUniqueCode(client: PoolClient) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const code = lobbyCode();
    const existing = await client.query(`SELECT 1 FROM lobbies WHERE code = $1`, [code]);
    if (existing.rowCount === 0) return code;
  }
  throw new AppError(500, "code_generation_failed", "Could not create a unique lobby code.");
}

async function lockLobbyByCode(client: PoolClient, code: string) {
  const result = await client.query<LobbyRow>(`SELECT * FROM lobbies WHERE upper(code) = upper($1) FOR UPDATE`, [code]);
  const lobby = result.rows[0];
  if (!lobby) throw new AppError(404, "not_found", "Lobby not found.");
  return lobby;
}

async function requirePlayerByToken(client: PoolClient, lobbyId: string, token: string) {
  const result = await client.query<LobbyPlayerRow>(
    `SELECT * FROM lobby_players WHERE lobby_id = $1 AND token = $2 AND active = true`,
    [lobbyId, token],
  );
  const player = result.rows[0];
  if (!player) throw new AppError(403, "not_player", "You are not a player in this lobby.");
  return player;
}

async function requireActiveMatch(client: PoolClient, lobby: LobbyRow) {
  if (lobby.status !== "active" || !lobby.active_match_id) throw new AppError(409, "no_active_match", "No active match is running.");
  const result = await client.query<MatchRow>(`SELECT * FROM matches WHERE id = $1 FOR UPDATE`, [lobby.active_match_id]);
  const match = result.rows[0];
  if (!match || match.status !== "active") throw new AppError(409, "no_active_match", "No active match is running.");
  return match;
}

async function updateSettings(client: PoolClient, lobby: LobbyRow, actor: LobbyPlayerRow, parsed: z.infer<typeof ActionSchema>) {
  if (lobby.status !== "lobby") throw new AppError(409, "lobby_started", "Settings are locked after the match starts.");
  if (lobby.host_player_id && lobby.host_player_id !== actor.id) {
    throw new AppError(403, "host_only", "Only the host can change lobby settings.");
  }
  const mode = parsed.mode ?? lobby.mode;
  const capType = parsed.capType ?? lobby.cap_type;
  const capAmount = capAmountFor(capType);
  const rerolls = parsed.rerollsEnabled ?? lobby.rerolls_enabled;
  await client.query(
    `UPDATE lobbies SET mode = $2, cap_type = $3, cap_amount = $4, rerolls_enabled = $5, updated_at = now() WHERE id = $1`,
    [lobby.id, mode, capType, capAmount, rerolls],
  );
  await recordEvent(client, lobby.id, null, actor.id, "settings.updated", { mode, capType, capAmount, rerollsEnabled: rerolls });
}

async function startMatch(client: PoolClient, lobby: LobbyRow, actor: LobbyPlayerRow) {
  if (lobby.status !== "lobby") throw new AppError(409, "already_started", "This lobby has already started.");
  if (lobby.host_player_id && lobby.host_player_id !== actor.id) throw new AppError(403, "host_only", "Only the host can start.");
  await createMatch(client, lobby, null, 1);
}

async function startNextMatch(client: PoolClient, lobby: LobbyRow, actor: LobbyPlayerRow) {
  if (lobby.status !== "results") throw new AppError(409, "not_results", "The lobby is not ready for another match.");
  if (lobby.host_player_id && lobby.host_player_id !== actor.id) throw new AppError(403, "host_only", "Only the host can start another match.");
  const roundResult = await client.query<{ next_round: number }>(
    `SELECT coalesce(max(round_no), 0) + 1 AS next_round FROM matches WHERE lobby_id = $1`,
    [lobby.id],
  );
  await createMatch(client, lobby, null, Number(roundResult.rows[0]?.next_round ?? 1));
}

async function createMatch(client: PoolClient, lobby: LobbyRow, participantIds: string[] | null, roundNo: number, tiebreakerOf?: string) {
  const players = participantIds
    ? participantIds
    : (await client.query<LobbyPlayerRow>(`SELECT * FROM lobby_players WHERE lobby_id = $1 AND active = true ORDER BY joined_at ASC`, [lobby.id])).rows.map((player) => player.id);
  if (players.length < 2) throw new AppError(409, "not_enough_players", "At least two players are required.");

  const matchId = id();
  const currentTurn = lobby.mode === "snake" ? players[0] : null;
  await client.query(
    `INSERT INTO matches(id, lobby_id, mode, round_no, status, participant_ids, current_turn_player_id, tiebreaker_of)
     VALUES ($1, $2, $3, $4, 'active', $5::uuid[], $6, $7)`,
    [matchId, lobby.id, lobby.mode, roundNo, players, currentTurn, tiebreakerOf ?? null],
  );

  for (const playerId of players) {
    await client.query(
      `INSERT INTO runs(id, lobby_id, match_id, player_id, status, lineup)
       VALUES ($1, $2, $3, $4, 'active', '{}')`,
      [id(), lobby.id, matchId, playerId],
    );
  }

  await client.query(
    `UPDATE lobbies SET status = 'active', active_match_id = $2, updated_at = now() WHERE id = $1`,
    [lobby.id, matchId],
  );
  await recordEvent(client, lobby.id, matchId, null, tiebreakerOf ? "match.tiebreaker_started" : "match.started", { participantIds: players });
  if (lobby.mode === "snake") await advanceSnakeTurn(client, { ...lobby, active_match_id: matchId }, matchId);
}

async function applyParallelAction(client: PoolClient, lobby: LobbyRow, match: MatchRow, actor: LobbyPlayerRow, parsed: z.infer<typeof ActionSchema>) {
  const run = await requireRun(client, match.id, actor.id);
  if (run.status !== "active") throw new AppError(409, "run_not_active", "Your run is not active.");
  await autoLoseIfNoLegalPick(client, lobby, match, run, false);
  const freshRun = await requireRun(client, match.id, actor.id);
  if (freshRun.status !== "active") return;

  if (parsed.action === "spin") {
    if (freshRun.current_spin) throw new AppError(409, "spin_already_active", "Pick from the current spin before spinning again.");
    const spin = await chooseLegalSpin(client, lobby, match, freshRun, false);
    await client.query(`UPDATE runs SET current_spin = $2, updated_at = now() WHERE id = $1`, [freshRun.id, JSON.stringify(spin)]);
    await recordEvent(client, lobby.id, match.id, actor.id, "run.spin", spin);
    return;
  }

  if (parsed.action === "reroll-team" || parsed.action === "reroll-decade") {
    await rerollRunSpin(client, lobby, match, freshRun, actor.id, parsed.action === "reroll-team" ? "team" : "decade", false);
    return;
  }

  if (parsed.action === "pick") {
    await placePick(client, lobby, match, freshRun, actor.id, parsed.playerSeasonId, parsed.position, false);
    return;
  }

  throw new AppError(400, "invalid_action", "That action is not valid for Parallel Cap Race.");
}

async function applySnakeAction(client: PoolClient, lobby: LobbyRow, match: MatchRow, actor: LobbyPlayerRow, parsed: z.infer<typeof ActionSchema>) {
  if (match.current_turn_player_id !== actor.id) throw new AppError(403, "not_your_turn", "Only the current drafter can act.");
  const run = await requireRun(client, match.id, actor.id);
  if (run.status !== "active") throw new AppError(409, "run_not_active", "Your draft is not active.");
  const currentSpin = match.current_spin;

  if (parsed.action === "spin") {
    if (currentSpin) throw new AppError(409, "spin_already_active", "Pick from the current spin before spinning again.");
    const spin = await chooseLegalSpin(client, lobby, match, run, true);
    await client.query(`UPDATE matches SET current_spin = $2 WHERE id = $1`, [match.id, JSON.stringify(spin)]);
    await recordEvent(client, lobby.id, match.id, actor.id, "draft.spin", spin);
    return;
  }

  if (parsed.action === "reroll-team" || parsed.action === "reroll-decade") {
    if (!lobby.rerolls_enabled) throw new AppError(409, "rerolls_disabled", "Rerolls are disabled for this draft.");
    await rerollRunSpin(client, lobby, match, run, actor.id, parsed.action === "reroll-team" ? "team" : "decade", true);
    return;
  }

  if (parsed.action === "pick") {
    if (!currentSpin) throw new AppError(409, "spin_required", "Spin before picking.");
    await placePick(client, lobby, match, { ...run, current_spin: currentSpin }, actor.id, parsed.playerSeasonId, parsed.position, true);
    await client.query(`UPDATE matches SET current_pick_index = current_pick_index + 1 WHERE id = $1`, [match.id]);
    await advanceSnakeTurn(client, lobby, match.id);
    return;
  }

  throw new AppError(400, "invalid_action", "That action is not valid for Shared Snake Draft.");
}

async function requireRun(client: PoolClient, matchId: string, playerId: string) {
  const result = await client.query<RunRow>(`SELECT * FROM runs WHERE match_id = $1 AND player_id = $2 FOR UPDATE`, [matchId, playerId]);
  const run = result.rows[0];
  if (!run) throw new AppError(404, "run_not_found", "Run not found.");
  return normalizeRunRow(run);
}

function normalizeRunRow(row: RunRow): RunRow {
  return {
    ...row,
    current_spin: row.current_spin ?? null,
    lineup: row.lineup ?? {},
    final_result: row.final_result ?? null,
  };
}

async function chooseLegalSpin(client: PoolClient, lobby: LobbyRow, match: MatchRow, run: RunRow, shared: boolean) {
  const options = await legalTeamEras(client, lobby, match, run, shared);
  if (options.length === 0) {
    await loseRun(client, lobby, match.id, run.id, run.player_id, "No legal affordable pick remains.");
    throw new AppError(409, "no_legal_pick", "No legal affordable pick remains.");
  }
  return pickRandom(options);
}

async function rerollRunSpin(client: PoolClient, lobby: LobbyRow, match: MatchRow, run: RunRow, playerId: string, part: "team" | "decade", shared: boolean) {
  const currentSpin = shared ? match.current_spin : run.current_spin;
  if (!currentSpin) throw new AppError(409, "spin_required", "Spin before rerolling.");
  if (part === "team" && run.team_reroll_used) throw new AppError(409, "team_reroll_used", "Team reroll already used.");
  if (part === "decade" && run.decade_reroll_used) throw new AppError(409, "decade_reroll_used", "Decade reroll already used.");

  const options = (await legalTeamEras(client, lobby, match, run, shared)).filter((option) =>
    part === "team" ? option.era === currentSpin.era && option.team !== currentSpin.team : option.team === currentSpin.team && option.era !== currentSpin.era,
  );
  if (options.length === 0) throw new AppError(409, "no_reroll_options", "No legal reroll option is available.");

  const spin = pickRandom(options);
  if (shared) {
    await client.query(
      `UPDATE matches SET current_spin = $2 WHERE id = $1`,
      [match.id, JSON.stringify(spin)],
    );
  } else {
    await client.query(
      `UPDATE runs SET current_spin = $2, updated_at = now() WHERE id = $1`,
      [run.id, JSON.stringify(spin)],
    );
  }
  await client.query(
    `UPDATE runs SET ${part === "team" ? "team_reroll_used" : "decade_reroll_used"} = true, updated_at = now() WHERE id = $1`,
    [run.id],
  );
  await recordEvent(client, lobby.id, match.id, playerId, `run.reroll_${part}`, spin);
}

async function placePick(
  client: PoolClient,
  lobby: LobbyRow,
  match: MatchRow,
  run: RunRow,
  playerId: string,
  playerSeasonId: string | undefined,
  position: Position | undefined,
  shared: boolean,
) {
  if (!playerSeasonId || !position) throw new AppError(400, "missing_pick", "A player and position are required.");
  const spin = shared ? match.current_spin : run.current_spin;
  if (!spin) throw new AppError(409, "spin_required", "Spin before picking.");
  if (!POSITIONS.includes(position)) throw new AppError(400, "bad_position", "Invalid position.");
  if (run.lineup[position]) throw new AppError(409, "position_filled", "That lineup slot is already filled.");

  const player = await getPlayerSeason(client, playerSeasonId);
  if (!player) throw new AppError(404, "player_not_found", "Player not found.");
  if (player.team !== spin.team || player.era !== spin.era) throw new AppError(409, "wrong_pool", "Player is not in the active spin pool.");
  if (!player.positions.includes(position)) throw new AppError(409, "wrong_position", "Player cannot play that position.");

  const excluded = shared ? await selectedIdsForMatch(client, match.id) : selectedPlayerIds(run.lineup);
  if (excluded.includes(player.player_id)) throw new AppError(409, "duplicate_player", "That player was already drafted.");
  const filled = slotCount(run.lineup);
  if (!isLegalCost(player.cost, lobby.cap_type, lobby.cap_amount, run.cap_spent, filled)) {
    throw new AppError(409, "cap_violation", "That pick would leave too little budget for the remaining roster slots.");
  }

  const lineup = { ...run.lineup, [position]: toLineupSlot(position, player.data, player.cost) };
  const capSpent = run.cap_spent + player.cost;
  const pickCount = await client.query<{ next_pick: number }>(
    `SELECT coalesce(max(pick_number), 0) + 1 AS next_pick FROM picks WHERE match_id = $1`,
    [match.id],
  );
  const nextPick = Number(pickCount.rows[0]?.next_pick ?? 1);

  await client.query(
    `INSERT INTO picks(id, lobby_id, match_id, run_id, player_id, player_season_id, position, team, era, cost, pick_number)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [id(), lobby.id, match.id, run.id, playerId, player.player_id, position, player.team, player.era, player.cost, nextPick],
  );

  const playerLineup = POSITIONS.map((slot) => lineup[slot]).filter(Boolean);
  if (playerLineup.length === 5) {
    const localPlayers = playerLineup.map((slot) => getLocalPlayer(slot!.playerId)).filter(Boolean) as PlayerSeason[];
    const finalResult = scoreLineup(localPlayers, lobby.cap_type, lobby.cap_amount, capSpent);
    await client.query(
      `UPDATE runs SET status = 'finished', round = 5, cap_spent = $2, current_spin = null, lineup = $3::jsonb, final_result = $4::jsonb, updated_at = now()
       WHERE id = $1`,
      [run.id, capSpent, JSON.stringify(lineup), JSON.stringify(finalResult)],
    );
    await recordEvent(client, lobby.id, match.id, playerId, "run.finished", { result: finalResult });
  } else {
    await client.query(
      `UPDATE runs SET round = $2, cap_spent = $3, current_spin = null, lineup = $4::jsonb, updated_at = now()
       WHERE id = $1`,
      [run.id, playerLineup.length + 1, capSpent, JSON.stringify(lineup)],
    );
    await autoLoseIfNoLegalPick(client, lobby, match, { ...run, lineup, cap_spent: capSpent, current_spin: null }, shared);
  }

  if (shared) {
    await client.query(`UPDATE matches SET current_spin = null WHERE id = $1`, [match.id]);
  }

  await recordEvent(client, lobby.id, match.id, playerId, "pick.made", { player: player.player_name, position, cost: player.cost });
}

async function autoLoseIfNoLegalPick(client: PoolClient, lobby: LobbyRow, match: MatchRow, run: RunRow, shared: boolean) {
  if (run.status !== "active") return;
  if (slotCount(run.lineup) >= 5) return;
  if (lobby.cap_type !== "hard") return;
  const options = await legalTeamEras(client, lobby, match, run, shared);
  if (options.length === 0) {
    await loseRun(client, lobby, match.id, run.id, run.player_id, "No legal affordable pick remains.");
  }
}

async function loseRun(client: PoolClient, lobby: LobbyRow, matchId: string, runId: string, playerId: string, reason: string) {
  const finalResult = {
    team_ovr: 0,
    wins: 0,
    losses: 82,
    grade: "F",
    label: "CAP BUSTED",
    reasons: [reason],
  };
  await client.query(
    `UPDATE runs SET status = 'lost', current_spin = null, final_result = $2::jsonb, lost_reason = $3, updated_at = now() WHERE id = $1`,
    [runId, JSON.stringify(finalResult), reason],
  );
  await recordEvent(client, lobby.id, matchId, playerId, "run.lost", { reason });
}

async function legalTeamEras(client: PoolClient, lobby: LobbyRow, match: MatchRow, run: RunRow, shared: boolean): Promise<Spin[]> {
  const open = openPositions(run.lineup);
  if (open.length === 0) return [];
  const excluded = shared ? await selectedIdsForMatch(client, match.id) : selectedPlayerIds(run.lineup);
  const maxCost = maxLegalCost(lobby.cap_type, lobby.cap_amount, run.cap_spent, slotCount(run.lineup));
  if (maxCost < 3) return [];
  const result = await client.query<Spin>(
    `SELECT te.team, te.era
     FROM team_eras te
     WHERE EXISTS (
       SELECT 1
       FROM player_seasons ps
       WHERE ps.team = te.team
         AND ps.era = te.era
         AND NOT (ps.player_id = ANY($1::text[]))
         AND ps.positions && $2::text[]
         AND ($3::boolean = true OR ps.cost <= $4)
     )
     ORDER BY te.team, te.era`,
    [excluded, open, lobby.cap_type === "soft", Number.isFinite(maxCost) ? maxCost : 999],
  );
  return result.rows;
}

async function selectedIdsForMatch(client: DbClient, matchId: string) {
  const result = await client.query<{ player_season_id: string }>(`SELECT player_season_id FROM picks WHERE match_id = $1`, [matchId]);
  return result.rows.map((row) => row.player_season_id);
}

async function getPlayerSeason(client: DbClient, playerSeasonId: string) {
  const result = await client.query<PlayerSeasonRow>(
    `SELECT player_id, player_name, team, era, positions, cost, data FROM player_seasons WHERE player_id = $1`,
    [playerSeasonId],
  );
  return result.rows[0] ?? null;
}

async function buildCandidates(client: DbClient, lobby: LobbyRow, match: MatchRow, run: RunRow | null, spin: Spin | null, shared: boolean): Promise<Candidate[]> {
  if (!spin || !run || run.status !== "active") return [];
  const excluded = shared ? await selectedIdsForMatch(client, match.id) : selectedPlayerIds(run.lineup);
  const open = openPositions(run.lineup);
  const maxCost = maxLegalCost(lobby.cap_type, lobby.cap_amount, run.cap_spent, slotCount(run.lineup));
  const result = await client.query<PlayerSeasonRow>(
    `SELECT player_id, player_name, team, era, positions, cost, data
     FROM player_seasons
     WHERE team = $1 AND era = $2 AND NOT (player_id = ANY($3::text[]))
     ORDER BY (data->>'overall')::numeric DESC, player_name ASC`,
    [spin.team, spin.era, excluded],
  );
  return result.rows.map((row) => {
    const player = row.data;
    const openForPlayer = player.positions.filter((position) => open.includes(position));
    const affordable = lobby.cap_type === "soft" || row.cost <= maxCost;
    return {
      id: row.player_id,
      player: row.player_name,
      team: row.team,
      era: row.era,
      positions: row.positions,
      overall: player.overall,
      perGame: player.perGame,
      ratings: player.ratings,
      cost: row.cost,
      assignable: openForPlayer.length > 0 && affordable,
      affordable,
      openPositions: openForPlayer,
    };
  });
}

async function advanceSnakeTurn(client: PoolClient, lobby: LobbyRow, matchId: string) {
  let match = (await client.query<MatchRow>(`SELECT * FROM matches WHERE id = $1 FOR UPDATE`, [matchId])).rows[0];
  if (!match || match.status !== "active" || match.mode !== "snake") return;

  for (let guard = 0; guard < match.participant_ids.length * 5 + 5; guard += 1) {
    const runs = (await client.query<RunRow>(`SELECT * FROM runs WHERE match_id = $1 ORDER BY created_at ASC FOR UPDATE`, [matchId])).rows.map(normalizeRunRow);
    if (runs.every((run) => run.status !== "active")) return;

    const nextPlayerId = playerForSnakePick(match.participant_ids, match.current_pick_index);
    const run = runs.find((candidate) => candidate.player_id === nextPlayerId);
    if (run && run.status === "active" && slotCount(run.lineup) < 5) {
      await autoLoseIfNoLegalPick(client, lobby, match, run, true);
      const updatedRun = await requireRun(client, matchId, nextPlayerId);
      if (updatedRun.status === "active") {
        const spin = await chooseLegalSpin(client, lobby, match, updatedRun, true);
        await client.query(
          `UPDATE matches SET current_turn_player_id = $2, current_spin = $3::jsonb WHERE id = $1`,
          [matchId, nextPlayerId, JSON.stringify(spin)],
        );
        return;
      }
    }

    await client.query(`UPDATE matches SET current_pick_index = current_pick_index + 1, current_spin = null WHERE id = $1`, [matchId]);
    match = (await client.query<MatchRow>(`SELECT * FROM matches WHERE id = $1 FOR UPDATE`, [matchId])).rows[0];
  }
}

function playerForSnakePick(participantIds: string[], pickIndex: number) {
  const count = participantIds.length;
  const round = Math.floor(pickIndex / count);
  const offset = pickIndex % count;
  return round % 2 === 0 ? participantIds[offset] : participantIds[count - 1 - offset];
}

async function maybeCompleteMatch(client: PoolClient, lobby: LobbyRow, matchId: string) {
  const match = (await client.query<MatchRow>(`SELECT * FROM matches WHERE id = $1 FOR UPDATE`, [matchId])).rows[0];
  if (!match || match.status !== "active") return;
  const runs = (await client.query<RunRow>(`SELECT * FROM runs WHERE match_id = $1 FOR UPDATE`, [matchId])).rows.map(normalizeRunRow);
  if (!runs.every((run) => run.status === "finished" || run.status === "lost")) return;

  const scored = runs.map((run) => ({
    playerId: run.player_id,
    wins: run.final_result?.wins ?? 0,
    status: run.status,
  }));
  const maxWins = Math.max(...scored.map((row) => row.wins));
  const winners = scored.filter((row) => row.wins === maxWins).map((row) => row.playerId);

  await client.query(
    `UPDATE matches SET status = 'complete', winner_ids = $2::uuid[], completed_at = now(), current_spin = null WHERE id = $1`,
    [match.id, winners],
  );
  await recordEvent(client, lobby.id, match.id, null, "match.completed", { winnerIds: winners, maxWins });

  if (winners.length > 1) {
    await client.query(
      `UPDATE standings
       SET ties = ties + CASE WHEN player_id = ANY($2::uuid[]) THEN 1 ELSE 0 END,
           losses = losses + CASE WHEN player_id = ANY($2::uuid[]) THEN 0 ELSE 1 END,
           total_matches = total_matches + 1,
           updated_at = now()
       WHERE lobby_id = $1 AND player_id = ANY($3::uuid[])`,
      [lobby.id, winners, match.participant_ids],
    );
    await createMatch(client, lobby, winners, match.round_no + 1, match.id);
    return;
  }

  const winner = winners[0];
  await client.query(
    `UPDATE standings
     SET wins = wins + CASE WHEN player_id = $2 THEN 1 ELSE 0 END,
         losses = losses + CASE WHEN player_id = $2 THEN 0 ELSE 1 END,
         total_matches = total_matches + 1,
         updated_at = now()
     WHERE lobby_id = $1 AND player_id = ANY($3::uuid[])`,
    [lobby.id, winner, match.participant_ids],
  );
  await client.query(`UPDATE lobbies SET status = 'results', active_match_id = $2, updated_at = now() WHERE id = $1`, [lobby.id, match.id]);
}

async function buildPublicMatch(client: DbClient, lobby: LobbyRow, matchId: string, viewerPlayerId: string | null): Promise<PublicMatch | null> {
  const match = (await client.query<MatchRow>(`SELECT * FROM matches WHERE id = $1`, [matchId])).rows[0];
  if (!match) return null;
  const runs = (await client.query<RunRow>(`SELECT * FROM runs WHERE match_id = $1 ORDER BY created_at ASC`, [match.id])).rows.map(normalizeRunRow);
  const publicRuns = runs.map(publicRunForLobby(lobby));
  const currentRun = match.mode === "snake"
    ? runs.find((run) => run.player_id === match.current_turn_player_id) ?? null
    : runs.find((run) => run.player_id === viewerPlayerId) ?? null;
  const currentSpin = match.mode === "snake" ? match.current_spin : currentRun?.current_spin ?? null;
  const candidates = await buildCandidates(client, lobby, match, currentRun, currentSpin, match.mode === "snake");

  return {
    id: match.id,
    mode: match.mode,
    roundNo: match.round_no,
    status: match.status,
    participantIds: match.participant_ids,
    currentTurnPlayerId: match.current_turn_player_id,
    currentPickIndex: match.current_pick_index,
    currentSpin,
    winnerIds: match.winner_ids ?? [],
    tiebreakerOf: match.tiebreaker_of,
    runs: publicRuns,
    candidates,
  };
}

function publicRunForLobby(lobby: LobbyRow) {
  return (run: RunRow): PublicRun => ({
    id: run.id,
    playerId: run.player_id,
    status: run.status,
    round: run.round,
    capSpent: run.cap_spent,
    budgetLeft: lobby.cap_amount - run.cap_spent,
    teamRerollUsed: run.team_reroll_used,
    decadeRerollUsed: run.decade_reroll_used,
    currentSpin: run.current_spin,
    lineup: run.lineup,
    picks: POSITIONS.map((position) => run.lineup[position]).filter(Boolean) as PublicRun["picks"],
    finalResult: run.final_result,
    lostReason: run.lost_reason,
  });
}

async function bumpLobbyVersion(client: PoolClient, lobbyId: string) {
  const result = await client.query<{ state_version: number }>(
    `UPDATE lobbies SET state_version = state_version + 1, updated_at = now() WHERE id = $1 RETURNING state_version`,
    [lobbyId],
  );
  await client.query(
    `INSERT INTO game_state(lobby_id, state_version, snapshot, updated_at)
     VALUES ($1, $2, '{}', now())
     ON CONFLICT (lobby_id) DO UPDATE SET state_version = excluded.state_version, updated_at = now()`,
    [lobbyId, result.rows[0]?.state_version ?? 0],
  );
}

async function recordEvent(client: PoolClient, lobbyId: string, matchId: string | null, playerId: string | null, type: string, payload: Record<string, unknown>) {
  await client.query(
    `INSERT INTO events(id, lobby_id, match_id, player_id, type, payload) VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    [id(), lobbyId, matchId, playerId, type, JSON.stringify(payload)],
  );
}
