/**
 * The two card faces. Prompt cards are black, response cards white, matching
 * the physical deck.
 */
import type { ReactNode } from 'react';
import type { PromptCard, ResponseCard } from '@cac/shared/deck';
import { BLANK } from '@cac/shared/deck';

/**
 * Render blanks as a drawn underline rather than a run of underscores, and
 * substitute chosen cards into them when there are any.
 */
function renderPrompt(text: string, fills: string[] = []): ReactNode[] {
  const parts = text.split(BLANK);
  const out: ReactNode[] = [];
  parts.forEach((part, i) => {
    out.push(<span key={`t${i}`}>{part}</span>);
    if (i < parts.length - 1) {
      const fill = fills[i];
      out.push(
        fill ? (
          <span key={`b${i}`} className="font-semibold text-accent-400 underline decoration-accent-600/60 underline-offset-4">
            {fill.replace(/\.$/, '')}
          </span>
        ) : (
          <span key={`b${i}`} className="inline-block w-28 translate-y-[2px] border-b-2 border-current align-baseline" />
        ),
      );
    }
  });
  return out;
}

export function PromptCardView({
  card,
  fills,
  className = '',
}: {
  card: PromptCard;
  fills?: string[];
  className?: string;
}) {
  return (
    <article
      className={`flex min-h-44 w-full flex-col justify-between rounded-2xl bg-felt-950 p-5 text-left shadow-xl ring-1 ring-white/10 ${className}`}
    >
      <p className="text-lg leading-snug font-semibold text-white">{renderPrompt(card.text, fills)}</p>
      {card.pick > 1 && (
        <p className="mt-4 self-end rounded-full bg-white/10 px-3 py-1 text-xs font-bold tracking-wide text-white uppercase">
          Pick {card.pick}
        </p>
      )}
    </article>
  );
}

export function ResponseCardView({
  card,
  selected = false,
  order,
  disabled = false,
  onClick,
  className = '',
}: {
  card: ResponseCard;
  selected?: boolean;
  /** Position when several cards are chosen for a pick-2 prompt. */
  order?: number;
  disabled?: boolean;
  onClick?: () => void;
  className?: string;
}) {
  const interactive = Boolean(onClick) && !disabled;
  const Tag = interactive ? 'button' : 'div';

  return (
    <Tag
      {...(interactive ? { type: 'button' as const, onClick } : {})}
      {...(disabled ? { 'aria-disabled': true } : {})}
      {...(selected ? { 'aria-pressed': true } : {})}
      className={`relative flex min-h-36 w-full flex-col justify-between rounded-2xl bg-white p-4 text-left text-felt-950 shadow-lg transition
        ${interactive ? 'cursor-pointer hover:-translate-y-1 hover:shadow-2xl focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-400' : ''}
        ${selected ? 'ring-4 ring-accent-500 -translate-y-1' : 'ring-1 ring-black/10'}
        ${disabled && !selected ? 'opacity-40' : ''}
        ${className}`}
    >
      <p className="text-[0.95rem] leading-snug font-semibold">{card.text}</p>
      {order !== undefined && (
        <span className="absolute -top-2 -right-2 flex size-7 items-center justify-center rounded-full bg-accent-500 text-sm font-bold text-felt-950 shadow">
          {order}
        </span>
      )}
    </Tag>
  );
}
