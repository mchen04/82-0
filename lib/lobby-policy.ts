import type { LobbyStatus } from "./types";

export const LOBBY_LIFECYCLE_POLICY = {
  openIdleHours: 24,
  activeIdleHours: 72,
  resultsViewDays: 30,
  closedRetentionDays: 30,
} as const;

export type LifecycleLobby = {
  id: string;
  status: LobbyStatus;
  expires_at: Date;
};

export function shouldCloseLobby(lobby: LifecycleLobby, now = new Date()) {
  return lobby.status !== "closed" && lobby.expires_at.getTime() <= now.getTime();
}

export function expirationSql(anchor = "now()") {
  return `CASE status
    WHEN 'lobby' THEN ${anchor} + interval '${LOBBY_LIFECYCLE_POLICY.openIdleHours} hours'
    WHEN 'active' THEN ${anchor} + interval '${LOBBY_LIFECYCLE_POLICY.activeIdleHours} hours'
    WHEN 'results' THEN ${anchor} + interval '${LOBBY_LIFECYCLE_POLICY.resultsViewDays} days'
    ELSE expires_at
  END`;
}
