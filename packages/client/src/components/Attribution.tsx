/**
 * Licence credit for the decks in play.
 *
 * Every deck here is Creative Commons with an attribution clause, so this
 * isn't decoration — it's the condition under which we're allowed to use the
 * cards at all. It lists the decks actually enabled, and links each source.
 */
import type { PublicGameState } from '@cac/shared/protocol';

export function Attribution({ state, className = '' }: { state: PublicGameState; className?: string }) {
  const inPlay = state.availableDecks.filter((d) => state.settings.deckIds.includes(d.id));
  if (inPlay.length === 0) return null;

  return (
    <p className={`text-center text-[0.7rem] leading-relaxed text-felt-700 ${className}`}>
      Card content from{' '}
      {inPlay.map((deck, i) => (
        <span key={deck.id}>
          {i > 0 && (i === inPlay.length - 1 ? ' and ' : ', ')}
          <a
            href={deck.source}
            target="_blank"
            rel="noreferrer"
            className="underline hover:text-felt-500"
          >
            {deck.name}
          </a>
          {' ('}
          <a
            href={deck.licenseUrl}
            target="_blank"
            rel="noreferrer"
            className="underline hover:text-felt-500"
          >
            {deck.license}
          </a>
          {')'}
        </span>
      ))}
      . Used non-commercially, with thanks.
    </p>
  );
}
