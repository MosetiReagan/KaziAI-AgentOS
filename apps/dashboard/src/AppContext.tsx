import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { ApiClient } from './api/client.js';

const TOKEN_KEY = 'kazi.token';
const BASE_KEY = 'kazi.apiBaseUrl';

export interface AppState {
  client: ApiClient;
  baseUrl: string;
  token: string | null;
  setBaseUrl(value: string): void;
  setToken(value: string | null): void;
}

const AppContext = createContext<AppState | undefined>(undefined);

function readStorage(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string | null): void {
  try {
    if (value === null) globalThis.localStorage?.removeItem(key);
    else globalThis.localStorage?.setItem(key, value);
  } catch {
    // A dashboard that cannot persist a preference still works.
  }
}

/**
 * One client for the whole console. The token is held here and sent as a
 * header; nothing is trusted from the URL, and the run's truth always comes
 * back from the API (spec §103).
 */
export function AppProvider({
  children,
  client: injected,
}: {
  children: ReactNode;
  /** Inject a client — the tests use this to drive the console against a stub. */
  client?: ApiClient;
}) {
  const [baseUrl, setBaseUrlState] = useState(() => readStorage(BASE_KEY) ?? '');
  const [token, setTokenState] = useState<string | null>(() => readStorage(TOKEN_KEY));

  const built = useMemo(() => new ApiClient({ baseUrl, token }), [baseUrl, token]);
  const client = injected ?? built;

  const setBaseUrl = useCallback((value: string) => {
    const trimmed = value.trim().replace(/\/$/, '');
    setBaseUrlState(trimmed);
    writeStorage(BASE_KEY, trimmed === '' ? null : trimmed);
  }, []);

  const setToken = useCallback((value: string | null) => {
    const trimmed = value?.trim() ?? null;
    setTokenState(trimmed === '' ? null : trimmed);
    writeStorage(TOKEN_KEY, trimmed === '' ? null : trimmed);
  }, []);

  const value = useMemo(
    () => ({ client, baseUrl, token, setBaseUrl, setToken }),
    [client, baseUrl, token, setBaseUrl, setToken],
  );
  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp(): AppState {
  const value = useContext(AppContext);
  if (!value) throw new Error('useApp must be used inside AppProvider');
  return value;
}
