import { loadEnvConfig } from "@next/env";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import net from "node:net";
import { promisify } from "node:util";
import { createLobby, joinLobby, getLobbyState, applyLobbyAction } from "../lib/multiplayer";
import { getPool, query } from "../lib/db";
import { loadGamePack } from "../lib/game-data";
import { HARD_CAP_AMOUNT, salary, scoreLineup, toLineupSlot } from "../lib/rules";
import { POSITIONS, type Lineup, type PublicLobbyState } from "../lib/types";

loadEnvConfig(process.cwd());

const execFileAsync = promisify(execFile);
const session = `lineup-ui-${process.pid}`;

async function main() {
  const seed = await seedLobby();
  const port = await freePort();
  const server = startServer(port);

  try {
    await server.ready;
    const url = `http://127.0.0.1:${port}/lobby/${seed.code}`;
    await browser("open", url);
    await browser("set", "viewport", "1280", "900");
    await evalPage(`localStorage.setItem(${JSON.stringify(`better82:${seed.code}:token`)}, ${JSON.stringify(seed.token)}); location.reload();`);
    await waitForPage(filledScript(seed.fromPosition, seed.player));

    await assertFilled(seed.fromPosition, seed.player);
    await assertDisabled(seed.toPosition);
    await assertDisabled("C");
    await waitForPage(`
      if (document.body.textContent.includes('Event History')) throw new Error('event history panel should not render');
    `);
    await assertSpinMetaRemoved();

    await evalPage(`document.querySelector('[data-testid="court-slot-${seed.fromPosition}"]')?.focus();`);
    await waitForPage(`
      const slot = document.querySelector('[data-testid="court-slot-${seed.fromPosition}"]');
      const tooltip = slot?.querySelector('.lineup-tooltip');
      const details = tooltip?.textContent ?? '';
      if (!tooltip) throw new Error('lineup tooltip missing');
      if (slot.hasAttribute('title')) throw new Error('court slot should not use native title tooltip');
      if (!details.includes(${JSON.stringify(seed.player)})) throw new Error('tooltip data missing player name');
      if (!details.includes(${JSON.stringify(seed.fromPosition)})) throw new Error('tooltip data missing player position');
      if (!details.includes(${JSON.stringify(seed.team)})) throw new Error('tooltip data missing player team');
      if (!details.includes(${JSON.stringify(seed.era)})) throw new Error('tooltip data missing player era');
      for (const label of ['PPG', 'APG', 'RPG', 'DEF', 'GRAV']) {
        if (!details.includes(label)) throw new Error('tooltip data missing ' + label);
      }
      for (const label of ['OVR', 'CRE', 'SCO', 'EFF', 'REB', 'RIM', 'SPG', 'BPG', 'SG', 'OG', 'TO']) {
        if (details.includes(label)) throw new Error('tooltip has extra stat ' + label);
      }
    `);
    await assertLineupTooltipsStayInViewport("court-slot");

    await browser("click", `[data-testid="court-slot-${seed.fromPosition}"]`);
    await waitForPage(enabledScript(seed.toPosition));
    await assertDisabled("C");
    await browser("click", `[data-testid="court-slot-${seed.fromPosition}"]`);
    await assertDisabled(seed.toPosition);
    await browser("click", `[data-testid="court-slot-${seed.fromPosition}"]`);
    await waitForPage(enabledScript(seed.toPosition));

    await browser("click", `[data-testid="court-slot-${seed.toPosition}"]`);
    await waitForPage(filledScript(seed.toPosition, seed.player));
    await assertDisabled(seed.fromPosition);

    await evalPage(`
      window.__lineupMoveDataTransfer = new DataTransfer();
      document.querySelector('[data-testid="court-slot-${seed.toPosition}"]').dispatchEvent(
        new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: window.__lineupMoveDataTransfer }),
      );
    `);
    await browser("wait", "300");
    await evalPage(`
      const target = document.querySelector('[data-testid="court-slot-${seed.fromPosition}"]');
      target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: window.__lineupMoveDataTransfer }));
      target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: window.__lineupMoveDataTransfer }));
    `);
    await waitForPage(filledScript(seed.fromPosition, seed.player));

    await query(`UPDATE runs SET lineup = $2::jsonb, cap_spent = $3, current_spin = null, updated_at = now() WHERE id = $1`, [
      seed.runId,
      JSON.stringify(seed.swap.lineup),
      seed.swap.capSpent,
    ]);
    await bumpLobbyVersion(seed.code);
    await waitForPage(filledScript(seed.swap.fromPosition, seed.swap.source.player));
    await assertFilled(seed.swap.position, seed.swap.target.player);
    await evalPage(`
      window.__lineupSwapDataTransfer = new DataTransfer();
      document.querySelector('[data-testid="court-slot-${seed.swap.fromPosition}"]').dispatchEvent(
        new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: window.__lineupSwapDataTransfer }),
      );
    `);
    await browser("wait", "300");
    await evalPage(`
      const target = document.querySelector('[data-testid="court-slot-${seed.swap.position}"]');
      if (!target.classList.contains('available')) throw new Error('occupied swap target was not marked available');
      target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: window.__lineupSwapDataTransfer }));
      target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: window.__lineupSwapDataTransfer }));
    `);
    await waitForPage(filledScript(seed.swap.position, seed.swap.source.player));
    await assertFilled(seed.swap.fromPosition, seed.swap.target.player);

    await query(`UPDATE runs SET current_spin = $2::jsonb, updated_at = now() WHERE id = $1`, [seed.runId, JSON.stringify(seed.searchSpin)]);
    await bumpLobbyVersion(seed.code);
    await waitForPage(`
      if (!document.querySelector('[aria-label="Search players"]')) throw new Error('search input missing before query');
      const cards = [...document.querySelectorAll('[data-testid="player-card"]')];
      if (!cards.length) throw new Error('candidate cards missing before query');
      for (const card of cards) {
        if (card.hasAttribute('data-tooltip')) throw new Error('candidate card should not have hover tooltip data');
        if (card.hasAttribute('title')) throw new Error('candidate card should not have native hover title');
      }
    `);
    await browser("set", "viewport", "1024", "800");
    await assertDraftBoardVerticalOnly();
    await browser("set", "viewport", "1280", "900");
    await evalPage(`
      const input = document.querySelector('[aria-label="Search players"]');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      if (!input || !setter) throw new Error('search input setter missing');
      setter.call(input, 'zzzz-no-player');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    `);
    await waitForPage(`
      const input = document.querySelector('[aria-label="Search players"]');
      if (!input) throw new Error('search input disappeared after no-result query');
      if (input.value !== 'zzzz-no-player') throw new Error('search query did not stick');
      if (!document.body.textContent.includes('No matches.')) throw new Error('no-result search state missing');
    `);

    const finished = await finishViewerRun(seed);
    await waitForPage(`
      if (!document.body.textContent.includes('Lineup locked.')) throw new Error('finished player should stay in waiting view');
      if (document.querySelector('.result-card')) throw new Error('result panel should wait until the match is complete');
      const hostCard = [...document.querySelectorAll('.opponent-card')].find((card) => card.textContent.includes('UI A'));
      if (!hostCard) throw new Error('finished host lobby progress card missing');
      if (!hostCard.textContent.includes(${JSON.stringify(`${finished.wins}-${finished.losses}`)})) throw new Error('finished score missing from lobby progress');
    `);
    await browser("set", "viewport", "1280", "900");
    await assertLineupTooltipsStayInViewport("court-slot");
    await assertLobbyProgressTooltipsStayInViewport();
    await browser("set", "viewport", "390", "780");
    await assertLineupTooltipsStayInViewport("mobile-slot");
    await browser("set", "viewport", "1280", "900");

    const snake = await seedSnakeLobby();
    await browser("open", `http://127.0.0.1:${port}/lobby/${snake.code}`);
    await evalPage(`localStorage.setItem(${JSON.stringify(`better82:${snake.code}:token`)}, ${JSON.stringify(snake.token)}); location.reload();`);
    await assertSpinMetaRemoved();
    await waitForPage(`
      const cards = [...document.querySelectorAll('.opponent-card')];
      const names = cards.map((card) => card.querySelector('.player-name')?.textContent?.trim());
      const expectedNames = ${JSON.stringify(snake.progressNames)};
      if (JSON.stringify(names) !== JSON.stringify(expectedNames)) throw new Error('lobby progress order does not match persisted participant order');
      const highlighted = [...document.querySelectorAll('.opponent-card.current-turn')];
      if (highlighted.length !== 1) throw new Error('current turn should highlight exactly one lobby progress card');
      if (!highlighted[0].textContent.includes(${JSON.stringify(snake.currentPlayerName)})) throw new Error('current turn highlight is on the wrong player');
      if (document.body.textContent.includes('Event History')) throw new Error('event history panel should not render in snake draft');
    `);
    const advancedSnake = await pickForCurrentSnakeDrafter(snake.code, snake.tokens, await getLobbyState(snake.code, snake.token));
    const nextCurrentName = playerNameForState(advancedSnake, advancedSnake.activeMatch?.currentTurnPlayerId ?? null);
    await waitForPage(`
      const cards = [...document.querySelectorAll('.opponent-card')];
      const names = cards.map((card) => card.querySelector('.player-name')?.textContent?.trim());
      const expectedNames = ${JSON.stringify(snake.progressNames)};
      if (JSON.stringify(names) !== JSON.stringify(expectedNames)) throw new Error('lobby progress order shifted after turn advance');
      const highlighted = [...document.querySelectorAll('.opponent-card.current-turn')];
      if (highlighted.length !== 1) throw new Error('current turn should highlight exactly one lobby progress card after advance');
      if (!highlighted[0].textContent.includes(${JSON.stringify(nextCurrentName)})) throw new Error('current turn highlight did not move to the next player');
    `);

    await verifyTiannaMode(port);

    console.log("Lineup UI verification passed.");
  } finally {
    await browser("close").catch(() => undefined);
    server.stop();
    await getPool().end().catch(() => undefined);
  }
}

async function seedLobby() {
  const pick = loadGamePack().players
    .filter((player) => player.positions.length >= 2 && player.positions.includes("C") === false)
    .map((player) => ({ player, cost: salary(player) }))
    .sort((a, b) => a.cost - b.cost || a.player.player.localeCompare(b.player.player))[0].player;
  const [fromPosition, toPosition] = pick.positions;
  assert.ok(fromPosition && toPosition, "multi-position player has two positions");

  const host = await createLobby({ name: "UI A", mode: "parallel", capType: "hard", rerollsEnabled: true });
  await joinLobby(host.code, { name: "UI B" });
  let state = await getLobbyState(host.code, host.token);
  state = await applyLobbyAction(host.code, { token: host.token, expectedVersion: state.stateVersion, action: "start" });

  const run = state.activeMatch?.runs.find((candidate) => candidate.playerId === state.viewerPlayerId);
  assert.ok(run, "viewer run exists");
  await query(`UPDATE runs SET current_spin = $2::jsonb, updated_at = now() WHERE id = $1`, [run.id, JSON.stringify({ team: pick.team, era: pick.era })]);
  state = await getLobbyState(host.code, host.token);
  await applyLobbyAction(host.code, { token: host.token, expectedVersion: state.stateVersion, action: "pick", playerSeasonId: pick.id, position: fromPosition });

  const swap = swappablePair(new Set([pick.id]));
  const searchPlayer = loadGamePack().players.find((player) => player.id !== pick.id && player.positions.some((slot) => slot !== fromPosition));
  assert.ok(searchPlayer, "searchable player exists");

  return {
    code: host.code,
    token: host.token,
    runId: run.id,
    player: pick.player,
    team: pick.team,
    era: pick.era,
    fromPosition,
    toPosition,
    swap,
    searchSpin: { team: searchPlayer.team, era: searchPlayer.era },
  };
}

async function seedSnakeLobby() {
  const host = await createLobby({ name: "Turn A", mode: "snake", capType: "hard", rerollsEnabled: true });
  const guest = await joinLobby(host.code, { name: "Turn B" });
  const tokens = {
    [host.playerId]: host.token,
    [guest.playerId]: guest.token,
  };
  let state = await getLobbyState(host.code, host.token);
  state = await applyLobbyAction(host.code, { token: host.token, expectedVersion: state.stateVersion, action: "start" });
  const currentPlayerId = state.activeMatch?.currentTurnPlayerId;
  assert.ok(currentPlayerId, "snake current drafter exists");
  const currentPlayerName = playerNameForState(state, currentPlayerId);
  const progressNames = (state.activeMatch?.runs ?? []).map((run) => playerNameForState(state, run.playerId));
  return { code: host.code, token: host.token, tokens, currentPlayerName, progressNames };
}

async function verifyTiannaMode(port: number) {
  const host = await createLobby({ name: "Tianna A", mode: "parallel", capType: "hard", rerollsEnabled: true });
  await joinLobby(host.code, { name: "Tianna B" });
  await browser("open", `http://127.0.0.1:${port}/lobby/${host.code}`);
  await browser("set", "viewport", "1280", "900");
  await evalPage(`localStorage.setItem(${JSON.stringify(`better82:${host.code}:token`)}, ${JSON.stringify(host.token)}); location.reload();`);
  await waitForPage(`
    const rerolls = document.querySelector('[data-testid="draft-rerolls-toggle"]');
    const tianna = document.querySelector('[data-testid="tianna-mode-toggle"]');
    if (!rerolls) throw new Error('draft rerolls toggle missing');
    if (!tianna) throw new Error('tianna mode toggle missing');
    if (!tianna.textContent.includes('off')) throw new Error('tianna mode should default off');
    const parent = tianna.parentElement;
    if (!parent || !parent.contains(rerolls)) throw new Error('tianna mode toggle is not grouped with draft rerolls');
  `);
  await browser("click", '[data-testid="tianna-mode-toggle"]');
  await waitForPage(`
    const tianna = document.querySelector('[data-testid="tianna-mode-toggle"]');
    if (!tianna?.textContent.includes('on')) throw new Error('tianna mode did not toggle on');
  `);

  let state = await getLobbyState(host.code, host.token);
  assert.equal(state.tiannaMode, true);
  state = await applyLobbyAction(host.code, { token: host.token, expectedVersion: state.stateVersion, action: "start" });
  const run = state.activeMatch?.runs.find((candidate) => candidate.playerId === state.viewerPlayerId);
  assert.ok(run, "tianna viewer run exists");
  const spinPlayer = loadGamePack().players.find((player) => player.positions.includes("PG"));
  assert.ok(spinPlayer, "tianna spin player exists");
  await query(`UPDATE runs SET current_spin = $2::jsonb, updated_at = now() WHERE id = $1`, [run.id, JSON.stringify({ team: spinPlayer.team, era: spinPlayer.era })]);
  await bumpLobbyVersion(host.code);

  await waitForPage(`
    const inlineLineups = [...document.querySelectorAll('[data-testid="mobile-lineup-strip"]')];
    if (inlineLineups.length !== 1) throw new Error('tianna mode should render exactly one inline lineup strip');
    const inline = document.querySelector('.draft-controls [data-testid="mobile-lineup-strip"]');
    if (!inline) throw new Error('inline lineup strip should sit above lobby progress');
    if (getComputedStyle(inline).position === 'fixed') throw new Error('tianna lineup strip should not be fixed');
    if (document.querySelector('[data-testid^="court-slot-"]')) throw new Error('court slots should be removed in tianna mode');
    const panel = document.querySelector('[data-testid="tianna-analysis"]');
    if (!panel) throw new Error('tianna analysis panel missing');
    const side = document.querySelector('.side');
    const standings = side?.querySelector('.section-title');
    if (!side || !standings || !side.contains(panel)) throw new Error('tianna panel should be in the right side column');
    const text = panel.textContent ?? '';
    for (const label of ['Tianna Mode', 'Current OVR', 'Balance', 'Have', 'Need', 'Best Board Pick']) {
      if (!text.includes(label)) throw new Error('tianna panel missing ' + label);
    }
    if (text.includes('Spin to load a board.')) throw new Error('tianna board recommendation did not load');
  `);

  const snakeHost = await createLobby({ name: "Tianna Snake A", mode: "snake", capType: "hard", rerollsEnabled: true, tiannaMode: true });
  const snakeGuest = await joinLobby(snakeHost.code, { name: "Tianna Snake B" });
  state = await getLobbyState(snakeHost.code, snakeHost.token);
  state = await applyLobbyAction(snakeHost.code, { token: snakeHost.token, expectedVersion: state.stateVersion, action: "start" });
  const currentPlayerId = state.activeMatch?.currentTurnPlayerId;
  assert.ok(currentPlayerId, "tianna snake current drafter exists");
  const nonCurrentToken = currentPlayerId === snakeHost.playerId ? snakeGuest.token : snakeHost.token;
  await browser("open", `http://127.0.0.1:${port}/lobby/${snakeHost.code}`);
  await evalPage(`localStorage.setItem(${JSON.stringify(`better82:${snakeHost.code}:token`)}, ${JSON.stringify(nonCurrentToken)}); location.reload();`);
  await waitForPage(`
    const panel = document.querySelector('[data-testid="tianna-analysis"]');
    if (!panel) throw new Error('tianna snake analysis panel missing for non-current viewer');
    const text = panel.textContent ?? '';
    if (!text.includes('Best Board Pick')) throw new Error('tianna snake best board section missing');
    if (text.includes('Spin to load a board.')) throw new Error('tianna snake board recommendation missing for non-current viewer');
    const cards = [...document.querySelectorAll('[data-testid="player-card"]')];
    if (!cards.length) throw new Error('tianna snake candidate board missing for non-current viewer');
    if (!cards.every((card) => card.disabled)) throw new Error('non-current snake viewer candidate cards should stay disabled');
  `);
}

async function finishViewerRun(seed: { code: string; runId: string }) {
  const lineup = completedLineup();
  const capSpent = lineup.reduce((total, pick) => total + salary(pick.player), 0);
  const finalResult = scoreLineup(lineup.map((pick) => pick.player), "hard", HARD_CAP_AMOUNT, capSpent);
  await query(
    `UPDATE runs
     SET status = 'finished',
         round = 5,
         cap_spent = $2,
         current_spin = null,
         lineup = $3::jsonb,
         final_result = $4::jsonb,
         updated_at = now()
     WHERE id = $1`,
    [
      seed.runId,
      capSpent,
      JSON.stringify(Object.fromEntries(lineup.map((pick) => [pick.position, toLineupSlot(pick.position, pick.player)]))),
      JSON.stringify(finalResult),
    ],
  );
  await bumpLobbyVersion(seed.code);
  return finalResult;
}

function completedLineup() {
  const pack = loadGamePack();
  const used = new Set<string>();
  return POSITIONS.map((position) => {
    const player = pack.players
      .filter((candidate) => candidate.positions.includes(position) && !used.has(candidate.id))
      .map((candidate) => ({ player: candidate, cost: salary(candidate) }))
      .sort((a, b) => a.cost - b.cost || a.player.player.localeCompare(b.player.player))[0];
    assert.ok(player, `finished ${position} player exists`);
    used.add(player.player.id);
    return { position, player: player.player };
  });
}

async function pickForCurrentSnakeDrafter(code: string, tokens: Record<string, string>, state: PublicLobbyState): Promise<PublicLobbyState> {
  const current = state.activeMatch?.currentTurnPlayerId;
  assert.ok(current, "current drafter exists");
  const token = tokens[current];
  assert.ok(token, "current drafter token exists");
  const actorState = await getLobbyState(code, token);
  const candidate = cheapestAssignable(actorState);
  assert.ok(candidate, `assignable candidate for ${current}`);
  return applyLobbyAction(code, {
    token,
    expectedVersion: actorState.stateVersion,
    action: "pick",
    playerSeasonId: candidate.id,
    position: candidate.openPositions[0],
  });
}

function cheapestAssignable(state: PublicLobbyState) {
  return [...(state.activeMatch?.candidates ?? [])].filter((candidate) => candidate.assignable).sort((a, b) => a.cost - b.cost || a.player.localeCompare(b.player))[0];
}

function playerNameForState(state: PublicLobbyState, playerId: string | null) {
  return state.players.find((player) => player.id === playerId)?.name ?? "";
}

function swappablePair(excludedIds: Set<string>) {
  const pack = loadGamePack();
  const options = pack.players.flatMap((source) =>
    pack.players.flatMap((target) => {
      if (source.id === target.id || excludedIds.has(source.id) || excludedIds.has(target.id)) return [];
      return source.positions.flatMap((fromPosition) =>
        target.positions
          .filter((position) => position !== fromPosition && source.positions.includes(position) && target.positions.includes(fromPosition))
          .map((position) => ({ source, target, fromPosition, position, cost: salary(source) + salary(target) })),
      );
    }),
  );
  const pair = options.sort((a, b) => a.cost - b.cost || a.source.player.localeCompare(b.source.player) || a.target.player.localeCompare(b.target.player))[0];
  assert.ok(pair, "swappable player pair exists");
  const lineup: Lineup = {
    [pair.fromPosition]: toLineupSlot(pair.fromPosition, pair.source),
    [pair.position]: toLineupSlot(pair.position, pair.target),
  };
  return {
    ...pair,
    lineup,
    capSpent: salary(pair.source) + salary(pair.target),
  };
}

async function assertFilled(position: string, player: string) {
  await evalPage(filledScript(position, player));
}

async function bumpLobbyVersion(code: string) {
  await query(`UPDATE lobbies SET state_version = state_version + 1, updated_at = now() WHERE code = $1`, [code]);
}

function filledScript(position: string, player: string) {
  return `
    const slot = document.querySelector('[data-testid="court-slot-${position}"]');
    if (!slot) throw new Error('missing ${position} slot');
    if (!slot.getAttribute('aria-label')?.includes(${JSON.stringify(player)})) throw new Error('${position} is not filled by ${player}');
  `;
}

function enabledScript(position: string) {
  return `
    const slot = document.querySelector('[data-testid="court-slot-${position}"]');
    if (!slot) throw new Error('missing ${position} slot');
    if (slot.disabled) throw new Error('${position} should be enabled');
  `;
}

async function assertDisabled(position: string) {
  await evalPage(`
    const slot = document.querySelector('[data-testid="court-slot-${position}"]');
    if (!slot) throw new Error('missing ${position} slot');
    if (!slot.disabled) throw new Error('${position} should be disabled');
  `);
}

async function assertSpinMetaRemoved() {
  await waitForPage(`
    if (document.querySelector('.spin-meta')) throw new Error('spin metadata should not render');
    const pageText = document.body.textContent ?? '';
    for (const removedText of ['picks left', 'Turn:', 'Independent run']) {
      if (pageText.includes(removedText)) throw new Error('removed spin metadata is still visible: ' + removedText);
    }
  `);
}

async function assertLineupTooltipsStayInViewport(testIdPrefix: "court-slot" | "mobile-slot") {
  const selectors = POSITIONS.map((position) => `[data-testid="${testIdPrefix}-${position}"]`);
  await waitForPage(`
    const selectors = ${JSON.stringify(selectors)};
    let checked = 0;
    for (const selector of selectors) {
      const slot = document.querySelector(selector);
      if (!slot) throw new Error('missing lineup slot ' + selector);
      if (slot.hasAttribute('title')) throw new Error('lineup slot should not use native title tooltip: ' + selector);
      const tooltip = slot.querySelector('.lineup-tooltip');
      if (!tooltip) continue;
      checked += 1;
      slot.focus();
      const rect = tooltip.getBoundingClientRect();
      if (rect.left < -0.5 || rect.top < -0.5 || rect.right > window.innerWidth + 0.5 || rect.bottom > window.innerHeight + 0.5) {
        throw new Error('lineup tooltip escapes viewport for ' + selector + ': ' + JSON.stringify({
          left: rect.left,
          top: rect.top,
          right: rect.right,
          bottom: rect.bottom,
          width: window.innerWidth,
          height: window.innerHeight,
        }));
      }
    }
    if (!checked) throw new Error('no lineup tooltips were checked for ' + ${JSON.stringify(testIdPrefix)});
  `);
}

async function assertLobbyProgressTooltipsStayInViewport() {
  await waitForPage(`
    const slots = [...document.querySelectorAll('.opponent-card .lineup-mini .mini-slot.filled')];
    if (!slots.length) throw new Error('lobby progress filled mini slots missing');
    for (const slot of slots) {
      if (slot.hasAttribute('title')) throw new Error('lobby progress mini slot should not use native title tooltip');
      const tooltip = slot.querySelector('.lineup-tooltip');
      if (!tooltip) throw new Error('lobby progress mini slot tooltip missing');
      slot.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true }));
      const rect = tooltip.getBoundingClientRect();
      if (rect.left < -0.5 || rect.top < -0.5 || rect.right > window.innerWidth + 0.5 || rect.bottom > window.innerHeight + 0.5) {
        throw new Error('lobby progress tooltip escapes viewport: ' + JSON.stringify({
          left: rect.left,
          top: rect.top,
          right: rect.right,
          bottom: rect.bottom,
          width: window.innerWidth,
          height: window.innerHeight,
        }));
      }
    }
  `);
}

async function assertDraftBoardVerticalOnly() {
  await waitForPage(`
    const targets = [
      ['draft board', document.querySelector('.draft-board')],
      ['position filters', document.querySelector('.draft-board .position-filter-row')],
      ['candidate list', document.querySelector('.draft-board .candidate-list')],
    ];
    for (const [name, element] of targets) {
      if (!element) throw new Error(name + ' missing');
      const style = getComputedStyle(element);
      if (style.overflowX !== 'hidden' && style.overflowX !== 'clip') {
        throw new Error(name + ' exposes horizontal overflow: ' + style.overflowX);
      }
      if (element.scrollWidth > element.clientWidth + 1) {
        throw new Error(name + ' has horizontal overflow: ' + element.scrollWidth + ' > ' + element.clientWidth);
      }
    }
    const listStyle = getComputedStyle(document.querySelector('.draft-board .candidate-list'));
    if (listStyle.overflowY !== 'auto' && listStyle.overflowY !== 'scroll') {
      throw new Error('candidate list should keep vertical scrolling');
    }
  `);
}

async function evalPage(script: string) {
  await browser("eval", `(() => { ${script} })()`);
}

async function waitForPage(script: string, timeoutMs = 15_000) {
  const startedAt = Date.now();
  let lastError: unknown;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      await evalPage(script);
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Timed out waiting for page condition.");
}

async function waitForServer(port: number, timeoutMs = 15_000) {
  const startedAt = Date.now();
  let lastError: unknown;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`, { cache: "no-store" });
      if (response.ok) return;
      lastError = new Error(`Health check returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw lastError instanceof Error ? lastError : new Error("Timed out waiting for dev server.");
}

async function browser(...args: string[]) {
  return execFileAsync("agent-browser", ["--session", session, ...args], { maxBuffer: 1024 * 1024 });
}

async function freePort() {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object", "free port address is available");
  const port = address.port;
  server.close();
  await once(server, "close");
  return port;
}

function startServer(port: number) {
  const command = process.platform === "win32" ? "npm.cmd" : "npm";
  const child = execFile(command, ["run", "dev", "--", "--hostname", "127.0.0.1", "--port", String(port)], {
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" },
  });

  const ready = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Next dev server did not become ready in time")), 30_000);
    let settling = false;
    let settled = false;
    let output = "";
    const appendOutput = (text: string) => {
      output = `${output}${text}`.slice(-4000);
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    };
    const onData = (chunk: Buffer) => {
      const text = chunk.toString();
      appendOutput(text);
      if (text.includes("Ready") && !settling) {
        settling = true;
        waitForServer(port)
          .then(() => {
            settled = true;
            clearTimeout(timeout);
            resolve();
          })
          .catch((error) => fail(error));
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.once("exit", (code) => {
      fail(new Error(`Next dev server exited early with code ${code}\n${output}`));
    });
  });

  return {
    ready,
    stop() {
      child.kill("SIGINT");
    },
  };
}

main().catch(async (error) => {
  console.error(error);
  await browser("close").catch(() => undefined);
  await getPool().end().catch(() => undefined);
  process.exit(1);
});
