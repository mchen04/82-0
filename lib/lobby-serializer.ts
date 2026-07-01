import type { DbClient } from "./db";
import {
  getMatchById,
  getRunsForMatch,
  selectedIdsForMatch,
  type LobbyRow,
  type MatchRow,
  type PlayerSeasonRow,
  type RunRow,
} from "./lobby-repository";
import { maxLegalCost, openPositions, selectedPlayerIds, slotCount } from "./rules";
import { POSITIONS, type Candidate, type PublicMatch, type PublicRun, type Spin } from "./types";

export async function buildPublicMatch(client: DbClient, lobby: LobbyRow, matchId: string, viewerPlayerId: string | null): Promise<PublicMatch | null> {
  const match = await getMatchById(client, matchId);
  if (!match) return null;
  const runs = await getRunsForMatch(client, match.id);
  const runOrder = new Map(match.participant_ids.map((playerId, index) => [playerId, index]));
  const publicRuns = [...runs]
    .sort((a, b) => (runOrder.get(a.player_id) ?? Number.MAX_SAFE_INTEGER) - (runOrder.get(b.player_id) ?? Number.MAX_SAFE_INTEGER))
    .map(publicRunForLobby(lobby));
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
