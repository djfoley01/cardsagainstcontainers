/**
 * Socket.IO wiring: the thin shell around the engine.
 *
 * Responsibilities, and nothing more:
 *   - map a socket to a (room, playerId) session
 *   - translate ClientAction into an engine Action, supplying identity from
 *     the session rather than the payload
 *   - broadcast redacted state, per viewer
 *   - turn GameError into a message for the one client at fault
 */
import type { Server, Socket } from 'socket.io';
import { GameError, type Action } from '@cac/shared/game';
import type {
  ClientAction,
  ClientToServerEvents,
  JoinAck,
  JoinRequest,
  ServerToClientEvents,
} from '@cac/shared/protocol';
import { ROOM_CODE_LENGTH } from '@cac/shared/protocol';
import type { RoomRegistry } from './registry.ts';
import type { Room } from './room.ts';
import { toPublicState } from './redact.ts';

export type GameSocket = Socket<ClientToServerEvents, ServerToClientEvents>;
export type GameServer = Server<ClientToServerEvents, ServerToClientEvents>;

interface Session {
  room: Room;
  playerId: string;
}

const MAX_NAME_LENGTH = 24;

function sanitizeName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  // Strip control characters; they render as invisible junk in the scoreboard.
  const name = raw.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, MAX_NAME_LENGTH);
  return name.length > 0 ? name : null;
}

function sanitizePlayerId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const id = raw.trim();
  return /^[A-Za-z0-9_-]{8,64}$/.test(id) ? id : null;
}

export function attachSocketHandlers(io: GameServer, registry: RoomRegistry): void {
  const sessions = new WeakMap<GameSocket, Session>();

  /** Send each member of the room the view built for them specifically. */
  function broadcast(room: Room): void {
    for (const socket of io.sockets.sockets.values()) {
      const session = sessions.get(socket as GameSocket);
      if (!session || session.room !== room) continue;
      socket.emit('state', toPublicState(room.state, session.playerId, room.decks));
    }
  }

  function bind(socket: GameSocket, room: Room, playerId: string): void {
    sessions.set(socket, { room, playerId });
    void socket.join(room.code);
  }

  /** The connected socket for a player in a room, if they have one. */
  function socketFor(room: Room, playerId: string): GameSocket | undefined {
    for (const socket of io.sockets.sockets.values()) {
      const session = sessions.get(socket as GameSocket);
      if (session?.room === room && session.playerId === playerId) return socket as GameSocket;
    }
    return undefined;
  }

  /** Detach a socket from its room and tell it why. */
  function release(socket: GameSocket, room: Room, reason: 'kicked' | 'left'): void {
    sessions.delete(socket);
    socket.emit('removed', reason);
    void socket.leave(room.code);
  }

  function enter(socket: GameSocket, room: Room, req: JoinRequest, ack: (res: JoinAck) => void): void {
    const name = sanitizeName(req.name);
    const playerId = sanitizePlayerId(req.playerId);
    if (!name || !playerId) {
      ack({ ok: false, code: 'BAD_REQUEST', message: 'A name and a valid player id are required.' });
      return;
    }

    try {
      room.dispatch({ type: 'join', playerId, name });
    } catch (err) {
      if (err instanceof GameError) {
        ack({ ok: false, code: err.code, message: describe(err.code) });
        return;
      }
      throw err;
    }

    bind(socket, room, playerId);
    ack({ ok: true, roomCode: room.code });
    // Explicit, unlike elsewhere: the join dispatch above fired the change
    // hook before this socket had a session, so it missed that broadcast.
    broadcast(room);
  }

  io.on('connection', (socket: GameSocket) => {
    socket.on('createRoom', (req, ack) => {
      // Rooms are only ever created here, and the change hook is wired at the
      // same moment: without it, timer-driven transitions (a submission
      // deadline passing, a czar's grace expiring) would update state that no
      // client ever sees.
      const room = registry.create();
      room.onChange(() => broadcast(room));
      enter(socket, room, { ...req, roomCode: room.code }, ack);
    });

    socket.on('join', (req, ack) => {
      const code = typeof req?.roomCode === 'string' ? req.roomCode.trim().toUpperCase() : '';
      if (code.length !== ROOM_CODE_LENGTH) {
        ack({ ok: false, code: 'BAD_REQUEST', message: 'Room codes are four letters.' });
        return;
      }
      const room = registry.get(code);
      if (!room) {
        ack({ ok: false, code: 'NO_SUCH_ROOM', message: `No room ${code}. Check the code and try again.` });
        return;
      }
      enter(socket, room, { ...req, roomCode: code }, ack);
    });

    socket.on('action', (action: ClientAction) => {
      const session = sessions.get(socket);
      if (!session) {
        socket.emit('actionError', { code: 'BAD_REQUEST', message: 'Join a room first.' });
        return;
      }
      const { room, playerId } = session;

      let engineAction: Action;
      try {
        engineAction = translate(action, playerId, room);
      } catch (err) {
        if (err instanceof GameError) {
          socket.emit('actionError', { code: err.code, message: describe(err.code) });
          return;
        }
        throw err;
      }

      try {
        room.dispatch(engineAction);
      } catch (err) {
        if (err instanceof GameError) {
          // GameError may carry a more specific message than the generic text.
          socket.emit('actionError', { code: err.code, message: err.message || describe(err.code) });
          return;
        }
        throw err;
      }

      // No explicit broadcast: dispatch() notifies listeners, and the hook
      // registered at room creation fans the new state out.
      if (action.type === 'leave') {
        release(socket, room, 'left');
      } else if (action.type === 'kick') {
        // The kicked player is no longer in the game, but their socket still
        // holds a session. Without this they'd sit watching broadcasts with an
        // empty hand and no seat, unable to tell what happened.
        const victim = socketFor(room, action.targetId);
        if (victim) release(victim, room, 'kicked');
      }
    });

    socket.on('disconnect', () => {
      const session = sessions.get(socket);
      if (!session) return;
      const { room, playerId } = session;
      // Drop the session first so the broadcast that follows skips this
      // socket, which is already gone.
      sessions.delete(socket);
      // The seat survives; the engine's grace period decides when it doesn't.
      try {
        room.dispatch({ type: 'disconnect', playerId });
      } catch {
        // A disconnect from a room that already evicted the player is fine.
      }
    });
  });
}

/**
 * Turn a client request into an engine action. Identity always comes from the
 * session, and `selectWinner` arrives as a reveal-order index which only the
 * server can map back to a player — a client cannot name the winner directly.
 */
function translate(action: ClientAction, playerId: string, room: Room): Action {
  switch (action.type) {
    case 'startGame':
      return { type: 'startGame', playerId };
    case 'updateSettings':
      return { type: 'updateSettings', playerId, settings: action.settings ?? {} };
    case 'submit': {
      if (!Array.isArray(action.cards) || !action.cards.every((c) => typeof c === 'string')) {
        throw new GameError('BAD_SUBMISSION');
      }
      return { type: 'submit', playerId, cards: action.cards };
    }
    case 'unsubmit':
      return { type: 'unsubmit', playerId };
    case 'selectWinner': {
      const winnerId = room.state.revealOrder[action.index];
      if (!winnerId) throw new GameError('NO_SUCH_SUBMISSION');
      return { type: 'selectWinner', playerId, winnerId };
    }
    case 'nextRound':
      return { type: 'nextRound', playerId };
    case 'endGame':
      return { type: 'endGame', playerId };
    case 'forceAdvance':
      return { type: 'forceAdvance', playerId };
    case 'transferHost': {
      if (typeof action.targetId !== 'string') throw new GameError('UNKNOWN_PLAYER');
      return { type: 'transferHost', playerId, targetId: action.targetId };
    }
    case 'pause':
      return { type: 'pause', playerId };
    case 'resume':
      return { type: 'resume', playerId };
    case 'kick': {
      if (typeof action.targetId !== 'string') throw new GameError('UNKNOWN_PLAYER');
      return { type: 'kick', playerId, targetId: action.targetId };
    }
    case 'leave':
      return { type: 'leave', playerId };
    default:
      throw new GameError('BAD_SUBMISSION');
  }
}

/** Player-facing text for an error code. */
function describe(code: string): string {
  switch (code) {
    case 'ROOM_FULL':
      return 'That room is full.';
    case 'NAME_TAKEN':
      return 'Someone in this room is already using that name.';
    case 'NOT_HOST':
      return 'Only the host can do that.';
    case 'NOT_CZAR':
      return 'Only the Card Czar picks the winner.';
    case 'IS_CZAR':
      return "You're the Card Czar this round — you judge instead of playing.";
    case 'WRONG_PHASE':
      return "That isn't available right now.";
    case 'NOT_ENOUGH_PLAYERS':
      return 'You need at least three players to start.';
    case 'NOT_ENOUGH_CARDS':
      return 'Not enough answer cards for this many players. Enable another deck.';
    case 'ALREADY_SUBMITTED':
      return "You've already played this round.";
    case 'BAD_SUBMISSION':
      return "That play isn't valid.";
    case 'NO_SUCH_SUBMISSION':
      return 'That card is no longer on the table.';
    case 'INVALID_SETTINGS':
      return 'Those settings are out of range.';
    case 'NO_SUCH_ROOM':
      return 'No room with that code.';
    default:
      return 'Something went wrong.';
  }
}
