/**
 * Final standings.
 *
 * `winnerIds` can hold several players: the engine reports everyone tied at
 * the top rather than breaking the tie arbitrarily.
 */
import type { ClientAction, PublicGameState } from '@cac/shared/protocol';

export function GameOver({
  state,
  act,
  onLeave,
}: {
  state: PublicGameState;
  act: (action: ClientAction) => void;
  onLeave: () => void;
}) {
  const standings = [...state.players].sort((a, b) => b.score - a.score);
  const winners = state.players.filter((p) => state.winnerIds.includes(p.id));
  const connected = state.players.filter((p) => p.connected).length;

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-col gap-8 px-4 py-10">
      <header className="flex flex-col items-center gap-3 text-center">
        <p className="text-xs font-bold tracking-widest text-felt-500 uppercase">Game over</p>
        <h1 className="animate-winner text-4xl font-black text-accent-400">
          {winners.length === 0
            ? 'Nobody scored'
            : winners.length === 1
              ? `${winners[0]!.name} wins`
              : `${winners.map((w) => w.name).join(' & ')} tie`}
        </h1>
      </header>

      <ol className="flex flex-col gap-2">
        {standings.map((player, i) => (
          <li
            key={player.id}
            className={`flex items-center gap-3 rounded-xl px-4 py-3 ring-1 ${
              state.winnerIds.includes(player.id)
                ? 'bg-accent-500/10 ring-accent-500/40'
                : 'bg-felt-900 ring-white/10'
            }`}
          >
            <span className="w-6 font-mono text-sm text-felt-700">{i + 1}</span>
            <span className="flex-1 font-semibold text-white">
              {player.name}
              {player.id === state.you.id && <span className="ml-1 text-felt-500">(you)</span>}
            </span>
            <span className="font-mono text-lg font-bold tabular-nums text-felt-300">
              {player.score}
            </span>
          </li>
        ))}
      </ol>

      <div className="flex flex-col gap-3 sm:flex-row">
        {state.you.isHost ? (
          <button
            type="button"
            disabled={connected < 3}
            onClick={() => act({ type: 'startGame' })}
            className="flex-1 rounded-xl bg-accent-500 px-6 py-3.5 font-black text-felt-950 transition hover:bg-accent-400 disabled:cursor-not-allowed disabled:bg-felt-800 disabled:text-felt-700"
          >
            Play again
          </button>
        ) : (
          <p className="flex-1 rounded-xl bg-felt-900 px-6 py-3.5 text-center text-felt-500 ring-1 ring-white/10">
            Waiting for the host…
          </p>
        )}
        <button
          type="button"
          onClick={onLeave}
          className="rounded-xl bg-felt-900 px-6 py-3.5 font-bold text-felt-500 ring-1 ring-white/10 transition hover:text-white"
        >
          Leave
        </button>
      </div>
    </main>
  );
}
