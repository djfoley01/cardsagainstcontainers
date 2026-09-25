/**
 * The client/server wire protocol.
 *
 * Two rules shape everything here:
 *
 * 1. The client never sends its own playerId in an action. Identity comes from
 *    the socket session, so a player cannot act as someone else by editing a
 *    payload.
 * 2. The server never sends a client information it shouldn't have: other
 *    players' hands, the draw piles, or — during judging — who submitted what.
 */
import type { PromptCard, ResponseCard } from './deck.ts';
import type { GameErrorCode, GameSettings, Phase } from './game.ts';

/** A player as everyone else sees them. Note: no hand, only a count. */
export interface PublicPlayer {
  id: string;
  name: string;
  connected: boolean;
  score: number;
  handCount: number;
  isHost: boolean;
  isCzar: boolean;
  /** Public during submitting so players can see who they're waiting on. */
  hasSubmitted: boolean;
}

/**
 * A submission on the table. `playerId` is null during judging and filled in
 * once the round resolves — that's the anonymity guarantee, enforced server
 * side rather than hidden in the UI.
 */
export interface PublicSubmission {
  /** Position in the shuffled reveal order. The czar picks by this. */
  index: number;
  cards: ResponseCard[];
  playerId: string | null;
}

export interface PublicRoundResult {
  prompt: PromptCard;
  winnerId: string;
  winnerName: string;
  winningCards: ResponseCard[];
  submissions: PublicSubmission[];
  skipped: boolean;
  auto: boolean;
}

/** What the viewer alone may see. */
export interface SelfView {
  id: string;
  hand: ResponseCard[];
  isHost: boolean;
  isCzar: boolean;
  hasSubmitted: boolean;
  /** Cards this player currently has on the table, if any. */
  submittedCards: ResponseCard[];
}

/** A deck the host can switch on, with the credit its licence requires. */
export interface DeckInfo {
  id: string;
  name: string;
  description: string;
  prompts: number;
  responses: number;
  license: string;
  licenseUrl: string;
  source: string;
}

export interface PublicGameState {
  roomCode: string;
  phase: Phase;
  round: number;
  hostId: string | null;
  czarId: string | null;
  /** In seat order. */
  players: PublicPlayer[];
  prompt: PromptCard | null;
  /** Empty until judging. Anonymous during judging. */
  submissions: PublicSubmission[];
  submissionCount: number;
  /** How many players still owe a submission. */
  awaitingCount: number;
  lastResult: PublicRoundResult | null;
  history: PublicRoundResult[];
  settings: GameSettings;
  /** Every deck the server loaded, so the lobby isn't a hardcoded list. */
  availableDecks: DeckInfo[];
  /** Epoch ms this phase auto-advances at, or null. */
  deadline: number | null;
  paused: boolean;
  /** Display name of whoever paused, if anyone. */
  pausedBy: string | null;
  winnerIds: string[];
  responsesRemaining: number;
  promptsRemaining: number;
  you: SelfView;
}

/** Actions a client may request. Identity is taken from the session. */
export type ClientAction =
  | { type: 'startGame' }
  | { type: 'updateSettings'; settings: Partial<GameSettings> }
  | { type: 'submit'; cards: string[] }
  | { type: 'unsubmit' }
  /** Index into the shuffled reveal order, not a player id. */
  | { type: 'selectWinner'; index: number }
  | { type: 'nextRound' }
  | { type: 'endGame' }
  /** Host override for a stalled round. */
  | { type: 'forceAdvance' }
  | { type: 'transferHost'; targetId: string }
  /** Any player may hold the clock; this is a party game, not a tournament. */
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'kick'; targetId: string }
  | { type: 'leave' };

export interface JoinRequest {
  roomCode: string;
  /** Stable id from the client's localStorage, so a refresh keeps the seat. */
  playerId: string;
  name: string;
}

export type JoinErrorCode = GameErrorCode | 'NO_SUCH_ROOM' | 'BAD_REQUEST';

export interface ClientToServerEvents {
  join: (req: JoinRequest, ack: (res: JoinAck) => void) => void;
  createRoom: (req: Omit<JoinRequest, 'roomCode'>, ack: (res: JoinAck) => void) => void;
  action: (action: ClientAction) => void;
}

export type JoinAck = { ok: true; roomCode: string } | { ok: false; code: JoinErrorCode; message: string };

export interface ServerToClientEvents {
  state: (state: PublicGameState) => void;
  /** Sent to every connected socket, including those not in a room. */
  stats: (stats: LobbyStats) => void;
  /** A rejected action. Sent only to the client that attempted it. */
  actionError: (err: { code: JoinErrorCode; message: string }) => void;
  /** The server removed this client from the room. */
  removed: (reason: 'kicked' | 'left') => void;
}

/** One player's running tally, aggregated across every room on the server. */
export interface PlayerTally {
  playerId: string;
  name: string;
  roundsWon: number;
  gamesWon: number;
}

/**
 * What the landing page shows before anyone has joined a room.
 *
 * Deliberately no room codes. Anyone can load the landing page, and printing
 * a code there would let a passer-by drop into a colleague's game. Live
 * activity is therefore reported as counts only; names appear solely in the
 * tally, where the point is to credit people.
 */
export interface LobbyStats {
  /** When counting started — the server's boot, since none of this persists. */
  since: number;
  /** Rooms with a game under way. */
  activeGames: number;
  /** Rooms sitting in a lobby, waiting to start. */
  openLobbies: number;
  /** Connected players across every room. */
  playersOnline: number;
  /** Rounds resolved with a winner since counting started. */
  roundsPlayed: number;
  /** Highest scorers first. Empty until somebody wins a round. */
  leaders: PlayerTally[];
}

export const ROOM_CODE_LENGTH = 4;
/** No I or O: they read as 1 and 0 when someone types a code off a video call. */
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
