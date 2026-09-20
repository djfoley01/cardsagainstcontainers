/**
 * The player's stable identity, kept in localStorage.
 *
 * This is what makes a refresh, a laptop sleep or a dropped connection resume
 * the same seat with the same hand and score, rather than joining as a
 * stranger. It is not a credential — it identifies a seat in a party game, and
 * the server treats it as nothing more.
 */
/**
 * localStorage is shared across every window of a browser profile, and all
 * incognito windows share one partition too. Opening three windows therefore
 * yields one identity, and the server reads the second and third joins as the
 * first player reconnecting — so the room never reaches three players.
 *
 * `?seat=<label>` namespaces the stored keys so each window in one profile
 * keeps its own identity. It exists for local testing and costs nothing in
 * production, where real players are on their own machines.
 */
function seatSuffix(): string {
  const seat = new URLSearchParams(window.location.search).get('seat');
  return seat && /^[A-Za-z0-9_-]{1,12}$/.test(seat) ? `.${seat}` : '';
}

const ID_KEY = `cac.playerId${seatSuffix()}`;
const NAME_KEY = `cac.playerName${seatSuffix()}`;

/** Matches the server's accepted id format. */
function generateId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return `p-${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

/** localStorage throws in some privacy modes; never let that break the app. */
function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // A player in a locked-down browser simply gets a new seat on refresh.
  }
}

let cachedId: string | null = null;

export function playerId(): string {
  if (cachedId) return cachedId;
  const stored = read(ID_KEY);
  if (stored && /^[A-Za-z0-9_-]{8,64}$/.test(stored)) {
    cachedId = stored;
    return stored;
  }
  const fresh = generateId();
  write(ID_KEY, fresh);
  cachedId = fresh;
  return fresh;
}

export function rememberedName(): string {
  return read(NAME_KEY) ?? '';
}

export function rememberName(name: string): void {
  write(NAME_KEY, name);
}
