/**
 * The table during play. Routes the current phase to its screen and keeps the
 * scoreboard and timer visible throughout.
 */
import { MIN_PLAYERS } from '@cac/shared/game';
import type { ClientAction, PublicGameState } from '@cac/shared/protocol';
import { HostControls } from './HostControls.tsx';
import { useCountdown } from '../lib/useCountdown.ts';
import { PromptCardView } from './Card.tsx';
import { Hand } from './Hand.tsx';
import { History } from './History.tsx';
import { Judging } from './Judging.tsx';
import { PlayerList } from './PlayerList.tsx';
import { RoundResult } from './RoundResult.tsx';

function Timer({
  deadline,
  phase,
  paused,
}: {
  deadline: number | null;
  phase: string;
  paused: boolean;
}) {
  const seconds = useCountdown(deadline);
  if (paused) {
    return (
      <span className="font-mono text-2xl font-bold text-warn-400" aria-label="Timer paused">
        ⏸
      </span>
    );
  }
  // The result countdown has its own display; showing it twice reads as a
  // second, unrelated deadline.
  if (seconds === null || phase === 'roundResult') return null;
  const urgent = seconds <= 10;
  return (
    <span
      className={`font-mono text-2xl font-bold tabular-nums ${urgent ? 'text-danger-400' : 'text-felt-500'}`}
      aria-label={`${seconds} seconds remaining`}
    >
      {seconds}s
    </span>
  );
}

/** Anyone can hold the clock — someone will want to react to a card. */
function PauseButton({
  state,
  act,
}: {
  state: PublicGameState;
  act: (action: ClientAction) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => act({ type: state.paused ? 'resume' : 'pause' })}
      className={`rounded-lg px-3 py-1.5 text-xs font-bold ring-1 transition ${
        state.paused
          ? 'bg-warn-400 text-felt-950 ring-transparent hover:bg-warn-400/90'
          : 'bg-felt-900 text-felt-500 ring-white/10 hover:text-white'
      }`}
    >
      {state.paused ? 'Resume' : 'Pause'}
    </button>
  );
}

export function GameTable({
  state,
  act,
  onLeave,
}: {
  state: PublicGameState;
  act: (action: ClientAction) => void;
  onLeave: () => void;
}) {
  const czar = state.players.find((p) => p.isCzar);
  const connectedCount = state.players.filter((p) => p.connected).length;
  // The engine parks the game below the minimum; say so rather than leaving a
  // silent screen with no countdown and no explanation.
  const waitingForPlayers = connectedCount < MIN_PLAYERS;
  // The prompt is already shown filled in on the judging and result screens.
  const showPrompt = state.phase === 'submitting' && state.prompt;

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-5 px-4 py-6">
      {waitingForPlayers && (
        <div
          role="status"
          className="rounded-xl bg-warn-400/15 px-4 py-3 text-center text-sm font-semibold text-warn-400 ring-1 ring-warn-400/30"
        >
          Only {connectedCount} {connectedCount === 1 ? 'player is' : 'players are'} here. The game
          is held until {MIN_PLAYERS} are back — nobody loses their seat or score.
        </div>
      )}
      {state.paused && (
        <div
          role="status"
          className="flex flex-wrap items-center justify-center gap-3 rounded-xl bg-warn-400/15 px-4 py-3 text-center text-sm font-semibold text-warn-400 ring-1 ring-warn-400/30"
        >
          <span>
            Paused{state.pausedBy ? ` by ${state.pausedBy}` : ''} — the clock is held.
          </span>
          <button
            type="button"
            onClick={() => act({ type: 'resume' })}
            className="rounded-lg bg-warn-400 px-3 py-1 text-xs font-bold text-felt-950 transition hover:bg-warn-400/90"
          >
            Resume
          </button>
        </div>
      )}
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-baseline gap-3">
          <h1 className="text-lg font-black text-white">
            Round <span className="font-mono">{state.round}</span>
          </h1>
          <span className="font-mono text-sm tracking-widest text-felt-700">{state.roomCode}</span>
        </div>
        <div className="flex items-center gap-3">
          <Timer deadline={state.deadline} phase={state.phase} paused={state.paused} />
          <PauseButton state={state} act={act} />
          <button
            type="button"
            onClick={onLeave}
            className="text-xs font-semibold text-felt-700 transition hover:text-danger-400"
          >
            Leave
          </button>
        </div>
      </header>

      <div className="grid gap-5 md:grid-cols-[minmax(0,1fr)_240px]">
        <section className="flex flex-col gap-5">
          {showPrompt && (
            <>
              <div className="max-w-md">
                <PromptCardView card={state.prompt!} />
              </div>
              <p className="text-sm text-felt-500">
                {state.you.isCzar ? (
                  <>You are the Card Czar.</>
                ) : (
                  <>
                    <span className="font-semibold text-warn-400">{czar?.name ?? 'Someone'}</span>{' '}
                    is judging this round.
                  </>
                )}
              </p>
              <Hand state={state} act={act} />
            </>
          )}

          {state.phase === 'judging' && <Judging state={state} act={act} />}
          {state.phase === 'roundResult' && <RoundResult state={state} act={act} />}
        </section>

        <aside className="flex flex-col gap-3 md:sticky md:top-6 md:self-start">
          <div className="flex flex-col gap-3 rounded-2xl bg-felt-900 p-3 ring-1 ring-white/10">
            <h2 className="text-xs font-bold tracking-wider text-felt-500 uppercase">Scoreboard</h2>
            <PlayerList state={state} onKick={(id) => act({ type: 'kick', targetId: id })} />
            <p className="text-[0.7rem] text-felt-700">
              {state.responsesRemaining} cards left ·{' '}
              {state.settings.pointsToWin ? `playing to ${state.settings.pointsToWin}` : 'no limit'}
            </p>
          </div>
          <HostControls state={state} act={act} />
          <History state={state} />
        </aside>
      </div>
    </main>
  );
}
