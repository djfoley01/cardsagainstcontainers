import type { PublicGameState } from '@cac/shared/protocol';
import { ConfirmButton } from './ConfirmButton.tsx';

/**
 * The scoreboard. Doubles as presence: who is offline, who is judging, and
 * during submitting, who everyone is waiting on.
 */
export function PlayerList({
  state,
  onKick,
}: {
  state: PublicGameState;
  onKick?: (playerId: string) => void;
}) {
  const leader = Math.max(0, ...state.players.map((p) => p.score));

  return (
    <ul className="flex flex-col gap-1">
      {state.players.map((player) => {
        const waiting = state.phase === 'submitting' && !player.isCzar && !player.hasSubmitted && player.connected;
        return (
          <li
            key={player.id}
            className={`flex items-center gap-2 rounded-lg px-2.5 py-2 text-sm transition ${
              player.connected ? 'bg-white/5' : 'bg-transparent opacity-45'
            }`}
          >
            <span
              className={`size-2 shrink-0 rounded-full ${player.connected ? 'bg-accent-500' : 'bg-felt-700'}`}
              title={player.connected ? 'Online' : 'Offline'}
            />
            <span className="min-w-0 flex-1 truncate font-medium text-white">
              {player.name}
              {player.id === state.you.id && <span className="ml-1 text-felt-500">(you)</span>}
            </span>

            {player.isCzar && (
              <span className="rounded bg-warn-400/15 px-1.5 py-0.5 text-[0.65rem] font-bold tracking-wide text-warn-400 uppercase">
                Czar
              </span>
            )}
            {player.isHost && (
              <span className="rounded bg-white/10 px-1.5 py-0.5 text-[0.65rem] font-bold tracking-wide text-felt-300 uppercase">
                Host
              </span>
            )}
            {player.hasSubmitted && state.phase === 'submitting' && (
              <span title="Has played" className="text-accent-400">
                ✓
              </span>
            )}
            {waiting && (
              <span title="Still choosing" className="text-felt-700">
                …
              </span>
            )}

            <span
              className={`w-6 text-right font-mono font-bold tabular-nums ${
                player.score === leader && leader > 0 ? 'text-accent-400' : 'text-felt-500'
              }`}
            >
              {player.score}
            </span>

            {onKick && state.you.isHost && player.id !== state.you.id && (
              <ConfirmButton
                onConfirm={() => onKick(player.id)}
                title={`Remove ${player.name}`}
                confirmLabel="Remove?"
                className="text-felt-700 transition hover:text-danger-400"
                confirmClassName="rounded bg-danger-400 px-1.5 py-0.5 text-[0.65rem] font-bold text-felt-950"
              >
                ×
              </ConfirmButton>
            )}
          </li>
        );
      })}
    </ul>
  );
}
