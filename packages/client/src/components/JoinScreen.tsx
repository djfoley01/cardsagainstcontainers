/**
 * The entry point: pick a name, then start a room or join one.
 *
 * A room code in the URL (/ABCD or ?room=ABCD) prefills the field, so the host
 * can paste one link into the team channel.
 */
import { useEffect, useState, type FormEvent } from 'react';
import { ROOM_CODE_LENGTH } from '@cac/shared/protocol';
import type { JoinAck } from '@cac/shared/protocol';
import { rememberedName } from '../lib/identity.ts';
import type { ConnectionState } from '../lib/useGame.ts';

/** Read a room code from the path or query string, if the link carried one. */
export function codeFromUrl(): string {
  const fromQuery = new URLSearchParams(window.location.search).get('room');
  const fromPath = window.location.pathname.replace(/^\/+|\/+$/g, '');
  const candidate = (fromQuery ?? fromPath).toUpperCase();
  return /^[A-Z]{4}$/.test(candidate) ? candidate : '';
}

export function JoinScreen({
  connection,
  onCreate,
  onJoin,
  onOpenBuilder,
}: {
  connection: ConnectionState;
  onCreate: (name: string) => Promise<JoinAck>;
  onJoin: (code: string, name: string) => Promise<JoinAck>;
  onOpenBuilder: () => void;
}) {
  const [name, setName] = useState(rememberedName);
  const [code, setCode] = useState(codeFromUrl);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Focus the field the player still needs to fill in.
  useEffect(() => {
    const target = name ? 'code' : 'name';
    document.getElementById(target)?.focus();
  }, []);

  const trimmedName = name.trim();
  const canSubmit = trimmedName.length > 0 && connection === 'online' && !busy;

  async function run(action: () => Promise<JoinAck>) {
    setBusy(true);
    setError(null);
    const ack = await action();
    setBusy(false);
    if (!ack.ok) setError(ack.message);
  }

  function handleJoin(event: FormEvent) {
    event.preventDefault();
    if (!canSubmit) return;
    if (code.trim().length !== ROOM_CODE_LENGTH) {
      setError('Room codes are four letters.');
      return;
    }
    void run(() => onJoin(code, trimmedName));
  }

  return (
    <main className="mx-auto flex min-h-full w-full max-w-md flex-col justify-center gap-8 px-4 py-12">
      <header className="text-center">
        <h1 className="text-3xl font-black tracking-tight text-white">
          Cards Against <span className="text-accent-400">Containers</span>
        </h1>
        <p className="mt-2 text-sm text-felt-500">For teams that deploy on Fridays.</p>
      </header>

      <form onSubmit={handleJoin} className="flex flex-col gap-5 rounded-2xl bg-felt-900 p-6 ring-1 ring-white/10">
        <div className="flex flex-col gap-2">
          <label htmlFor="name" className="text-xs font-bold tracking-wider text-felt-500 uppercase">
            Your name
          </label>
          <input
            id="name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={24}
            autoComplete="nickname"
            placeholder="How you show up on the scoreboard"
            className="rounded-lg bg-felt-800 px-3 py-2.5 text-white placeholder:text-felt-700 focus:ring-2 focus:ring-accent-500 focus:outline-none"
          />
        </div>

        <div className="flex flex-col gap-2">
          <label htmlFor="code" className="text-xs font-bold tracking-wider text-felt-500 uppercase">
            Room code
          </label>
          <div className="flex gap-2">
            <input
              id="code"
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4))}
              placeholder="ABCD"
              inputMode="text"
              autoCapitalize="characters"
              spellCheck={false}
              className="w-32 rounded-lg bg-felt-800 px-3 py-2.5 font-mono text-xl tracking-[0.3em] text-white uppercase placeholder:tracking-normal placeholder:text-felt-700 focus:ring-2 focus:ring-accent-500 focus:outline-none"
            />
            <button
              type="submit"
              disabled={!canSubmit || code.length !== ROOM_CODE_LENGTH}
              className="flex-1 rounded-lg bg-accent-500 px-4 py-2.5 font-bold text-felt-950 transition hover:bg-accent-400 disabled:cursor-not-allowed disabled:bg-felt-800 disabled:text-felt-700"
            >
              Join
            </button>
          </div>
        </div>

        <div className="flex items-center gap-3 text-xs text-felt-700">
          <span className="h-px flex-1 bg-white/10" />
          or
          <span className="h-px flex-1 bg-white/10" />
        </div>

        <button
          type="button"
          disabled={!canSubmit}
          onClick={() => void run(() => onCreate(trimmedName))}
          className="rounded-lg bg-felt-800 px-4 py-2.5 font-bold text-white ring-1 ring-white/10 transition hover:bg-felt-700 disabled:cursor-not-allowed disabled:text-felt-700"
        >
          Start a new room
        </button>

        {connection !== 'online' && (
          <p className="text-center text-sm text-warn-400">
            {connection === 'connecting' ? 'Connecting…' : 'Connection lost. Retrying…'}
          </p>
        )}
        {error && (
          <p role="alert" className="text-center text-sm text-danger-400">
            {error}
          </p>
        )}
      </form>

      <button
        type="button"
        onClick={onOpenBuilder}
        className="mx-auto text-sm font-semibold text-felt-500 underline underline-offset-4 transition hover:text-accent-400"
      >
        Make your own deck
      </button>

      <p className="text-center text-xs leading-relaxed text-felt-700">
        Card content from{' '}
        <a
          href="https://github.com/cardsagainstcontainers/deck"
          className="underline hover:text-felt-500"
          target="_blank"
          rel="noreferrer"
        >
          cardsagainstcontainers/deck
        </a>
        , © Sysdig and contributors, CC BY-NC-SA 2.0.
      </p>
    </main>
  );
}
