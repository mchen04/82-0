import type { PoolClient } from "pg";
import type { DbClient } from "./db";
import { AppError } from "./errors";
import type { CapType, Lineup, LobbyMode, LobbyStatus, PlayerSeason, Position, ProjectedResult, Spin } from "./types";

export type LobbyRow = {
  id: string;
  code: string;
  mode: LobbyMode;
  cap_type: CapType;
  cap_amount: number;
  status: LobbyStatus;
  rerolls_enabled: boolean;
  host_player_id: string | null;
  active_match_id: string | null;
  state_version: number;
  last_activity_at: Date;
  expires_at: Date;
  closed_at: Date | null;
  close_reason: "expired" | "manual" | null;
};

export type LobbyPlayerRow = {
  id: string;
  lobby_id: string;
  name: string;
  token: string;
  active: boolean;
  joined_at: Date;
};

export type MatchRow = {
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

export type RunRow = {
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
  final_result: ProjectedResult | null;
  lost_reason: string | null;
};

export type PlayerSeasonRow = {
  player_id: string;
  player_name: string;
  team: string;
  era: string;
  positions: Position[];
  cost: number;
  data: PlayerSeason;
};

const LOBBY_COLUMNS = `
  id,
  code,
  mode,
  cap_type,
  cap_amount,
  status,
  rerolls_enabled,
  host_player_id,
  active_match_id,
  state_version,
  last_activity_at,
  expires_at,
  closed_at,
  close_reason
`;

const LOBBY_PLAYER_COLUMNS = "id, lobby_id, name, token, active, joined_at";
const MATCH_COLUMNS = "id, lobby_id, mode, round_no, status, participant_ids, current_turn_player_id, current_pick_index, current_spin, winner_ids, tiebreaker_of";
const RUN_COLUMNS = "id, lobby_id, match_id, player_id, status, round, cap_spent, team_reroll_used, decade_reroll_used, current_spin, lineup, final_result, lost_reason";

export function normalizeCode(code: string) {
  return code.trim().toUpperCase();
}

export async function getLobbyByCode(client: DbClient, code: string) {
  const result = await client.query<LobbyRow>(`SELECT ${LOBBY_COLUMNS} FROM lobbies WHERE code = $1`, [normalizeCode(code)]);
  const lobby = result.rows[0];
  if (!lobby) throw new AppError(404, "not_found", "Lobby not found.");
  return lobby;
}

export async function lockLobbyByCode(client: PoolClient, code: string) {
  const result = await client.query<LobbyRow>(`SELECT ${LOBBY_COLUMNS} FROM lobbies WHERE code = $1 FOR UPDATE`, [normalizeCode(code)]);
  const lobby = result.rows[0];
  if (!lobby) throw new AppError(404, "not_found", "Lobby not found.");
  return lobby;
}

export async function getActiveLobbyPlayers(client: DbClient, lobbyId: string) {
  return client.query<LobbyPlayerRow>(
    `SELECT ${LOBBY_PLAYER_COLUMNS} FROM lobby_players WHERE lobby_id = $1 AND active = true ORDER BY joined_at ASC`,
    [lobbyId],
  );
}

export async function requirePlayerByToken(client: PoolClient, lobbyId: string, token: string) {
  const result = await client.query<LobbyPlayerRow>(
    `SELECT ${LOBBY_PLAYER_COLUMNS} FROM lobby_players WHERE lobby_id = $1 AND token = $2 AND active = true`,
    [lobbyId, token],
  );
  const player = result.rows[0];
  if (!player) throw new AppError(403, "not_player", "You are not a player in this lobby.");
  return player;
}

export async function requireActiveMatch(client: PoolClient, lobby: LobbyRow) {
  if (lobby.status !== "active" || !lobby.active_match_id) throw new AppError(409, "no_active_match", "No active match is running.");
  const match = await lockMatchById(client, lobby.active_match_id);
  if (!match || match.status !== "active") throw new AppError(409, "no_active_match", "No active match is running.");
  return match;
}

export async function getMatchById(client: DbClient, matchId: string) {
  return (await client.query<MatchRow>(`SELECT ${MATCH_COLUMNS} FROM matches WHERE id = $1`, [matchId])).rows[0] ?? null;
}

export async function lockMatchById(client: PoolClient, matchId: string) {
  return (await client.query<MatchRow>(`SELECT ${MATCH_COLUMNS} FROM matches WHERE id = $1 FOR UPDATE`, [matchId])).rows[0] ?? null;
}

export async function getRunsForMatch(client: DbClient, matchId: string) {
  return (await client.query<RunRow>(`SELECT ${RUN_COLUMNS} FROM runs WHERE match_id = $1 ORDER BY created_at ASC`, [matchId])).rows.map(normalizeRunRow);
}

export async function lockRunsForMatch(client: PoolClient, matchId: string) {
  return (await client.query<RunRow>(`SELECT ${RUN_COLUMNS} FROM runs WHERE match_id = $1 ORDER BY created_at ASC FOR UPDATE`, [matchId])).rows.map(normalizeRunRow);
}

export async function requireRun(client: PoolClient, matchId: string, playerId: string) {
  const result = await client.query<RunRow>(`SELECT ${RUN_COLUMNS} FROM runs WHERE match_id = $1 AND player_id = $2 FOR UPDATE`, [matchId, playerId]);
  const run = result.rows[0];
  if (!run) throw new AppError(404, "run_not_found", "Run not found.");
  return normalizeRunRow(run);
}

export function normalizeRunRow(row: RunRow): RunRow {
  return {
    ...row,
    current_spin: row.current_spin ?? null,
    lineup: row.lineup ?? {},
    final_result: row.final_result ?? null,
  };
}

export async function selectedIdsForMatch(client: DbClient, matchId: string) {
  const result = await client.query<{ player_season_id: string }>(`SELECT player_season_id FROM picks WHERE match_id = $1`, [matchId]);
  return result.rows.map((row) => row.player_season_id);
}

export async function getPlayerSeason(client: DbClient, playerSeasonId: string) {
  const result = await client.query<PlayerSeasonRow>(
    `SELECT player_id, player_name, team, era, positions, cost, data FROM player_seasons WHERE player_id = $1`,
    [playerSeasonId],
  );
  return result.rows[0] ?? null;
}
