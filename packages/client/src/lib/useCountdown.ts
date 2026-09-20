/**
 * Seconds remaining until a server-supplied deadline.
 *
 * The deadline is an absolute server timestamp, so this only ticks a display —
 * it never decides anything. When it reaches zero the client simply waits for
 * the server's next state frame, which keeps a slow clock or a lagging tab
 * from disagreeing with the game.
 */
import { useEffect, useState } from 'react';

export function useCountdown(deadline: number | null): number | null {
  const [remaining, setRemaining] = useState<number | null>(null);

  useEffect(() => {
    if (deadline === null) {
      setRemaining(null);
      return;
    }
    const tick = () => setRemaining(Math.max(0, Math.ceil((deadline - Date.now()) / 1000)));
    tick();
    const handle = setInterval(tick, 250);
    return () => clearInterval(handle);
  }, [deadline]);

  return remaining;
}
