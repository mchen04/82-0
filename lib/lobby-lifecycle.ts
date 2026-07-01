import type { QueryResultRow } from "pg";
import { query, type DbClient } from "./db";
import { AppError } from "./errors";
import { id } from "./random";
import { LOBBY_LIFECYCLE_POLICY, shouldCloseLobby, type LifecycleLobby } from "./lobby-policy";

type CleanupResult = {
  closed: number;
  deleted: number;
};

export function lobbyExpiredError() {
  return new AppError(410, "lobby_expired", "Lobby expired.");
}

export async function closeLobbyIfExpired(client: DbClient, lobby: LifecycleLobby) {
  if (lobby.status === "closed") return true;
  if (!shouldCloseLobby(lobby)) return false;

  await client.query(
    `UPDATE lobbies
     SET status = 'closed',
         closed_at = coalesce(closed_at, now()),
         close_reason = 'expired',
         updated_at = now()
     WHERE id = $1`,
    [lobby.id],
  );
  await client.query(
    `INSERT INTO events(id, lobby_id, match_id, player_id, type, payload)
     VALUES ($1, $2, null, null, 'lobby.expired', '{}'::jsonb)`,
    [id(), lobby.id],
  );
  return true;
}

export async function cleanupExpiredLobbies(): Promise<CleanupResult> {
  const closed = await query<QueryResultRow>(
    `WITH closed_lobbies AS (
       UPDATE lobbies
       SET status = 'closed',
           closed_at = coalesce(closed_at, now()),
           close_reason = 'expired',
           updated_at = now()
       WHERE status <> 'closed'
         AND expires_at <= now()
       RETURNING id
     ),
     inserted_events AS (
       INSERT INTO events(id, lobby_id, match_id, player_id, type, payload)
       SELECT gen_random_uuid(), id, null, null, 'lobby.expired', '{}'::jsonb
       FROM closed_lobbies
       RETURNING id
     )
     SELECT count(*)::integer AS count FROM closed_lobbies`,
  );
  const deleted = await query<QueryResultRow>(
    `DELETE FROM lobbies
     WHERE status = 'closed'
       AND closed_at <= now() - interval '${LOBBY_LIFECYCLE_POLICY.closedRetentionDays} days'
     RETURNING id`,
  );
  return {
    closed: Number(closed.rows[0]?.count ?? 0),
    deleted: deleted.rowCount ?? 0,
  };
}
