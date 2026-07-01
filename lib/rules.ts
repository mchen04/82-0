import { POSITIONS, type CapType, type Lineup, type LineupSlot, type PlayerSeason, type Position, type ProjectedResult } from "./types";

export const CAP_AMOUNT = 88;
export const MINIMUM_SLOT_COST = 3;

const clamp = (value: number, min = 0, max = 100) => Math.max(min, Math.min(max, value));
const avg = (values: number[]) => values.reduce((total, value) => total + value, 0) / values.length;

export function normalizeName(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

export function playerKey(player: PlayerSeason | LineupSlot) {
  return normalizeName(player.player).replace(/[^a-z0-9]+/g, "");
}

export function initials(name: string) {
  const parts = name.split(/\s+/).filter(Boolean);
  return parts.length === 1 ? parts[0].slice(0, 2).toUpperCase() : `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
}

export function formatStat(value: number) {
  return Number(value ?? 0).toFixed(1);
}

export function salary(player: PlayerSeason) {
  const overall = player.overall;
  const ratings = player.ratings;
  let value: number;

  if (overall >= 97) value = 34 + (overall - 97) * 1.1;
  else if (overall >= 93) value = 28 + (overall - 93) * 1;
  else if (overall >= 88) value = 18 + (overall - 88) * 0.85;
  else if (overall >= 82) value = 11 + (overall - 82) * 0.75;
  else if (overall >= 75) value = 7 + (overall - 75) * 0.6;
  else value = 3 + Math.max(0, overall - 55) * 0.25;

  if (ratings.creation >= 90) value += 2;
  else if (ratings.creation >= 80) value += 1;
  if (ratings.scoring >= 90) value += 2;
  else if (ratings.scoring >= 82) value += 1;
  if (ratings.shootingGravity >= 85) value += 2;
  else if (ratings.shootingGravity >= 70) value += 1;
  if (ratings.rimProtection >= 90) value += 2;
  else if (ratings.rimProtection >= 80) value += 1;
  if (ratings.defense >= 90) value += 2;
  else if (ratings.defense >= 82) value += 1;
  if (ratings.rebounding >= 90) value += 2;
  else if (ratings.rebounding >= 80) value += 1;
  if (ratings.defense >= 82 && ratings.shootingGravity >= 65) value += 1;
  if (player.positions.length >= 3) value += 1;
  if ((player.roleScore ?? player.overall) < player.overall - 6) value -= 1;

  return Math.max(3, Math.min(38, Math.round(value)));
}

function fallbackOffensiveGravity(ratings: PlayerSeason["ratings"]) {
  const shooting = ratings.shootingGravity;
  let value = 0.38 * ratings.scoring + 0.28 * ratings.creation + 0.22 * shooting + 0.12 * ratings.efficiency;
  if (ratings.scoring >= 90 && ratings.creation >= 80) value += 6;
  else if (ratings.scoring >= 88 && ratings.creation >= 75) value += 3;
  if (shooting >= 80) value += 3;
  if (shooting < 45 && ratings.creation < 75) value -= 3;
  return Number(clamp(value).toFixed(1));
}

function offensiveGravity(player: PlayerSeason) {
  if (typeof player.ratings.offensiveGravity === "number") return player.ratings.offensiveGravity;

  let value = fallbackOffensiveGravity(player.ratings);
  const role = player.roleProfile ?? {};
  const games = role.gamesPlayed ?? 0;
  const minutes = role.minutesPerGame ?? 0;
  const points = player.perGame?.ppg ?? role.pointsPerGame ?? 0;
  const usage = role.usageLoadPerGame ?? 0;
  const confidence = role.roleConfidence ?? 0;
  const overall = player.overall ?? 50;
  let cap = 100;

  if (confidence < 0.7 || games < 25 || minutes < 18) cap = Math.min(cap, 76);
  else if (games < 65 || minutes < 24) cap = Math.min(cap, 84);
  if (points < 12 && usage < 12) cap = Math.min(cap, 74);
  else if (points < 18 && usage < 18) cap = Math.min(cap, 82);
  if (overall < 70) cap = Math.min(cap, 78);
  else if (overall < 75) cap = Math.min(cap, 84);

  value = Math.min(value, cap);
  return Number(value.toFixed(1));
}

function gradeForWins(wins: number): [string, string] {
  if (wins === 82) return ["S", "PERFECT"];
  if (wins >= 80) return ["S", "NEAR PERFECT"];
  if (wins >= 72) return ["A+", "HISTORIC"];
  if (wins >= 62) return ["A", "DYNASTY"];
  if (wins >= 57) return ["B", "CONTENDER"];
  if (wins >= 50) return ["C", "PLAYOFF"];
  if (wins >= 40) return ["D", "LOTTERY"];
  return ["F", "TANKING"];
}

function winsFromOverall(teamOverall: number) {
  const baseline = (teamOverall - 35) * 1.32;
  const eliteBump = clamp((teamOverall - 72) / 8, 0, 1) * clamp((96 - teamOverall) / 8, 0, 1) * 4;
  const wins = Math.round(clamp(baseline + eliteBump, 0, 82));
  return teamOverall >= 99 ? wins : Math.min(wins, 81);
}

export function projectLineup(players: PlayerSeason[]): ProjectedResult {
  if (players.length !== 5) throw new Error("lineup must contain exactly five players");

  const ratings = players.map((player) => player.ratings);
  const overalls = players.map((player) => player.overall);
  const overallAverage = avg(overalls);
  const maxCreation = Math.max(...ratings.map((rating) => rating.creation));
  const avgScoring = avg(ratings.map((rating) => rating.scoring));
  const avgShooting = avg(ratings.map((rating) => rating.shootingGravity));
  const maxShooting = Math.max(...ratings.map((rating) => rating.shootingGravity));
  const gravity = players.map(offensiveGravity);
  const maxGravity = Math.max(...gravity);
  const avgGravity = avg(gravity);
  const avgDefense = avg(ratings.map((rating) => rating.defense));
  const maxRimProtection = Math.max(...ratings.map((rating) => rating.rimProtection));
  const avgRebounding = avg(ratings.map((rating) => rating.rebounding));
  const avgTurnoverControl = avg(ratings.map((rating) => rating.turnoverControl));
  const topThreeAverage = avg([...overalls].sort((a, b) => b - a).slice(0, 3));
  const lowGravity = ratings.filter((rating) => rating.shootingGravity < 45).length;
  const veryLowGravity = ratings.filter((rating) => rating.shootingGravity < 35).length;
  const interiorNonShooters = ratings.filter((rating) => rating.rimProtection > 80 && rating.shootingGravity < 45).length;
  const eliteShooters = ratings.filter((rating) => rating.shootingGravity >= 78).length;
  const passableShooters = ratings.filter((rating) => rating.shootingGravity >= 60).length;
  const redundantCreators = ratings.filter((rating) => rating.creation >= 75 && rating.shootingGravity < 60).length >= 2;
  const cramped = avgShooting < 58 || lowGravity >= 3;
  let adjustment = 0;
  const reasons: string[] = [];

  if (maxCreation >= 90) {
    adjustment += 2;
    reasons.push("Elite creator");
  } else if (maxCreation < 65) {
    adjustment -= 3.5;
    reasons.push("Weak primary creation");
  }
  if (avgScoring >= 85) {
    adjustment += 1.8;
    reasons.push("Elite scoring pressure");
  }
  if (maxGravity >= 88) {
    adjustment += 1.5;
    reasons.push("Elite offensive gravity");
  } else if (maxGravity >= 82) {
    adjustment += 1;
    reasons.push("Elite offensive gravity");
  }
  if (avgGravity >= 78 && avgShooting < 58) {
    adjustment += 0.8;
    reasons.push("On-ball pressure");
  }
  if (avgShooting >= 75) {
    adjustment += 1.6;
    reasons.push("Strong spacing");
  } else if (maxShooting >= 85) {
    adjustment += 1;
    reasons.push("Elite spacer");
  } else if (avgShooting < 50) {
    adjustment -= 2.5;
    reasons.push("Weak spacing");
  }
  if (lowGravity >= 3) {
    adjustment -= 2;
    reasons.push("Crowded floor");
  }
  if (lowGravity >= 4) adjustment -= 1.5;
  if (veryLowGravity >= 3) {
    adjustment -= 1;
    reasons.push(eliteShooters >= 1 && passableShooters >= 2 ? "Low-gravity frontcourt" : "Too many non-shooters");
  }
  if (interiorNonShooters >= 2) {
    adjustment -= 1.5;
    reasons.push("Paint overlap");
  }
  if (interiorNonShooters >= 3) adjustment -= 1.5;
  if (eliteShooters === 0) {
    adjustment -= 1.5;
    reasons.push("No elite spacer");
  }
  if (maxRimProtection >= 85) {
    adjustment += 1.8;
    reasons.push("Strong rim protection");
  } else if (maxRimProtection < 45) {
    adjustment -= 3;
    reasons.push("No rim protection");
  }
  if (avgDefense >= 75) {
    adjustment += 1.4;
    reasons.push("Strong team defense");
  } else if (avgDefense < 50) {
    adjustment -= 2.5;
    reasons.push("Defensive liability");
  }
  if (avgRebounding < 45) {
    adjustment -= 1.8;
    reasons.push("Weak rebounding");
  }
  if (interiorNonShooters >= 2 && avgRebounding >= 72) {
    adjustment += 2.5;
    reasons.push("Interior wall");
  }
  if (avgDefense >= 68 && maxRimProtection >= 90 && avgRebounding >= 70) {
    adjustment += 1.2;
    reasons.push("Defensive ceiling");
  }
  if (maxCreation >= 90 && avgScoring >= 85 && avgRebounding >= 70) {
    adjustment += 1.5;
    reasons.push("Transition pressure");
  }
  if (topThreeAverage >= 88) {
    adjustment += 3.2;
    reasons.push("Hall of Fame core");
  } else if (topThreeAverage >= 82) {
    adjustment += 1.2;
    reasons.push("High-end talent");
  }
  if (avgTurnoverControl < 30 && (redundantCreators || cramped)) {
    adjustment -= 1;
    reasons.push("Turnover risk");
  } else if (avgTurnoverControl < 45 && redundantCreators && cramped) {
    adjustment -= 0.5;
    reasons.push("Turnover risk");
  }
  if (redundantCreators) {
    const dominantLowGravity = players.filter((player, index) => player.ratings.creation >= 75 && player.ratings.shootingGravity < 60 && gravity[index] >= 82).length;
    adjustment -= dominantLowGravity >= 2 ? 1 : 2;
    reasons.push("Redundant ball-dominant creators");
  }

  const teamOverall = Number(clamp(overallAverage + adjustment).toFixed(1));
  const wins = winsFromOverall(teamOverall);
  const [grade, label] = gradeForWins(wins);
  return {
    team_ovr: teamOverall,
    wins,
    losses: 82 - wins,
    grade,
    label,
    reasons,
  };
}

export function scoreLineup(players: PlayerSeason[], capType: CapType, capAmount: number, spent: number): ProjectedResult {
  const result = projectLineup(players);
  if (capType !== "soft" || spent <= capAmount) return result;

  const overspend = spent - capAmount;
  const penalty = Math.min(24, Math.ceil(overspend / 2));
  const wins = Math.max(0, result.wins - penalty);
  const [grade, label] = gradeForWins(wins);
  return {
    ...result,
    wins,
    losses: 82 - wins,
    grade,
    label,
    softPenaltyWins: penalty,
    softOverspend: overspend,
    reasons: [...result.reasons, `Soft cap penalty: -${penalty} wins`],
  };
}

export function openPositions(lineup: Lineup): Position[] {
  return POSITIONS.filter((position) => !lineup[position]);
}

export function selectedPlayerIds(lineup: Lineup): string[] {
  return POSITIONS.flatMap((position) => {
    const slot = lineup[position];
    return slot ? [slot.playerId] : [];
  });
}

export function slotCount(lineup: Lineup) {
  return POSITIONS.filter((position) => lineup[position]).length;
}

export function eligibleOpenPositions(player: PlayerSeason, lineup: Lineup): Position[] {
  const open = new Set(openPositions(lineup));
  return player.positions.filter((position) => open.has(position));
}

export function maxLegalCost(capType: CapType, capAmount: number, spent: number, filledSlots: number) {
  if (capType === "soft") return Number.POSITIVE_INFINITY;
  const slotsAfterPick = 5 - (filledSlots + 1);
  return capAmount - spent - slotsAfterPick * MINIMUM_SLOT_COST;
}

export function isLegalCost(cost: number, capType: CapType, capAmount: number, spent: number, filledSlots: number) {
  return cost <= maxLegalCost(capType, capAmount, spent, filledSlots);
}

export function toLineupSlot(position: Position, player: PlayerSeason, cost = salary(player)): LineupSlot {
  return {
    position,
    playerId: player.id,
    player: player.player,
    team: player.team,
    era: player.era,
    cost,
    overall: player.overall,
    positions: player.positions,
    perGame: player.perGame,
    ratings: player.ratings,
  };
}
