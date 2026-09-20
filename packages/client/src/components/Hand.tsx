/**
 * The player's hand and the submission flow.
 *
 * Selection order matters: a pick-2 prompt fills its blanks in the order the
 * cards were chosen, so chosen cards are numbered rather than just highlighted.
 */
import { useEffect, useState } from 'react';
import type { ClientAction, PublicGameState } from '@cac/shared/protocol';
import { ResponseCardView } from './Card.tsx';

export function Hand({
  state,
  act,
}: {
  state: PublicGameState;
  act: (action: ClientAction) => void;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const pick = state.prompt?.pick ?? 1;

  // A new round means a new prompt: drop any half-made choice.
  useEffect(() => {
    setSelected([]);
  }, [state.round, state.phase]);

  if (state.you.isCzar) {
    return (
      <p className="rounded-xl bg-felt-900 px-4 py-6 text-center text-sm text-felt-500 ring-1 ring-white/10">
        You're the Card Czar this round. Sit tight while everyone plays, then pick the winner.
      </p>
    );
  }

  if (state.you.hasSubmitted) {
    return (
      <div className="flex flex-col gap-3">
        <p className="text-center text-sm text-felt-500">
          Played. Waiting for {state.awaitingCount} more…
        </p>
        <div className="mx-auto flex max-w-xl flex-wrap justify-center gap-3">
          {state.you.submittedCards.map((card) => (
            <div key={card.id} className="w-44">
              <ResponseCardView card={card} selected />
            </div>
          ))}
        </div>
        <button
          type="button"
          onClick={() => act({ type: 'unsubmit' })}
          className="mx-auto text-xs font-semibold text-felt-500 underline transition hover:text-white"
        >
          Take it back
        </button>
      </div>
    );
  }

  function toggle(cardId: string): void {
    setSelected((current) => {
      if (current.includes(cardId)) return current.filter((id) => id !== cardId);
      if (current.length >= pick) {
        // At the limit, replace the oldest choice rather than ignoring the tap.
        return [...current.slice(1), cardId];
      }
      return [...current, cardId];
    });
  }

  const ready = selected.length === pick;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-4">
        <p className="text-sm text-felt-500">
          {pick > 1
            ? `Choose ${pick} cards, in order (${selected.length}/${pick})`
            : 'Choose your answer'}
        </p>
        <button
          type="button"
          disabled={!ready}
          onClick={() => act({ type: 'submit', cards: selected })}
          className="rounded-lg bg-accent-500 px-5 py-2 font-bold text-felt-950 transition hover:bg-accent-400 disabled:cursor-not-allowed disabled:bg-felt-800 disabled:text-felt-700"
        >
          Play {pick > 1 ? `${pick} cards` : 'card'}
        </button>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {state.you.hand.map((card) => {
          const position = selected.indexOf(card.id);
          return (
            <ResponseCardView
              key={card.id}
              card={card}
              selected={position !== -1}
              {...(pick > 1 && position !== -1 ? { order: position + 1 } : {})}
              onClick={() => toggle(card.id)}
              className="animate-card-in"
            />
          );
        })}
      </div>
    </div>
  );
}
