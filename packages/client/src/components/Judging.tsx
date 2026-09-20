/**
 * The judging table.
 *
 * Everyone sees the submitted cards — that's the best part of the game — but
 * only the czar can pick, and nobody sees who played what. Anonymity is
 * enforced server side: these cards arrive with `playerId: null`.
 */
import type { ClientAction, PublicGameState } from '@cac/shared/protocol';
import { PromptCardView, ResponseCardView } from './Card.tsx';

/** Staggered so the czar has a natural rhythm for reading them aloud. */
const REVEAL_STEP_MS = 260;

export function Judging({
  state,
  act,
}: {
  state: PublicGameState;
  act: (action: ClientAction) => void;
}) {
  const czar = state.players.find((p) => p.isCzar);
  const isCzar = state.you.isCzar;
  const pick = state.prompt?.pick ?? 1;

  return (
    <section className="flex flex-col gap-5">
      <p className="text-sm font-semibold text-felt-300">
        {isCzar ? (
          <>Read them out, then pick your favourite.</>
        ) : (
          <>
            <span className="text-warn-400">{czar?.name ?? 'The czar'}</span> is choosing…
          </>
        )}
      </p>

      <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {state.submissions.map((submission) => {
          const fills = submission.cards.map((c) => c.text);
          return (
            <li
              key={submission.index}
              className="animate-reveal"
              style={{ animationDelay: `${submission.index * REVEAL_STEP_MS}ms` }}
            >
              <button
                type="button"
                disabled={!isCzar}
                onClick={() => act({ type: 'selectWinner', index: submission.index })}
                aria-label={`Choose submission ${submission.index + 1}`}
                className={`flex w-full flex-col gap-3 rounded-2xl p-1 text-left transition ${
                  isCzar
                    ? 'cursor-pointer ring-2 ring-transparent hover:-translate-y-1 hover:ring-accent-500 focus-visible:ring-accent-400'
                    : 'cursor-default'
                }`}
              >
                {/* Showing the prompt filled in makes the joke land without
                    the czar having to hold the wording in their head. */}
                {state.prompt && state.prompt.blanks > 0 ? (
                  <PromptCardView card={state.prompt} fills={fills} />
                ) : (
                  <div className="flex flex-col gap-2">
                    {submission.cards.map((card, i) => (
                      <ResponseCardView key={`${submission.index}-${i}`} card={card} />
                    ))}
                  </div>
                )}
              </button>
            </li>
          );
        })}
      </ul>

      {isCzar && pick > 1 && (
        <p className="text-xs text-felt-700">Cards are shown in the order they were played.</p>
      )}
    </section>
  );
}
