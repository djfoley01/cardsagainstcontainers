/**
 * The payoff: who won the round, with identities finally attached.
 *
 * The winning submission is shown filled into the prompt, and every other
 * play is listed underneath with its author — which is usually where the
 * laughing happens.
 */
import type { ClientAction, PublicGameState } from '@cac/shared/protocol';
import { PromptCardView, ResponseCardView } from './Card.tsx';
import { useCountdown } from '../lib/useCountdown.ts';

export function RoundResult({
  state,
  act,
}: {
  state: PublicGameState;
  act: (action: ClientAction) => void;
}) {
  const result = state.lastResult;
  const nextIn = useCountdown(state.deadline);
  if (!result) return null;

  const nameOf = (playerId: string | null) =>
    state.players.find((p) => p.id === playerId)?.name ?? 'Someone who left';

  if (result.skipped) {
    return (
      <section className="flex flex-col items-center gap-4 rounded-2xl bg-felt-900 px-4 py-8 text-center ring-1 ring-white/10">
        <p className="text-lg font-bold text-felt-300">Nobody played that one.</p>
        <p className="text-sm text-felt-500">
          {result.auto ? 'The round timed out.' : 'The round was discarded.'}
        </p>
        <NextRound state={state} act={act} nextIn={nextIn} />
      </section>
    );
  }

  const others = result.submissions.filter((s) => s.playerId !== result.winnerId);

  return (
    <section className="flex flex-col gap-6">
      <div className="flex flex-col items-center gap-4 text-center">
        <p className="animate-rise text-sm font-bold tracking-widest text-felt-500 uppercase">
          {result.auto ? 'Picked automatically' : 'Winner'}
        </p>
        <h2 className="animate-rise text-3xl font-black text-accent-400">{result.winnerName}</h2>

        <div className="animate-winner w-full max-w-md">
          <PromptCardView
            card={result.prompt}
            fills={result.winningCards.map((c) => c.text)}
            className="ring-2 ring-accent-500"
          />
        </div>
      </div>

      {others.length > 0 && (
        <div className="flex flex-col gap-3">
          <h3 className="text-xs font-bold tracking-wider text-felt-500 uppercase">
            Also played
          </h3>
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {others.map((submission) => (
              <li key={submission.index} className="flex flex-col gap-2">
                <div className="flex flex-col gap-1.5">
                  {submission.cards.map((card, i) => (
                    <ResponseCardView key={`${submission.index}-${i}`} card={card} className="min-h-0 py-3" />
                  ))}
                </div>
                <p className="px-1 text-xs font-semibold text-felt-500">
                  {nameOf(submission.playerId)}
                </p>
              </li>
            ))}
          </ul>
        </div>
      )}

      <NextRound state={state} act={act} nextIn={nextIn} />
    </section>
  );
}

function NextRound({
  state,
  act,
  nextIn,
}: {
  state: PublicGameState;
  act: (action: ClientAction) => void;
  nextIn: number | null;
}) {
  if (state.paused) {
    return (
      <p className="text-center text-sm text-warn-400">
        Paused — the next round waits until someone resumes.
      </p>
    );
  }

  // A null deadline here means the game is parked waiting for players.
  if (state.deadline === null) {
    return (
      <p className="text-center text-sm text-warn-400">
        Waiting for enough players to carry on…
      </p>
    );
  }

  return (
    <div className="flex items-center justify-center gap-4">
      <p className="text-sm text-felt-500">
        Next round{nextIn !== null ? ` in ${nextIn}s` : ' shortly'}…
      </p>
      {state.you.isHost && (
        <button
          type="button"
          onClick={() => act({ type: 'nextRound' })}
          className="rounded-lg bg-felt-800 px-4 py-1.5 text-sm font-bold text-white ring-1 ring-white/10 transition hover:bg-felt-700"
        >
          Skip ahead
        </button>
      )}
    </div>
  );
}
