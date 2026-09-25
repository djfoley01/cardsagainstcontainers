/**
 * Live activity and the running tally, shown on the landing page.
 *
 * Note what is deliberately absent: room codes. Anyone can load this page, and
 * printing a code here would let a passer-by drop into a colleague's game.
 * Activity is reported as counts; names appear only in the tally, where the
 * point is to credit people.
 */
import type { LobbyStats } from '@cac/shared/protocol';

/** "since 4:12pm" — the tally is in memory, so this is the server's boot. */
function sinceLabel(since: number): string {
  const started = new Date(since);
  const elapsedHours = (Date.now() - since) / 3_600_000;
  if (elapsedHours < 12) {
    return `since ${started.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
  }
  return `since ${started.toLocaleDateString([], { month: 'short', day: 'numeric' })}`;
}

function Activity({ stats }: { stats: LobbyStats }) {
  const { activeGames, openLobbies, playersOnline } = stats;
  const quiet = activeGames === 0 && openLobbies === 0;

  if (quiet) {
    return (
      <p className="text-sm text-felt-500">
        Nobody is playing right now. Start a room and send the code round.
      </p>
    );
  }

  const parts: string[] = [];
  if (activeGames > 0) parts.push(`${activeGames} game${activeGames === 1 ? '' : 's'} in progress`);
  if (openLobbies > 0) parts.push(`${openLobbies} waiting to start`);

  return (
    <p className="flex flex-wrap items-center gap-2 text-sm">
      <span className="relative flex size-2">
        <span className="absolute inline-flex size-full animate-ping rounded-full bg-accent-500 opacity-60" />
        <span className="relative inline-flex size-2 rounded-full bg-accent-500" />
      </span>
      <span className="font-semibold text-accent-400">{parts.join(' · ')}</span>
      <span className="text-felt-500">
        {playersOnline} player{playersOnline === 1 ? '' : 's'} online
      </span>
    </p>
  );
}

export function Leaderboard({ stats }: { stats: LobbyStats | null }) {
  if (!stats) return null;

  const { leaders } = stats;
  const mostRounds = Math.max(1, ...leaders.map((l) => l.roundsWon));

  return (
    <section className="flex flex-col gap-4 rounded-2xl bg-felt-900 p-5 ring-1 ring-white/10">
      <Activity stats={stats} />

      {leaders.length > 0 && (
        <>
          <div className="flex items-baseline justify-between gap-3 border-t border-white/5 pt-4">
            <h2 className="text-xs font-bold tracking-wider text-felt-500 uppercase">Leaderboard</h2>
            <span className="text-[0.7rem] text-felt-700">
              {stats.roundsPlayed} round{stats.roundsPlayed === 1 ? '' : 's'} {sinceLabel(stats.since)}
            </span>
          </div>

          <ol className="flex flex-col gap-1.5">
            {leaders.map((player, i) => (
              <li key={player.playerId} className="flex items-center gap-3 text-sm">
                <span className="w-4 shrink-0 font-mono text-xs text-felt-700">{i + 1}</span>
                <span className="min-w-0 flex-1 truncate font-semibold text-white">{player.name}</span>

                {/* A bar rather than only a number: the gap between the top
                    few is the interesting part, and it reads at a glance. */}
                <span className="hidden h-1.5 w-24 shrink-0 overflow-hidden rounded-full bg-felt-800 sm:block">
                  <span
                    className="block h-full rounded-full bg-accent-500/70"
                    style={{ width: `${Math.round((player.roundsWon / mostRounds) * 100)}%` }}
                  />
                </span>

                {player.gamesWon > 0 && (
                  <span
                    title={`${player.gamesWon} game${player.gamesWon === 1 ? '' : 's'} won`}
                    className="shrink-0 rounded bg-warn-400/15 px-1.5 py-0.5 text-[0.65rem] font-bold text-warn-400"
                  >
                    {player.gamesWon}★
                  </span>
                )}
                <span className="w-10 shrink-0 text-right font-mono font-bold tabular-nums text-felt-300">
                  {player.roundsWon}
                </span>
              </li>
            ))}
          </ol>

          <p className="text-[0.7rem] leading-relaxed text-felt-700">
            Rounds won, with games won marked ★. Counted since the server last
            started — nothing here is stored, so a restart wipes the slate.
          </p>
        </>
      )}
    </section>
  );
}
