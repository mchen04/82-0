import { formatStat } from "./rules";
import type { Candidate, LineupSlot } from "./types";

type DetailPlayer = Candidate | LineupSlot;

function optionalStat(label: string, value: number | undefined) {
  return typeof value === "number" ? `${label} ${formatStat(value)}` : null;
}

export function playerStatDetails(player: DetailPlayer) {
  const stats = [
    optionalStat("PPG", player.perGame.ppg),
    optionalStat("APG", player.perGame.apg),
    optionalStat("RPG", player.perGame.rpg),
    optionalStat("DEF", player.ratings.defense),
    optionalStat("GRAV", player.ratings.shootingGravity),
  ].filter(Boolean);

  return [player.player, stats.join(" / ")].join("\n");
}
