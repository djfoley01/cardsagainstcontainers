/**
 * Past rounds, newest first. Mostly here so people can scroll back and
 * screenshot the good ones after the fact.
 */
import { useState } from 'react';
import type { PublicGameState } from '@cac/shared/protocol';
import { BLANK } from '@cac/shared/deck';

/** Render a finished round as one readable line. */
function asSentence(prompt: string, fills: string[]): string {
  if (!prompt.includes(BLANK)) return `${prompt} — ${fills.join(' / ')}`;
  let i = 0;
  return prompt.replace(new RegExp(BLANK, 'g'), () => fills[i++] ?? '…');
}

export function History({ state }: { state: PublicGameState }) {
  const [open, setOpen] = useState(false);
  const rounds = state.history.filter((r) => !r.skipped);
  if (rounds.length === 0) return null;

  return (
    <section className="rounded-2xl bg-felt-900 ring-1 ring-white/10">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-2 px-4 py-3 text-left"
      >
        <span className="text-xs font-bold tracking-wider text-felt-500 uppercase">
          Previous rounds ({rounds.length})
        </span>
        <span className="text-felt-700" aria-hidden>
          {open ? '−' : '+'}
        </span>
      </button>

      {open && (
        <ul className="flex flex-col gap-3 border-t border-white/5 px-4 py-3">
          {rounds.map((round, i) => (
            <li key={`${round.prompt.id}-${i}`} className="text-sm leading-snug">
              <p className="text-felt-300">
                {asSentence(
                  round.prompt.text,
                  round.winningCards.map((c) => c.text),
                )}
              </p>
              <p className="mt-0.5 text-xs font-semibold text-accent-400">{round.winnerName}</p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
