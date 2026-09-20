# ADR 001: Host on Fly.io, not Vercel or Netlify

**Status:** Accepted — 2026-09-19

## Context

Cards Against Containers is a real-time multiplayer game for a distributed team.
Players at different locations join a room by code and play together. The natural
question is why this isn't deployed on Vercel or Netlify like most of our web work.

## Decision

Deploy as a single Docker container on Fly.io. Game state lives in the server
process's memory. No database.

## Why not Vercel

Vercel *does* support WebSockets — it reached public beta in June 2026, and
Socket.IO works on it. The problem isn't the transport, it's the execution model.

1. **Connections die on a timer.** A WebSocket closes when the function hits its
   max duration: 300s on Hobby, 800s on Pro. Every player would be disconnected
   every five minutes for the length of the happy hour.

2. **Reconnects aren't sticky.** Per Vercel's docs, "New WebSocket connections are
   not guaranteed to reach the same Vercel Function instance." A player
   reconnecting mid-round can land on a process that has never heard of the room.

3. **No cross-instance broadcast.** With ~12 players spread over instances, one
   player's submission can't reach the others. Vercel's own guidance is to put
   rooms, presence and pub/sub in external Redis.

Adopting Vercel therefore means Redis for all game state plus a Socket.IO Redis
adapter for broadcast — real complexity, to support a 12-person game that fits
comfortably in one process's memory. It also forces `transports: ['websocket']`,
losing Socket.IO's HTTP long-polling fallback, which is the thing that keeps the
game working for teammates behind corporate VPNs and hotel wifi.

Billing is a minor factor: open connections bill for provisioned memory time for
their full duration.

## Why not Netlify

Netlify cannot host a persistent socket server at all. Its documented approach is
to delegate real-time to a third-party service such as Ably or Pusher — a paid
dependency plus an external datastore, for strictly less capability.

## Consequences

- A server restart or redeploy ends any in-progress game. Accepted: this is a
  happy-hour game, not a service with an SLA.
- Scale is bounded by one process. Fine to roughly 12 players and a handful of
  concurrent rooms.
- If we ever need multi-process, the escape hatch is the same one Vercel would
  have forced on day one: move room state to Redis and add the Socket.IO adapter.
  The game engine is a pure reducer specifically so that swap stays contained.

## References

- https://vercel.com/docs/functions/websockets
- https://vercel.com/docs/functions/limitations
- https://www.netlify.com/blog/web-sockets-in-a-serverless-world/
