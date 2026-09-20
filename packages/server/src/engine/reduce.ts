/**
 * The game engine: a pure reducer over GameState.
 *
 * Nothing in here touches sockets, timers, Math.random or Date.now. All
 * nondeterminism arrives through EngineContext, which is what makes the whole
 * round lifecycle testable and every bug reproducible from a seed.
 *
 * Style note: `reduce` deep-clones the state once and then mutates the clone.
 * At our scale (<=12 players, a few hundred cards) the copy is free, and it
 * keeps the transition logic readable instead of a wall of spreads.
 */
import {
  CZAR_GRACE_MS,
  DISCONNECT_GRACE_MS,
  DEFAULT_SETTINGS,
  GameError,
  MAX_PLAYERS,
  MIN_PLAYERS,
  type Action,
  type GameSettings,
  type GameState,
  type Player,
  type RoundResult,
} from '@cac/shared/game';
import type { Deck, PromptCard, ResponseCard } from '@cac/shared/deck';
import { shuffle, pickOne, type Rng } from './rng.ts';

/** How long the round result stays on screen before the next round begins. */
export const ROUND_RESULT_MS = 8_000;

export interface DeckIndex {
  prompts: Map<string, PromptCard>;
  responses: Map<string, ResponseCard>;
  /** Source decks, kept for rebuilding draw piles when the selection changes. */
  all: readonly Deck[];
}

export interface EngineContext {
  now: number;
  rng: Rng;
  decks: DeckIndex;
}

export function buildDeckIndex(decks: readonly Deck[]): DeckIndex {
  const prompts = new Map<string, PromptCard>();
  const responses = new Map<string, ResponseCard>();
  for (const deck of decks) {
    for (const p of deck.prompts) prompts.set(p.id, p);
    for (const r of deck.responses) responses.set(r.id, r);
  }
  return { prompts, responses, all: decks };
}

// ---------------------------------------------------------------- selectors

export function connectedIds(state: GameState): string[] {
  return state.seatOrder.filter((id) => state.players[id]?.connected);
}

/** Players who must submit before judging can begin: connected, not the czar. */
export function requiredSubmitters(state: GameState): string[] {
  return connectedIds(state).filter((id) => id !== state.czarId);
}

export function hasSubmitted(state: GameState, playerId: string): boolean {
  return state.submissions.some((s) => s.playerId === playerId);
}

export function currentPrompt(state: GameState, decks: DeckIndex): PromptCard | null {
  return state.promptId ? (decks.prompts.get(state.promptId) ?? null) : null;
}

function requirePlayer(state: GameState, playerId: string): Player {
  const player = state.players[playerId];
  if (!player) throw new GameError('UNKNOWN_PLAYER');
  return player;
}

function requireHost(state: GameState, playerId: string): void {
  if (state.hostId !== playerId) throw new GameError('NOT_HOST');
}

function requirePhase(state: GameState, ...phases: GameState['phase'][]): void {
  if (!phases.includes(state.phase)) throw new GameError('WRONG_PHASE');
}

// ------------------------------------------------------------------- piles

/**
 * Draw n response cards, reshuffling the discard pile when the draw pile runs
 * dry. Returns fewer than n only if both piles are exhausted, which can happen
 * with a small custom deck and a full room.
 */
function drawResponses(state: GameState, n: number, rng: Rng): string[] {
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    if (state.responseDraw.length === 0) {
      if (state.responseDiscard.length === 0) break;
      state.responseDraw = shuffle(state.responseDiscard, rng);
      state.responseDiscard = [];
    }
    out.push(state.responseDraw.pop()!);
  }
  return out;
}

function drawPrompt(state: GameState, rng: Rng): string | null {
  if (state.promptDraw.length === 0) {
    if (state.promptDiscard.length === 0) return null;
    state.promptDraw = shuffle(state.promptDiscard, rng);
    state.promptDiscard = [];
  }
  return state.promptDraw.pop() ?? null;
}

function refillHands(state: GameState, rng: Rng): void {
  for (const id of state.seatOrder) {
    const player = state.players[id];
    if (!player) continue;
    const missing = state.settings.handSize - player.hand.length;
    if (missing > 0) player.hand.push(...drawResponses(state, missing, rng));
  }
}

// ------------------------------------------------------------------ clocks

/**
 * Set (or clear) the deadline for the phase being entered.
 *
 * Every deadline goes through here so that pausing works everywhere. While
 * the clock is held, the time is banked as `pausedRemainingMs` instead of
 * becoming a wall-clock deadline, and resume converts it back.
 */
function setDeadline(state: GameState, ctx: EngineContext, ms: number | null): void {
  if (state.paused) {
    state.pausedRemainingMs = ms;
    state.deadline = null;
    return;
  }
  state.deadline = ms === null ? null : ctx.now + ms;
}

/**
 * Shorten the current deadline, never extend it. Used by the czar grace, which
 * must not push out a judge timer that is already running.
 */
function shortenDeadline(state: GameState, ctx: EngineContext, ms: number): void {
  if (state.paused) {
    state.pausedRemainingMs = state.pausedRemainingMs === null ? ms : Math.min(state.pausedRemainingMs, ms);
    return;
  }
  const candidate = ctx.now + ms;
  state.deadline = state.deadline === null ? candidate : Math.min(state.deadline, candidate);
}

// ------------------------------------------------------------ round machine

/** Next connected player after the current czar, walking seat order. */
function nextCzarId(state: GameState): string | null {
  const eligible = connectedIds(state);
  if (eligible.length === 0) return null;
  if (!state.czarId) return eligible[0]!;

  const from = state.seatOrder.indexOf(state.czarId);
  // Walk the full seat order so we land on the next *connected* seat, rather
  // than skipping players who happened to be offline for one round.
  for (let step = 1; step <= state.seatOrder.length; step++) {
    const candidate = state.seatOrder[(from + step) % state.seatOrder.length];
    if (candidate && state.players[candidate]?.connected) return candidate;
  }
  return eligible[0]!;
}

function beginRound(state: GameState, ctx: EngineContext): void {
  const promptId = drawPrompt(state, ctx.rng);
  if (!promptId) {
    // No prompts left anywhere; the deck is spent, so end on current scores.
    finishGame(state);
    return;
  }

  state.round += 1;
  state.czarId = nextCzarId(state);
  state.promptId = promptId;
  state.submissions = [];
  state.revealOrder = [];
  state.lastResult = null;
  state.phase = 'submitting';
  refillHands(state, ctx.rng);
  setDeadline(state, ctx, state.settings.submitTimerMs);
}

function beginJudging(state: GameState, ctx: EngineContext): void {
  state.phase = 'judging';
  // Reveal order is shuffled so the czar can't infer who played what from
  // submission order.
  state.revealOrder = shuffle(
    state.submissions.map((s) => s.playerId),
    ctx.rng,
  );
  setDeadline(state, ctx, state.settings.judgeTimerMs);
}

/** Move to judging if everyone who still can submit already has. */
function maybeBeginJudging(state: GameState, ctx: EngineContext): void {
  if (state.phase !== 'submitting') return;
  const required = requiredSubmitters(state);
  if (required.length === 0) return;
  if (required.every((id) => hasSubmitted(state, id))) beginJudging(state, ctx);
}

function discardRound(state: GameState): void {
  for (const submission of state.submissions) state.responseDiscard.push(...submission.cards);
  if (state.promptId) state.promptDiscard.push(state.promptId);
}

function resolveRound(state: GameState, winnerId: string | null, auto: boolean, ctx: EngineContext): void {
  const winning = winnerId ? state.submissions.find((s) => s.playerId === winnerId) : undefined;
  if (winnerId && winning) {
    const winner = state.players[winnerId];
    if (winner) winner.score += 1;
  }

  const result: RoundResult = {
    promptId: state.promptId!,
    winnerId: winning ? winnerId! : '',
    winningCards: winning ? winning.cards : [],
    submissions: state.submissions,
    skipped: !winning,
    auto,
  };

  state.lastResult = result;
  state.history.push(result);
  discardRound(state);
  state.submissions = [];
  state.phase = 'roundResult';
  setDeadline(state, ctx, ROUND_RESULT_MS);

  const target = state.settings.pointsToWin;
  if (target !== null && Object.values(state.players).some((p) => p.score >= target)) {
    finishGame(state);
  }
}

function finishGame(state: GameState): void {
  const scores = Object.values(state.players).map((p) => p.score);
  const best = scores.length > 0 ? Math.max(...scores) : 0;
  state.phase = 'gameOver';
  state.winnerIds = Object.values(state.players)
    .filter((p) => p.score === best && best > 0)
    .map((p) => p.id);
  // A finished game has no clock to hold.
  state.paused = false;
  state.pausedRemainingMs = null;
  state.pausedBy = null;
  state.deadline = null;
  state.czarId = null;
  state.promptId = null;
  state.submissions = [];
  state.revealOrder = [];
}

/**
 * Called after anything that changes who is present. A game that dropped below
 * the player minimum parks in `roundResult` with no deadline; this restarts it
 * once enough people are back.
 */
function maybeResume(state: GameState, ctx: EngineContext): void {
  // A held clock is not a parked game: leave it held.
  if (state.paused) return;
  if (state.phase !== 'roundResult' || state.deadline !== null) return;
  if (connectedIds(state).length >= MIN_PLAYERS) setDeadline(state, ctx, ROUND_RESULT_MS);
}

/** Advance out of roundResult, or park if too few players remain. */
function advanceFromResult(state: GameState, ctx: EngineContext): void {
  if (connectedIds(state).length < MIN_PLAYERS) {
    state.deadline = null;
    state.pausedRemainingMs = null;
    return;
  }
  beginRound(state, ctx);
}

/**
 * Move the current phase along: what a deadline does when it expires, and what
 * the host's override does on demand.
 */
function advancePhase(state: GameState, ctx: EngineContext): void {
  switch (state.phase) {
    case 'submitting': {
      if (state.submissions.length === 0) {
        // Nobody played. Bin the round rather than stalling.
        resolveRound(state, null, true, ctx);
      } else {
        beginJudging(state, ctx);
      }
      break;
    }
    case 'judging': {
      // Czar ran out of time or dropped: pick for them so play continues.
      const winner = pickOne(state.submissions, ctx.rng);
      resolveRound(state, winner.playerId, true, ctx);
      break;
    }
    case 'roundResult': {
      advanceFromResult(state, ctx);
      break;
    }
    default:
      break;
  }
}

// ------------------------------------------------------- player bookkeeping

function migrateHost(state: GameState): void {
  if (state.hostId && state.players[state.hostId]) return;
  const candidates = state.seatOrder
    .map((id) => state.players[id])
    .filter((p): p is Player => Boolean(p));
  const connected = candidates.filter((p) => p.connected);
  const pool = connected.length > 0 ? connected : candidates;
  // Longest-serving player takes over.
  state.hostId = pool.sort((a, b) => a.joinedAt - b.joinedAt)[0]?.id ?? null;
}

/**
 * Fully remove a player: seat, hand and any submission. Their cards go back to
 * the discard pile rather than vanishing, so the deck stays whole.
 */
function removePlayer(state: GameState, playerId: string, ctx: EngineContext): void {
  const player = state.players[playerId];
  if (!player) return;

  state.responseDiscard.push(...player.hand);
  const submission = state.submissions.find((s) => s.playerId === playerId);
  if (submission) {
    state.responseDiscard.push(...submission.cards);
    state.submissions = state.submissions.filter((s) => s.playerId !== playerId);
    state.revealOrder = state.revealOrder.filter((id) => id !== playerId);
  }

  delete state.players[playerId];
  state.seatOrder = state.seatOrder.filter((id) => id !== playerId);
  migrateHost(state);

  if (state.phase === 'lobby' || state.phase === 'gameOver') return;

  if (state.czarId === playerId) {
    // The czar walking out mid-round can't be judged, so the round is
    // discarded rather than handed to someone who may have already submitted.
    state.czarId = playerId;
    resolveRound(state, null, true, ctx);
    return;
  }

  maybeBeginJudging(state, ctx);
  maybeResume(state, ctx);
}

// ----------------------------------------------------------------- creation

/**
 * Build the draw piles for the enabled decks, dropping cards whose text
 * already appeared in an earlier deck.
 *
 * Decks come from unrelated upstream projects that borrow from each other —
 * Cards Against Reliability is a fork of Cards Against Cryptography, and both
 * inherit from Cards Against Humanity — so the same card text genuinely shows
 * up in more than one. Without this, enabling two related decks would deal the
 * same answer twice into one hand.
 *
 * Deduping here rather than at import time matters: which cards are duplicates
 * depends on which decks are switched on, and dropping them from the JSON
 * would mean a deck was missing cards whenever it was enabled on its own.
 */
function buildPiles(decks: readonly Deck[], enabled: readonly string[], rng: Rng) {
  const active = decks.filter((d) => enabled.includes(d.id));
  const seenPrompts = new Set<string>();
  const seenResponses = new Set<string>();
  const prompts: string[] = [];
  const responses: string[] = [];

  for (const deck of active) {
    for (const prompt of deck.prompts) {
      const key = prompt.text.toLowerCase();
      if (seenPrompts.has(key)) continue;
      seenPrompts.add(key);
      prompts.push(prompt.id);
    }
    for (const response of deck.responses) {
      const key = response.text.toLowerCase();
      if (seenResponses.has(key)) continue;
      seenResponses.add(key);
      responses.push(response.id);
    }
  }

  return { prompts: shuffle(prompts, rng), responses: shuffle(responses, rng) };
}

export function createGame(
  roomCode: string,
  ctx: EngineContext,
  settings: Partial<GameSettings> = {},
): GameState {
  const merged = { ...DEFAULT_SETTINGS, ...settings };
  const piles = buildPiles(ctx.decks.all, merged.deckIds, ctx.rng);
  return {
    roomCode,
    phase: 'lobby',
    hostId: null,
    players: {},
    seatOrder: [],
    czarId: null,
    round: 0,
    promptId: null,
    submissions: [],
    revealOrder: [],
    lastResult: null,
    history: [],
    settings: merged,
    deadline: null,
    paused: false,
    pausedRemainingMs: null,
    pausedBy: null,
    promptDraw: piles.prompts,
    promptDiscard: [],
    responseDraw: piles.responses,
    responseDiscard: [],
    winnerIds: [],
  };
}

/** Rebuild the draw piles from a new deck selection. Lobby only. */
function reshuffleForDecks(state: GameState, ctx: EngineContext): void {
  const piles = buildPiles(ctx.decks.all, state.settings.deckIds, ctx.rng);
  state.promptDraw = piles.prompts;
  state.promptDiscard = [];
  state.responseDraw = piles.responses;
  state.responseDiscard = [];
}

// ------------------------------------------------------------------ reducer

export function reduce(state: GameState, action: Action, ctx: EngineContext): GameState {
  const next = structuredClone(state);

  switch (action.type) {
    case 'join': {
      const existing = next.players[action.playerId];
      if (existing) {
        // Same playerId rejoining is a reconnect, not a new seat.
        existing.connected = true;
        existing.disconnectedAt = null;
        // Honour a changed name on rejoin. Silently keeping the old one is
        // confusing: a player who retypes their name sees someone else's.
        const rename = action.name.trim();
        const clashes = Object.values(next.players).some(
          (p) => p.id !== action.playerId && p.name.toLowerCase() === rename.toLowerCase(),
        );
        if (rename.length > 0 && !clashes) existing.name = rename;
        migrateHost(next);
        maybeResume(next, ctx);
        break;
      }
      if (next.seatOrder.length >= MAX_PLAYERS) throw new GameError('ROOM_FULL');
      const name = action.name.trim();
      if (Object.values(next.players).some((p) => p.name.toLowerCase() === name.toLowerCase())) {
        throw new GameError('NAME_TAKEN');
      }
      next.players[action.playerId] = {
        id: action.playerId,
        name,
        connected: true,
        disconnectedAt: null,
        score: 0,
        hand: [],
        joinedAt: ctx.now,
      };
      next.seatOrder.push(action.playerId);
      if (!next.hostId) next.hostId = action.playerId;
      // Joining mid-game deals in immediately so the new player isn't idle.
      if (next.phase !== 'lobby' && next.phase !== 'gameOver') {
        next.players[action.playerId]!.hand = drawResponses(next, next.settings.handSize, ctx.rng);
      }
      maybeResume(next, ctx);
      break;
    }

    case 'leave': {
      removePlayer(next, action.playerId, ctx);
      break;
    }

    case 'kick': {
      requireHost(next, action.playerId);
      if (action.targetId === action.playerId) throw new GameError('NOT_HOST');
      removePlayer(next, action.targetId, ctx);
      break;
    }

    case 'disconnect': {
      const player = next.players[action.playerId];
      if (!player || !player.connected) break;
      player.connected = false;
      player.disconnectedAt = ctx.now;

      if (next.phase === 'judging' && next.czarId === action.playerId) {
        // Don't let a closed laptop wedge the round. This grace applies even
        // when judge timers are off — but it is still held by a pause.
        shortenDeadline(next, ctx, CZAR_GRACE_MS);
      }
      // A dropped player no longer blocks the round.
      maybeBeginJudging(next, ctx);
      break;
    }

    case 'reconnect': {
      const player = requirePlayer(next, action.playerId);
      player.connected = true;
      player.disconnectedAt = null;
      maybeResume(next, ctx);
      break;
    }

    case 'reap': {
      // A pause holds everything, including the eviction grace. Otherwise a
      // long pause would quietly remove players who are still sitting there.
      if (next.paused) break;
      for (const id of [...next.seatOrder]) {
        const player = next.players[id];
        if (!player || player.connected || player.disconnectedAt === null) continue;
        if (ctx.now - player.disconnectedAt >= DISCONNECT_GRACE_MS) removePlayer(next, id, ctx);
      }
      break;
    }

    case 'updateSettings': {
      requireHost(next, action.playerId);
      const merged: GameSettings = { ...next.settings, ...action.settings };
      if (merged.handSize < 3 || merged.handSize > 20) throw new GameError('INVALID_SETTINGS');
      if (merged.pointsToWin !== null && merged.pointsToWin < 1) throw new GameError('INVALID_SETTINGS');
      if (merged.deckIds.length === 0) throw new GameError('INVALID_SETTINGS');

      const deckChanged =
        merged.deckIds.length !== next.settings.deckIds.length ||
        merged.deckIds.some((id) => !next.settings.deckIds.includes(id));
      const inLobby = next.phase === 'lobby';

      // Timers and the score target can be tuned mid-game — a host usually
      // only discovers the round length is wrong once play is under way. Decks
      // and hand size cannot: both would mean reshuffling under live hands.
      if (!inLobby && (deckChanged || merged.handSize !== next.settings.handSize)) {
        throw new GameError('WRONG_PHASE');
      }

      next.settings = merged;
      if (deckChanged) reshuffleForDecks(next, ctx);

      // Lowering the target below someone's score should end the game rather
      // than leaving it unwinnable-in-reverse.
      if (!inLobby && merged.pointsToWin !== null) {
        if (Object.values(next.players).some((p) => p.score >= merged.pointsToWin!)) {
          finishGame(next);
        }
      }
      break;
    }

    case 'startGame': {
      requireHost(next, action.playerId);
      requirePhase(next, 'lobby', 'gameOver');
      if (connectedIds(next).length < MIN_PLAYERS) throw new GameError('NOT_ENOUGH_PLAYERS');
      // Replaying from gameOver is a fresh game on the same seats.
      for (const player of Object.values(next.players)) {
        player.score = 0;
        player.hand = [];
      }
      next.round = 0;
      next.czarId = null;
      next.paused = false;
      next.pausedRemainingMs = null;
      next.pausedBy = null;
      next.history = [];
      next.winnerIds = [];
      next.lastResult = null;
      reshuffleForDecks(next, ctx);
      beginRound(next, ctx);
      break;
    }

    case 'submit': {
      requirePhase(next, 'submitting');
      const player = requirePlayer(next, action.playerId);
      if (!player.connected) throw new GameError('UNKNOWN_PLAYER');
      if (action.playerId === next.czarId) throw new GameError('IS_CZAR');
      if (hasSubmitted(next, action.playerId)) throw new GameError('ALREADY_SUBMITTED');

      const prompt = currentPrompt(next, ctx.decks);
      if (!prompt) throw new GameError('WRONG_PHASE');
      if (action.cards.length !== prompt.pick) throw new GameError('BAD_SUBMISSION');
      if (new Set(action.cards).size !== action.cards.length) throw new GameError('BAD_SUBMISSION');
      if (!action.cards.every((c) => player.hand.includes(c))) throw new GameError('BAD_SUBMISSION');

      player.hand = player.hand.filter((c) => !action.cards.includes(c));
      next.submissions.push({ playerId: action.playerId, cards: [...action.cards] });
      maybeBeginJudging(next, ctx);
      break;
    }

    case 'unsubmit': {
      requirePhase(next, 'submitting');
      const player = requirePlayer(next, action.playerId);
      const submission = next.submissions.find((s) => s.playerId === action.playerId);
      if (!submission) throw new GameError('NO_SUCH_SUBMISSION');
      player.hand.push(...submission.cards);
      next.submissions = next.submissions.filter((s) => s.playerId !== action.playerId);
      break;
    }

    case 'selectWinner': {
      requirePhase(next, 'judging');
      if (action.playerId !== next.czarId) throw new GameError('NOT_CZAR');
      if (!hasSubmitted(next, action.winnerId)) throw new GameError('NO_SUCH_SUBMISSION');
      resolveRound(next, action.winnerId, false, ctx);
      break;
    }

    case 'nextRound': {
      requireHost(next, action.playerId);
      requirePhase(next, 'roundResult');
      advanceFromResult(next, ctx);
      break;
    }

    case 'endGame': {
      requireHost(next, action.playerId);
      requirePhase(next, 'submitting', 'judging', 'roundResult');
      finishGame(next);
      break;
    }

    case 'pause': {
      requirePlayer(next, action.playerId);
      requirePhase(next, 'submitting', 'judging', 'roundResult');
      if (next.paused) break;
      next.paused = true;
      next.pausedRemainingMs = next.deadline === null ? null : Math.max(0, next.deadline - ctx.now);
      next.pausedBy = action.playerId;
      next.deadline = null;
      break;
    }

    case 'resume': {
      requirePlayer(next, action.playerId);
      if (!next.paused) break;
      next.paused = false;
      next.pausedBy = null;
      next.deadline = next.pausedRemainingMs === null ? null : ctx.now + next.pausedRemainingMs;
      next.pausedRemainingMs = null;
      break;
    }

    case 'timeout': {
      // A held clock means no phase may expire. The scheduler shouldn't fire
      // one anyway (a pause clears the deadline), but a stray or replayed
      // timeout must not quietly skip the round people are talking over.
      if (next.paused) break;
      advancePhase(next, ctx);
      break;
    }

    case 'forceAdvance': {
      requireHost(next, action.playerId);
      requirePhase(next, 'submitting', 'judging', 'roundResult');
      // The host asked explicitly, so this works through a pause: it exists
      // precisely for the case where the game is stuck and waiting won't help.
      advancePhase(next, ctx);
      break;
    }

    case 'transferHost': {
      requireHost(next, action.playerId);
      const target = requirePlayer(next, action.targetId);
      if (!target.connected) throw new GameError('UNKNOWN_PLAYER');
      next.hostId = action.targetId;
      break;
    }
  }

  return next;
}
