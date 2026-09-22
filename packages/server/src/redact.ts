/**
 * Projects full GameState down to what one specific viewer may see.
 *
 * This is a security boundary, not a convenience. Everything the server sends
 * reaches the browser, so anything withheld must be withheld *here* — never by
 * simply not rendering it. In particular:
 *
 *   - a player's hand goes only to that player
 *   - draw piles are reduced to counts
 *   - during judging, submissions carry no playerId at all
 *
 * The audience for that last rule is a Kubernetes team with devtools open.
 */
import type { PromptCard, ResponseCard } from '@cac/shared/deck';
import type { GameState, RoundResult, Submission } from '@cac/shared/game';
import type {
  DeckInfo,
  PublicGameState,
  PublicPlayer,
  PublicRoundResult,
  PublicSubmission,
  SelfView,
} from '@cac/shared/protocol';
import type { DeckIndex } from './engine/reduce.ts';
import { hasSubmitted, requiredSubmitters } from './engine/reduce.ts';

function cards(ids: readonly string[], decks: DeckIndex): ResponseCard[] {
  return ids.map((id) => decks.responses.get(id)).filter((c): c is ResponseCard => Boolean(c));
}

function prompt(id: string | null, decks: DeckIndex): PromptCard | null {
  return id ? (decks.prompts.get(id) ?? null) : null;
}

/**
 * Order submissions by the shuffled reveal order and strip identity when the
 * round is still being judged.
 */
function publicSubmissions(state: GameState, decks: DeckIndex, reveal: boolean): PublicSubmission[] {
  const byPlayer = new Map<string, Submission>(state.submissions.map((s) => [s.playerId, s]));
  return state.revealOrder
    .map((playerId, index) => {
      const submission = byPlayer.get(playerId);
      if (!submission) return null;
      return {
        index,
        cards: cards(submission.cards, decks),
        playerId: reveal ? playerId : null,
      } satisfies PublicSubmission;
    })
    .filter((s): s is PublicSubmission => s !== null);
}

function publicResult(state: GameState, result: RoundResult, decks: DeckIndex): PublicRoundResult {
  return {
    prompt: prompt(result.promptId, decks)!,
    winnerId: result.winnerId,
    winnerName: state.players[result.winnerId]?.name ?? '',
    winningCards: cards(result.winningCards, decks),
    // A finished round is fully revealed.
    submissions: result.submissions.map((s, index) => ({
      index,
      cards: cards(s.cards, decks),
      playerId: s.playerId,
    })),
    skipped: result.skipped,
    auto: result.auto,
  };
}

export function toPublicState(state: GameState, viewerId: string, decks: DeckIndex): PublicGameState {
  const viewer = state.players[viewerId];

  const players: PublicPlayer[] = state.seatOrder
    .map((id) => state.players[id])
    .filter((p): p is NonNullable<typeof p> => Boolean(p))
    .map((p) => ({
      id: p.id,
      name: p.name,
      connected: p.connected,
      score: p.score,
      handCount: p.hand.length,
      isHost: state.hostId === p.id,
      isCzar: state.czarId === p.id,
      hasSubmitted: hasSubmitted(state, p.id),
    }));

  // Identities attach only once judging is over.
  const reveal = state.phase === 'roundResult' || state.phase === 'gameOver';
  const submissions = state.phase === 'submitting' ? [] : publicSubmissions(state, decks, reveal);

  const mySubmission = state.submissions.find((s) => s.playerId === viewerId);
  const you: SelfView = {
    id: viewerId,
    hand: viewer ? cards(viewer.hand, decks) : [],
    isHost: state.hostId === viewerId,
    isCzar: state.czarId === viewerId,
    hasSubmitted: Boolean(mySubmission),
    submittedCards: mySubmission ? cards(mySubmission.cards, decks) : [],
  };

  return {
    roomCode: state.roomCode,
    phase: state.phase,
    round: state.round,
    hostId: state.hostId,
    czarId: state.czarId,
    players,
    prompt: prompt(state.promptId, decks),
    submissions,
    submissionCount: state.submissions.length,
    awaitingCount: requiredSubmitters(state, prompt(state.promptId, decks)?.pick ?? 1).filter(
      (id) => !hasSubmitted(state, id),
    ).length,
    lastResult: state.lastResult ? publicResult(state, state.lastResult, decks) : null,
    // Newest first, capped: the history panel doesn't need the whole night.
    history: state.history.slice(-20).reverse().map((r) => publicResult(state, r, decks)),
    settings: state.settings,
    availableDecks: decks.all.map(
      (d): DeckInfo => ({
        id: d.id,
        name: d.name,
        description: d.description,
        prompts: d.prompts.length,
        responses: d.responses.length,
        license: d.attribution.license,
        licenseUrl: d.attribution.licenseUrl,
        source: d.attribution.source,
      }),
    ),
    deadline: state.deadline,
    paused: state.paused,
    pausedBy: state.pausedBy ? (state.players[state.pausedBy]?.name ?? null) : null,
    winnerIds: state.winnerIds,
    responsesRemaining: state.responseDraw.length + state.responseDiscard.length,
    promptsRemaining: state.promptDraw.length + state.promptDiscard.length,
    you,
  };
}
