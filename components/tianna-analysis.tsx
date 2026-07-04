"use client";

import type { ReactNode } from "react";
import { Brain, Gauge, Target, TrendingUp } from "lucide-react";
import { effectiveOverall, formatStat, maxLegalCost, scoreLineupProgress, slotCount, type LineupProgressResult } from "@/lib/rules";
import {
  POSITIONS,
  type Candidate,
  type LineupSlot,
  type PlayerSeason,
  type Position,
  type PublicLobbyState,
  type PublicRun,
} from "@/lib/types";

export type TiannaBoardOption = {
  candidateId: string;
  candidateName: string;
  cost: number;
  position: Position;
  scoreAfter: number;
  delta: number;
  reasons: string[];
};

export type TiannaBoardEvaluation = {
  options: TiannaBoardOption[];
  best: TiannaBoardOption | null;
};

export type TiannaPickReview = {
  picked: TiannaBoardOption;
  best: TiannaBoardOption;
  rank: number;
  optionCount: number;
};

type TiannaProfile = {
  filled: number;
  current: LineupProgressResult;
  averages: {
    creation: number;
    defense: number;
    rebounding: number;
    rimProtection: number;
    scoring: number;
    shootingGravity: number;
  };
  balance: string;
  have: string[];
  needs: string[];
  maxNextCost: number;
};

function avg(values: number[]) {
  return values.length ? values.reduce((total, value) => total + value, 0) / values.length : 0;
}

function signed(value: number) {
  return `${value >= 0 ? "+" : ""}${formatStat(value)}`;
}

function slotList(run: PublicRun) {
  return POSITIONS.map((position) => run.lineup[position]).filter(Boolean) as LineupSlot[];
}

function playerFromSlot(slot: LineupSlot): PlayerSeason {
  return {
    id: slot.playerId,
    player: slot.player,
    team: slot.team,
    era: slot.era,
    positions: slot.positions,
    overall: slot.overall,
    perGame: slot.perGame,
    ratings: slot.ratings,
  };
}

function slotFromCandidate(candidate: Candidate, position: Position): LineupSlot {
  return {
    position,
    playerId: candidate.id,
    player: candidate.player,
    team: candidate.team,
    era: candidate.era,
    cost: candidate.cost,
    overall: candidate.overall,
    positions: candidate.positions,
    perGame: candidate.perGame,
    ratings: candidate.ratings,
  };
}

function estimateLineup(slots: LineupSlot[], state: PublicLobbyState, spent: number): LineupProgressResult {
  return scoreLineupProgress(slots.map(playerFromSlot), state.capType, state.capAmount, spent);
}

function profileForRun(state: PublicLobbyState, run: PublicRun): TiannaProfile {
  const slots = slotList(run);
  const players = slots.map(playerFromSlot);
  const ratings = players.map((player) => player.ratings);
  const averages = {
    creation: avg(ratings.map((rating) => rating.creation)),
    defense: avg(ratings.map((rating) => rating.defense)),
    rebounding: avg(ratings.map((rating) => rating.rebounding)),
    rimProtection: avg(ratings.map((rating) => rating.rimProtection)),
    scoring: avg(ratings.map((rating) => rating.scoring)),
    shootingGravity: avg(ratings.map((rating) => rating.shootingGravity)),
  };
  const offense = avg([averages.creation, averages.scoring, averages.shootingGravity]);
  const defense = avg([averages.defense, averages.rimProtection, averages.rebounding]);
  const gap = offense - defense;
  const maxCreation = ratings.length ? Math.max(...ratings.map((rating) => rating.creation)) : 0;
  const maxRimProtection = ratings.length ? Math.max(...ratings.map((rating) => rating.rimProtection)) : 0;
  const eliteShooters = ratings.filter((rating) => rating.shootingGravity >= 78).length;
  const missingPositions = POSITIONS.filter((position) => !run.lineup[position]);
  const have = [
    maxCreation >= 90 ? "elite creator" : null,
    averages.scoring >= 85 ? "scoring pressure" : null,
    averages.shootingGravity >= 75 || eliteShooters > 0 ? "spacing" : null,
    maxRimProtection >= 85 ? "rim protection" : null,
    averages.defense >= 75 ? "team defense" : null,
    averages.rebounding >= 70 ? "rebounding" : null,
  ].filter(Boolean) as string[];
  const needs = [
    missingPositions.length ? `${missingPositions.join("/")} slots` : null,
    maxCreation < 90 ? "primary creation" : null,
    eliteShooters === 0 ? "elite spacer" : null,
    maxRimProtection < 85 ? "rim protection" : null,
    averages.defense < 75 ? "team defense" : null,
    averages.rebounding < 65 ? "rebounding" : null,
  ].filter(Boolean) as string[];
  const maxNextCost = maxLegalCost(state.capType, state.capAmount, run.capSpent, slotCount(run.lineup));

  return {
    filled: slots.length,
    current: estimateLineup(slots, state, run.capSpent),
    averages,
    balance: Math.abs(gap) < 4 ? "Even" : gap > 0 ? `OFF ${signed(gap)}` : `DEF ${signed(Math.abs(gap))}`,
    have: have.length ? have.slice(0, 4) : ["cap room"],
    needs: needs.length ? needs.slice(0, 5) : ["best value"],
    maxNextCost,
  };
}

export function evaluateTiannaBoard(state: PublicLobbyState | null, run: PublicRun | null, candidates: Candidate[]): TiannaBoardEvaluation | null {
  if (!state || !run) return null;
  const beforeSlots = slotList(run);
  const before = effectiveOverall(estimateLineup(beforeSlots, state, run.capSpent));
  const options = candidates.flatMap((candidate) => {
    if (!candidate.assignable) return [];
    return candidate.openPositions
      .filter((position) => !run.lineup[position])
      .map((position) => {
        const afterSlots = [...beforeSlots, slotFromCandidate(candidate, position)];
        const after = estimateLineup(afterSlots, state, run.capSpent + candidate.cost);
        const scoreAfter = effectiveOverall(after);
        return {
          candidateId: candidate.id,
          candidateName: candidate.player,
          cost: candidate.cost,
          position,
          scoreAfter,
          delta: Number((scoreAfter - before).toFixed(1)),
          reasons: after.reasons,
        };
      });
  });
  options.sort((a, b) =>
    b.scoreAfter - a.scoreAfter ||
    b.delta - a.delta ||
    a.cost - b.cost ||
    a.candidateName.localeCompare(b.candidateName) ||
    a.position.localeCompare(b.position),
  );
  return {
    options,
    best: options[0] ?? null,
  };
}

export function buildTiannaPickReview(candidate: Candidate, position: Position, board: TiannaBoardEvaluation | null): TiannaPickReview | null {
  if (!board?.best) return null;
  const optionIndex = board.options.findIndex((option) => option.candidateId === candidate.id && option.position === position);
  if (optionIndex < 0) return null;
  return {
    picked: board.options[optionIndex],
    best: board.best,
    rank: optionIndex + 1,
    optionCount: board.options.length,
  };
}

export function TiannaAnalysis({
  state,
  run,
  board,
  lastPick,
}: {
  state: PublicLobbyState | null;
  run: PublicRun | null;
  board: TiannaBoardEvaluation | null;
  lastPick: TiannaPickReview | null;
}) {
  if (!state || !run) return null;
  const profile = profileForRun(state, run);
  const best = board?.best ?? null;
  const owner = run.playerId === state.viewerPlayerId ? null : state.players.find((player) => player.id === run.playerId)?.name;

  return (
    <section className="panel panel-pad stack tianna-panel" data-testid="tianna-analysis">
      <div className="tianna-header">
        <Brain size={22} />
        <div>
          <p className="section-title">Tianna Mode</p>
          <p className="eyebrow">
            {owner ? `${owner} · ` : ""}
            {profile.filled}/5 slots · ${run.budgetLeft} left
          </p>
        </div>
      </div>

      <div className="tianna-score">
        <div>
          <p className="eyebrow">Current OVR</p>
          <strong>{formatStat(profile.current.team_ovr)}</strong>
          <span>
            {profile.current.wins !== null ? `${profile.current.wins}-${82 - profile.current.wins} ${profile.current.label}` : "partial projection"}
          </span>
        </div>
        <Gauge size={24} />
      </div>

      <div className="tianna-metrics">
        <TiannaMetric label="Balance" value={profile.balance} />
        <TiannaMetric label="Scoring" value={formatStat(profile.averages.scoring)} />
        <TiannaMetric label="Spacing" value={formatStat(profile.averages.shootingGravity)} />
        <TiannaMetric label="Defense" value={formatStat(profile.averages.defense)} />
        <TiannaMetric label="Rim" value={formatStat(profile.averages.rimProtection)} />
        <TiannaMetric label="Reb" value={formatStat(profile.averages.rebounding)} />
      </div>

      <div className="tianna-lists">
        <TiannaList title="Have" items={profile.have} />
        <TiannaList title="Need" items={profile.needs} />
      </div>

      <div className="tianna-budget">
        <p className="eyebrow">Budget Window</p>
        <strong>{Number.isFinite(profile.maxNextCost) ? `$${profile.maxNextCost}` : "Open"}</strong>
        <span>{state.capType === "hard" ? "max next hard-cap legal cost" : "soft cap allows overspend"}</span>
      </div>

      <TiannaCallout
        icon={<Target size={18} />}
        label="Best Board Pick"
        empty="Spin to load a board."
        option={best}
      />

      {lastPick ? <LastPickReview review={lastPick} /> : null}
    </section>
  );
}

function TiannaMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="tianna-metric">
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

function TiannaList({ title, items }: { title: string; items: string[] }) {
  return (
    <div className="tianna-list">
      <p className="eyebrow">{title}</p>
      {items.map((item) => (
        <span key={item}>{item}</span>
      ))}
    </div>
  );
}

function TiannaCallout({
  icon,
  label,
  empty,
  option,
}: {
  icon: ReactNode;
  label: string;
  empty: string;
  option: TiannaBoardOption | null;
}) {
  return (
    <div className="tianna-callout">
      <div className="tianna-callout-head">
        {icon}
        <p className="eyebrow">{label}</p>
      </div>
      {option ? (
        <>
          <strong>{option.candidateName}</strong>
          <span>
            {option.position} · ${option.cost} · {signed(option.delta)} OVR
          </span>
          <p className="small-copy">{option.reasons.slice(0, 3).join(" · ") || "Best statistical value on the current board."}</p>
        </>
      ) : (
        <span>{empty}</span>
      )}
    </div>
  );
}

function LastPickReview({ review }: { review: TiannaPickReview }) {
  const missed = Number((review.best.scoreAfter - review.picked.scoreAfter).toFixed(1));
  const pickedBest = review.rank === 1 || missed <= 0;

  return (
    <div className={`tianna-callout ${pickedBest ? "good" : "warn"}`}>
      <div className="tianna-callout-head">
        <TrendingUp size={18} />
        <p className="eyebrow">Last Pick Review</p>
      </div>
      <strong>{review.picked.candidateName}</strong>
      <span>
        {review.picked.position} · rank {review.rank}/{review.optionCount} · {signed(review.picked.delta)} OVR
      </span>
      <p className="small-copy">
        {pickedBest
          ? "Best statistical option on that board."
          : `${review.best.candidateName} at ${review.best.position} projected ${signed(missed)} more OVR.`}
      </p>
    </div>
  );
}
