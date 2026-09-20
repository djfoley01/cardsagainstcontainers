/**
 * Host-only escape hatches, tucked away so they aren't clicked by accident.
 *
 * The important one is "Move it along": with timers off, a quiet player or an
 * idle czar will otherwise stall the round indefinitely, and the only other
 * way out would be ending the game.
 */
import { useState } from 'react';
import type { ClientAction, PublicGameState } from '@cac/shared/protocol';
import { ConfirmButton } from './ConfirmButton.tsx';

export function HostControls({
  state,
  act,
}: {
  state: PublicGameState;
  act: (action: ClientAction) => void;
}) {
  const [open, setOpen] = useState(false);
  if (!state.you.isHost) return null;

  const stalled = state.phase === 'submitting' || state.phase === 'judging';
  const others = state.players.filter((p) => p.id !== state.you.id && p.connected);

  return (
    <section className="rounded-2xl bg-felt-900 ring-1 ring-white/10">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-2 px-4 py-3 text-left"
      >
        <span className="text-xs font-bold tracking-wider text-felt-500 uppercase">Host controls</span>
        <span className="text-felt-700" aria-hidden>
          {open ? '−' : '+'}
        </span>
      </button>

      {open && (
        <div className="flex flex-col gap-3 border-t border-white/5 px-4 py-3">
          <button
            type="button"
            disabled={!stalled}
            onClick={() => act({ type: 'forceAdvance' })}
            className="rounded-lg bg-felt-800 px-3 py-2 text-sm font-bold text-white ring-1 ring-white/10 transition hover:bg-felt-700 disabled:cursor-not-allowed disabled:text-felt-700"
          >
            Move it along
          </button>
          <p className="-mt-1 text-[0.7rem] leading-snug text-felt-700">
            {state.phase === 'judging'
              ? 'Picks a winner at random and ends the round.'
              : 'Closes submissions and goes straight to judging.'}
          </p>

          <label className="flex items-center justify-between gap-2 text-sm">
            <span className="font-semibold text-felt-300">Play to</span>
            <select
              value={state.settings.pointsToWin ?? 'endless'}
              onChange={(e) =>
                act({
                  type: 'updateSettings',
                  settings: { pointsToWin: e.target.value === 'endless' ? null : Number(e.target.value) },
                })
              }
              className="rounded-lg bg-felt-800 px-2 py-1 text-white"
            >
              {[3, 5, 7, 10, 15].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
              <option value="endless">No limit</option>
            </select>
          </label>

          <label className="flex items-center justify-between gap-2 text-sm">
            <span className="font-semibold text-felt-300">Play timer</span>
            <select
              value={state.settings.submitTimerMs ?? 'off'}
              onChange={(e) =>
                act({
                  type: 'updateSettings',
                  settings: { submitTimerMs: e.target.value === 'off' ? null : Number(e.target.value) },
                })
              }
              className="rounded-lg bg-felt-800 px-2 py-1 text-white"
            >
              {[60_000, 90_000, 120_000, 180_000].map((ms) => (
                <option key={ms} value={ms}>
                  {ms / 1000}s
                </option>
              ))}
              <option value="off">Off</option>
            </select>
          </label>

          <label className="flex items-center justify-between gap-2 text-sm">
            <span className="font-semibold text-felt-300">Judge timer</span>
            <select
              value={state.settings.judgeTimerMs ?? 'off'}
              onChange={(e) =>
                act({
                  type: 'updateSettings',
                  settings: { judgeTimerMs: e.target.value === 'off' ? null : Number(e.target.value) },
                })
              }
              className="rounded-lg bg-felt-800 px-2 py-1 text-white"
            >
              {[30_000, 60_000, 90_000].map((ms) => (
                <option key={ms} value={ms}>
                  {ms / 1000}s
                </option>
              ))}
              <option value="off">Off</option>
            </select>
          </label>

          {others.length > 0 && (
            <label className="flex items-center justify-between gap-2 text-sm">
              <span className="font-semibold text-felt-300">Hand over host</span>
              <select
                value=""
                onChange={(e) => e.target.value && act({ type: 'transferHost', targetId: e.target.value })}
                className="max-w-28 rounded-lg bg-felt-800 px-2 py-1 text-white"
              >
                <option value="">Choose…</option>
                {others.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
          )}

          <ConfirmButton
            onConfirm={() => act({ type: 'endGame' })}
            confirmLabel="Tap again to end"
            className="rounded-lg bg-felt-800 px-3 py-2 text-sm font-bold text-felt-500 ring-1 ring-white/10 transition hover:text-danger-400"
            confirmClassName="rounded-lg bg-danger-400 px-3 py-2 text-sm font-bold text-felt-950"
          >
            End game now
          </ConfirmButton>
        </div>
      )}
    </section>
  );
}
