export const POSITIONS = ["PG", "SG", "SF", "PF", "C"] as const;

export type Position = (typeof POSITIONS)[number];
export type LobbyMode = "parallel" | "snake";
export type CapType = "hard" | "soft";
export type LobbyStatus = "lobby" | "active" | "results";
export type MatchStatus = "active" | "complete";
export type RunStatus = "active" | "finished" | "lost";
export type SortKey = "PPG" | "APG" | "RPG" | "Defense" | "Gravity";

export type Ratings = {
  creation: number;
  defense: number;
  efficiency: number;
  offensiveGravity?: number;
  rebounding: number;
  rimProtection: number;
  scoring: number;
  shootingGravity: number;
  turnoverControl: number;
};

export type PlayerSeason = {
  id: string;
  player: string;
  team: string;
  era: string;
  positions: Position[];
  overall: number;
  perGame: {
    apg: number;
    bpg?: number;
    ppg: number;
    rpg: number;
    spg?: number;
  };
  ratings: Ratings;
  roleProfile?: {
    gamesPlayed?: number;
    minutesPerGame?: number;
    pointsPerGame?: number;
    roleConfidence?: number;
    usageLoadPerGame?: number;
  };
  roleScore?: number;
};

export type TeamEra = {
  team: string;
  era: string;
  count: number;
};

export type GamePack = {
  eras: string[];
  generatedFrom: string;
  meta: {
    players: number;
    teamEraOptions: number;
    [key: string]: unknown;
  };
  players: PlayerSeason[];
  teamEras: TeamEra[];
  teams: string[];
  version: string;
};

export type Spin = {
  team: string;
  era: string;
};

export type LineupSlot = {
  position: Position;
  playerId: string;
  player: string;
  team: string;
  era: string;
  cost: number;
  overall: number;
  positions: Position[];
  perGame: PlayerSeason["perGame"];
  ratings: Ratings;
};

export type Lineup = Partial<Record<Position, LineupSlot>>;

export type ProjectedResult = {
  team_ovr: number;
  wins: number;
  losses: number;
  grade: string;
  label: string;
  reasons: string[];
  softPenaltyWins?: number;
  softOverspend?: number;
};

export type Candidate = {
  id: string;
  player: string;
  team: string;
  era: string;
  positions: Position[];
  overall: number;
  perGame: PlayerSeason["perGame"];
  ratings: Ratings;
  cost: number;
  assignable: boolean;
  affordable: boolean;
  openPositions: Position[];
};

export type PublicPlayer = {
  id: string;
  name: string;
  joinedAt: string;
  isYou: boolean;
};

export type PublicRun = {
  id: string;
  playerId: string;
  status: RunStatus;
  round: number;
  capSpent: number;
  budgetLeft: number;
  teamRerollUsed: boolean;
  decadeRerollUsed: boolean;
  currentSpin: Spin | null;
  lineup: Lineup;
  picks: LineupSlot[];
  finalResult: ProjectedResult | null;
  lostReason: string | null;
};

export type PublicMatch = {
  id: string;
  mode: LobbyMode;
  roundNo: number;
  status: MatchStatus;
  participantIds: string[];
  currentTurnPlayerId: string | null;
  currentPickIndex: number;
  currentSpin: Spin | null;
  winnerIds: string[];
  tiebreakerOf: string | null;
  runs: PublicRun[];
  candidates: Candidate[];
};

export type PublicStanding = {
  playerId: string;
  wins: number;
  losses: number;
  ties: number;
  totalMatches: number;
};

export type PublicEvent = {
  id: string;
  playerId: string | null;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
};

export type PublicLobbyState = {
  code: string;
  status: LobbyStatus;
  mode: LobbyMode;
  capType: CapType;
  capAmount: number;
  rerollsEnabled: boolean;
  stateVersion: number;
  hostPlayerId: string | null;
  viewerPlayerId: string | null;
  players: PublicPlayer[];
  activeMatch: PublicMatch | null;
  standings: PublicStanding[];
  events: PublicEvent[];
};
