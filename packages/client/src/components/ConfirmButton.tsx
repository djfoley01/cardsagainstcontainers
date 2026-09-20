/**
 * A two-step button for actions that can't be undone.
 *
 * Kicking someone and ending a game are both single clicks sitting next to
 * ordinary controls, and both are unrecoverable mid-game. This asks once
 * rather than opening a modal, and forgets after a few seconds so a stray
 * first click doesn't leave a primed button lying around.
 */
import { useEffect, useState, type ReactNode } from 'react';

const RESET_MS = 3500;

export function ConfirmButton({
  onConfirm,
  children,
  confirmLabel = 'Sure?',
  title,
  className = '',
  confirmClassName = '',
}: {
  onConfirm: () => void;
  children: ReactNode;
  confirmLabel?: ReactNode;
  title?: string;
  className?: string;
  confirmClassName?: string;
}) {
  const [armed, setArmed] = useState(false);

  useEffect(() => {
    if (!armed) return;
    const handle = setTimeout(() => setArmed(false), RESET_MS);
    return () => clearTimeout(handle);
  }, [armed]);

  return (
    <button
      type="button"
      {...(title ? { title } : {})}
      onClick={() => {
        if (armed) {
          onConfirm();
          setArmed(false);
        } else {
          setArmed(true);
        }
      }}
      className={armed ? confirmClassName || className : className}
    >
      {armed ? confirmLabel : children}
    </button>
  );
}
