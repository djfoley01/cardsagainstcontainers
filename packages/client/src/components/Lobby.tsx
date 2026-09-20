/**
 * The waiting room: share the code, tune settings, start the game.
 */
import { useState } from 'react';
import { MIN_PLAYERS, type GameSettings } from '@cac/shared/game';
import type { ClientAction, PublicGameState } from '@cac/shared/protocol';
import { PlayerList } from './PlayerList.tsx';
import { Attribution } from './Attribution.tsx';

export function Lobby({
  state,
  act,
}: {
  state: PublicGameState;
  act: (action: ClientAction) => void;
}) {
  const [copied, setCopied] = useState(false);
  const isHost = state.you.isHost;
  const connected = state.players.filter((p) => p.connected).length;
  const canStart = connected >= MIN_PLAYERS;

  const shareUrl = `${window.location.origin}/${state.roomCode}`;

  async function copy() {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // Clipboard is blocked in some contexts; the code is on screen anyway.
    }
  }

  function update(settings: Partial<GameSettings>) {
    act({ type: 'updateSettings', settings });
  }

  function toggleDeck(id: string) {
    const next = state.settings.deckIds.includes(id)
      ? state.settings.deckIds.filter((d) => d !== id)
      : [...state.settings.deckIds, id];
    // The server rejects an empty selection; don't let the UI ask for one.
    if (next.length === 0) return;
    update({ deckIds: next });
  }

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-8">
      <header className="flex flex-col items-center gap-3 text-center">
        <h1 className="text-2xl font-black text-white">Waiting to start</h1>
        <button
          type="button"
          onClick={() => void copy()}
          title="Copy the invite link"
          className="group flex items-center gap-3 rounded-2xl bg-felt-900 px-6 py-4 ring-1 ring-white/10 transition hover:ring-accent-500/50"
        >
          <span className="font-mono text-4xl font-black tracking-[0.35em] text-white">{state.roomCode}</span>
          <span className="text-xs font-semibold text-felt-500 group-hover:text-accent-400">
            {copied ? 'Copied!' : 'Copy link'}
          </span>
        </button>
        <p className="text-sm text-felt-500">Share the code or the link with your team.</p>
      </header>

      <section className="grid gap-6 md:grid-cols-[1fr_1.1fr]">
        <div className="flex flex-col gap-3 rounded-2xl bg-felt-900 p-4 ring-1 ring-white/10">
          <h2 className="text-xs font-bold tracking-wider text-felt-500 uppercase">
            Players ({connected})
          </h2>
          <PlayerList state={state} onKick={(id) => act({ type: 'kick', targetId: id })} />
          {!canStart && (
            <p className="text-sm text-warn-400">
              Need at least {MIN_PLAYERS} players — {MIN_PLAYERS - connected} more to go.
            </p>
          )}
        </div>

        <div className="flex flex-col gap-4 rounded-2xl bg-felt-900 p-4 ring-1 ring-white/10">
          <h2 className="text-xs font-bold tracking-wider text-felt-500 uppercase">Settings</h2>

          <fieldset className="flex flex-col gap-2" disabled={!isHost}>
            <legend className="mb-1 text-sm font-semibold text-felt-300">Decks</legend>
            {state.availableDecks.map((deck) => (
              <label
                key={deck.id}
                className={`flex items-center gap-3 rounded-lg px-3 py-2 ring-1 transition ${
                  state.settings.deckIds.includes(deck.id)
                    ? 'bg-accent-500/10 ring-accent-500/40'
                    : 'bg-felt-800 ring-transparent'
                } ${isHost ? 'cursor-pointer' : 'opacity-70'}`}
              >
                <input
                  type="checkbox"
                  checked={state.settings.deckIds.includes(deck.id)}
                  onChange={() => toggleDeck(deck.id)}
                  className="mt-0.5 size-4 shrink-0 accent-[oklch(0.68_0.17_195)]"
                />
                <span className="flex-1">
                  <span className="block text-sm font-semibold text-white">{deck.name}</span>
                  <span className="block text-xs text-felt-500">{deck.description}</span>
                  <span className="block text-[0.7rem] text-felt-700">
                    {deck.prompts} prompts · {deck.responses} answers
                  </span>
                </span>
              </label>
            ))}
          </fieldset>

          <label className="flex items-center justify-between gap-3 text-sm">
            <span className="font-semibold text-felt-300">Play to</span>
            <select
              disabled={!isHost}
              value={state.settings.pointsToWin ?? 'endless'}
              onChange={(e) =>
                update({ pointsToWin: e.target.value === 'endless' ? null : Number(e.target.value) })
              }
              className="rounded-lg bg-felt-800 px-3 py-1.5 text-white disabled:opacity-60"
            >
              {[3, 5, 7, 10].map((n) => (
                <option key={n} value={n}>
                  {n} points
                </option>
              ))}
              <option value="endless">No limit</option>
            </select>
          </label>

          <label className="flex items-center justify-between gap-3 text-sm">
            <span className="font-semibold text-felt-300">Time to play</span>
            <select
              disabled={!isHost}
              value={state.settings.submitTimerMs ?? 'off'}
              onChange={(e) =>
                update({ submitTimerMs: e.target.value === 'off' ? null : Number(e.target.value) })
              }
              className="rounded-lg bg-felt-800 px-3 py-1.5 text-white disabled:opacity-60"
            >
              {[60_000, 90_000, 120_000, 180_000].map((ms) => (
                <option key={ms} value={ms}>
                  {ms / 1000}s
                </option>
              ))}
              <option value="off">No timer</option>
            </select>
          </label>

          <label className="flex items-center justify-between gap-3 text-sm">
            <span className="font-semibold text-felt-300">Time to judge</span>
            <select
              disabled={!isHost}
              value={state.settings.judgeTimerMs ?? 'off'}
              onChange={(e) =>
                update({ judgeTimerMs: e.target.value === 'off' ? null : Number(e.target.value) })
              }
              className="rounded-lg bg-felt-800 px-3 py-1.5 text-white disabled:opacity-60"
            >
              {[30_000, 60_000, 90_000].map((ms) => (
                <option key={ms} value={ms}>
                  {ms / 1000}s
                </option>
              ))}
              <option value="off">No timer</option>
            </select>
          </label>

          {!isHost && (
            <p className="text-xs text-felt-700">
              Only {state.players.find((p) => p.isHost)?.name ?? 'the host'} can change these.
            </p>
          )}
        </div>
      </section>

      <Attribution state={state} />

      {isHost ? (
        <button
          type="button"
          disabled={!canStart}
          onClick={() => act({ type: 'startGame' })}
          className="rounded-xl bg-accent-500 px-6 py-4 text-lg font-black text-felt-950 transition hover:bg-accent-400 disabled:cursor-not-allowed disabled:bg-felt-800 disabled:text-felt-700"
        >
          Start the game
        </button>
      ) : (
        <p className="rounded-xl bg-felt-900 px-6 py-4 text-center text-felt-500 ring-1 ring-white/10">
          Waiting for the host to start…
        </p>
      )}
    </main>
  );
}
