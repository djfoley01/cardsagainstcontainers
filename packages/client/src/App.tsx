import { useEffect, useState } from 'react';
import { useGame } from './lib/useGame.ts';
import { JoinScreen } from './components/JoinScreen.tsx';
import { Lobby } from './components/Lobby.tsx';
import { GameTable } from './components/GameTable.tsx';
import { GameOver } from './components/GameOver.tsx';
import { DeckBuilder } from './components/DeckBuilder.tsx';

/** A dropped connection is the common failure here, so say so plainly. */
function ConnectionBanner({ connection }: { connection: 'connecting' | 'online' | 'offline' }) {
  if (connection === 'online') return null;
  return (
    <div
      role="status"
      className="sticky top-0 z-20 bg-warn-400/15 px-4 py-2 text-center text-sm font-semibold text-warn-400 backdrop-blur"
    >
      {connection === 'connecting'
        ? 'Reconnecting…'
        : 'Connection lost. Your seat is held — we’ll put you back in.'}
    </div>
  );
}

/** Errors from rejected actions surface briefly, then clear themselves. */
function ErrorToast({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  useEffect(() => {
    const handle = setTimeout(onDismiss, 4000);
    return () => clearTimeout(handle);
  }, [message, onDismiss]);

  return (
    <div
      role="alert"
      className="fixed inset-x-0 bottom-4 z-30 mx-auto w-fit max-w-[90vw] rounded-full bg-danger-400 px-5 py-2.5 text-sm font-semibold text-felt-950 shadow-xl"
    >
      {message}
    </div>
  );
}

/** The deck builder lives at /decks. Room codes are four letters, so there is
 *  no chance of a room called "decks" colliding with it. */
function isDeckBuilderPath(): boolean {
  return window.location.pathname.replace(/\/+$/, '').toLowerCase() === '/decks';
}

export default function App() {
  const game = useGame();
  const { state } = game;
  const [showBuilder, setShowBuilder] = useState(isDeckBuilderPath);

  // Keep the back/forward buttons working for the builder.
  useEffect(() => {
    const onPop = () => setShowBuilder(isDeckBuilderPath());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  function openBuilder() {
    window.history.pushState(null, '', '/decks');
    setShowBuilder(true);
  }

  function closeBuilder() {
    window.history.pushState(null, '', '/');
    setShowBuilder(false);
  }

  // Keep the address bar on the room, so a refresh or a shared link lands in
  // the right place. The query string is preserved because ?seat= (the local
  // multi-window testing override) lives there and must survive this rewrite.
  useEffect(() => {
    if (showBuilder) return;
    const path = state ? `/${state.roomCode}` : '/';
    if (window.location.pathname !== path) {
      window.history.replaceState(null, '', `${path}${window.location.search}`);
    }
  }, [state?.roomCode, state, showBuilder]);

  return (
    <>
      <ConnectionBanner connection={game.connection} />

      {showBuilder ? (
        <DeckBuilder onBack={closeBuilder} />
      ) : !state ? (
        <JoinScreen
          connection={game.connection}
          onCreate={game.create}
          onJoin={game.join}
          onOpenBuilder={openBuilder}
        />
      ) : state.phase === 'lobby' ? (
        <Lobby state={state} act={game.act} />
      ) : state.phase === 'gameOver' ? (
        <GameOver state={state} act={game.act} onLeave={game.leave} />
      ) : (
        <GameTable state={state} act={game.act} onLeave={game.leave} />
      )}

      {game.error && <ErrorToast message={game.error} onDismiss={game.clearError} />}
    </>
  );
}
