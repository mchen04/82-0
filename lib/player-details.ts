import { formatStat } from "./rules";
import type { Candidate, LineupSlot } from "./types";

type DetailPlayer = Candidate | LineupSlot;

function optionalStat(label: string, value: number | undefined) {
  return typeof value === "number" ? `${label} ${formatStat(value)}` : null;
}

export function playerStatDetails(player: DetailPlayer) {
  const perGame = [
    optionalStat("PPG", player.perGame.ppg),
    optionalStat("RPG", player.perGame.rpg),
    optionalStat("APG", player.perGame.apg),
    optionalStat("SPG", player.perGame.spg),
    optionalStat("BPG", player.perGame.bpg),
  ].filter(Boolean);
  const ratings = [
    optionalStat("OVR", player.overall),
    optionalStat("CRE", player.ratings.creation),
    optionalStat("SCO", player.ratings.scoring),
    optionalStat("EFF", player.ratings.efficiency),
    optionalStat("DEF", player.ratings.defense),
    optionalStat("REB", player.ratings.rebounding),
    optionalStat("RIM", player.ratings.rimProtection),
    optionalStat("SG", player.ratings.shootingGravity),
    optionalStat("OG", player.ratings.offensiveGravity),
    optionalStat("TO", player.ratings.turnoverControl),
  ].filter(Boolean);

  return [
    `${player.player} | ${player.positions.join("/")} | ${player.team} ${player.era} | $${player.cost}`,
    perGame.join(" / "),
    ratings.join(" / "),
  ].join("\n");
}
