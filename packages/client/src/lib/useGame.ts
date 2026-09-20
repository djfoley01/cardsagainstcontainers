/**
 * Connects to the server and exposes the current game state.
 *
 * The client holds no game logic. It renders whatever the server last sent and
 * sends back intents; every rule lives in the engine. That's also why a
 * reconnect needs no reconciliation — the next state frame is the truth.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ClientAction, JoinAck, PublicGameState } from '@cac/shared/protocol';
import { connect, createRoom, joinRoom, send, type GameSocket } from './socket.ts';
import { playerId, rememberName } from './identity.ts';

export type ConnectionState = 'connecting' | 'online' | 'offline';

export interface GameApi {
  state: PublicGameState | null;
  connection: ConnectionState;
  /** Transient message from a rejected action, shown then cleared. */
  error: string | null;
  clearError: () => void;
  create: (name: string) => Promise<JoinAck>;
  join: (code: string, name: string) => Promise<JoinAck>;
  act: (action: ClientAction) => void;
  leave: () => void;
}

export function useGame(): GameApi {
  const socketRef = useRef<GameSocket | null>(null);
  const [state, setState] = useState<PublicGameState | null>(null);
  const [connection, setConnection] = useState<ConnectionState>('connecting');
  const [error, setError] = useState<string | null>(null);

  // Remembered so an automatic reconnect can rejoin without asking again.
  const sessionRef = useRef<{ code: string; name: string } | null>(null);

  useEffect(() => {
    const socket = connect();
    socketRef.current = socket;

    socket.on('connect', () => {
      setConnection('online');
      // Socket.IO reconnected us, but the server treats a new socket as a new
      // connection: rejoin the room to reclaim the seat.
      const session = sessionRef.current;
      if (!session) return;

      void joinRoom(socket, session.code, playerId(), session.name).then((ack) => {
        if (ack.ok) return;
        // The room is gone — most likely the server restarted, since state is
        // in memory by design. Drop back to the join screen and say why,
        // rather than leaving a stale board on screen forever.
        sessionRef.current = null;
        setState(null);
        setError(
          ack.code === 'NO_SUCH_ROOM'
            ? 'That room has ended — the server restarted. Start a new one.'
            : ack.message,
        );
      });
    });
    socket.on('disconnect', () => setConnection('offline'));
    socket.io.on('reconnect_attempt', () => setConnection('connecting'));

    socket.on('state', setState);
    socket.on('actionError', (err) => setError(err.message));
    socket.on('removed', (reason) => {
      sessionRef.current = null;
      setState(null);
      // Without this a kicked player is dropped to the join screen with no
      // explanation and will just try to rejoin.
      if (reason === 'kicked') setError('The host removed you from the room.');
    });

    return () => {
      socket.close();
      socketRef.current = null;
    };
  }, []);

  const create = useCallback(async (name: string): Promise<JoinAck> => {
    const socket = socketRef.current;
    if (!socket) return { ok: false, code: 'BAD_REQUEST', message: 'Not connected yet.' };
    const ack = await createRoom(socket, playerId(), name);
    if (ack.ok) {
      sessionRef.current = { code: ack.roomCode, name };
      rememberName(name);
    }
    return ack;
  }, []);

  const join = useCallback(async (code: string, name: string): Promise<JoinAck> => {
    const socket = socketRef.current;
    if (!socket) return { ok: false, code: 'BAD_REQUEST', message: 'Not connected yet.' };
    const normalized = code.trim().toUpperCase();
    const ack = await joinRoom(socket, normalized, playerId(), name);
    if (ack.ok) {
      sessionRef.current = { code: ack.roomCode, name };
      rememberName(name);
    }
    return ack;
  }, []);

  const act = useCallback((action: ClientAction) => {
    const socket = socketRef.current;
    if (socket) send(socket, action);
  }, []);

  const leave = useCallback(() => {
    sessionRef.current = null;
    act({ type: 'leave' });
    setState(null);
  }, [act]);

  return {
    state,
    connection,
    error,
    clearError: useCallback(() => setError(null), []),
    create,
    join,
    act,
    leave,
  };
}
