/**
 * The game connection.
 *
 * Socket.IO handles reconnection and, importantly, falls back to HTTP
 * long-polling when a proxy blocks WebSocket upgrades — which is what keeps
 * the game working for teammates on corporate VPNs.
 */
import { io, type Socket } from 'socket.io-client';
import type {
  ClientAction,
  JoinAck,
  PublicGameState,
  ServerToClientEvents,
  ClientToServerEvents,
} from '@cac/shared/protocol';

export type GameSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

/** In dev the Vite proxy forwards to the server; in production it's same-origin. */
export function connect(): GameSocket {
  return io({
    // Polling first, then upgrade: a player behind a proxy that blocks
    // WebSockets still gets into the game rather than failing to connect.
    transports: ['polling', 'websocket'],
    reconnection: true,
    reconnectionDelay: 500,
    reconnectionDelayMax: 5_000,
  });
}

export function createRoom(socket: GameSocket, playerId: string, name: string): Promise<JoinAck> {
  return new Promise((resolve) => socket.emit('createRoom', { playerId, name }, resolve));
}

export function joinRoom(
  socket: GameSocket,
  roomCode: string,
  playerId: string,
  name: string,
): Promise<JoinAck> {
  return new Promise((resolve) => socket.emit('join', { roomCode, playerId, name }, resolve));
}

export function send(socket: GameSocket, action: ClientAction): void {
  socket.emit('action', action);
}

export type { PublicGameState };
