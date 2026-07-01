import fs from "node:fs";
import path from "node:path";
import { salary } from "./rules";
import type { GamePack, PlayerSeason, TeamEra } from "./types";

let cachedPack: GamePack | null = null;
let cachedPlayers: Map<string, PlayerSeason> | null = null;

export function loadGamePack(): GamePack {
  if (!cachedPack) {
    const file = path.join(process.cwd(), "data", "game-pack.json");
    cachedPack = JSON.parse(fs.readFileSync(file, "utf8")) as GamePack;
  }
  return cachedPack;
}

export function loadPlayersById() {
  if (!cachedPlayers) {
    cachedPlayers = new Map(loadGamePack().players.map((player) => [player.id, player]));
  }
  return cachedPlayers;
}

export function getLocalPlayer(playerId: string) {
  return loadPlayersById().get(playerId) ?? null;
}

export function teamEras(): TeamEra[] {
  return loadGamePack().teamEras;
}

export function playerCostRows() {
  return loadGamePack().players.map((player) => ({
    ...player,
    cost: salary(player),
  }));
}
