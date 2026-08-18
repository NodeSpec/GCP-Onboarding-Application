import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { getIdentity, type Identity, type OperatorRole } from './api.js';

/**
 * The signed-in operator, read from the server (REQ-011 AC-8).
 *
 * The console never decodes a token, never reads a claim, and holds no auth
 * state of its own. It asks GET /api/me, which answers from the IAP assertion
 * the API verified. Anything else — parsing the IAP cookie here, trusting a
 * header, caching a role in localStorage — would put an authorization decision
 * on the client where the user can edit it.
 *
 * `roles` is used ONLY to decide what to render (AC-11). It is not enforcement:
 * every action is authorized again server-side against the verified identity
 * (REQ-012 AC-8), and the tests for that call the API directly, bypassing this
 * entirely.
 */

interface IdentityState {
  identity: Identity | null;
  loading: boolean;
  error: string | null;
}

const IdentityContext = createContext<IdentityState>({
  identity: null,
  loading: true,
  error: null,
});

export function IdentityProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<IdentityState>({
    identity: null,
    loading: true,
    error: null,
  });

  useEffect(() => {
    let live = true;
    getIdentity()
      .then((identity) => live && setState({ identity, loading: false, error: null }))
      .catch((err: unknown) =>
        live &&
        setState({
          identity: null,
          loading: false,
          error: err instanceof Error ? err.message : 'could not read identity',
        }),
      );
    return () => {
      live = false;
    };
  }, []);

  return <IdentityContext.Provider value={state}>{children}</IdentityContext.Provider>;
}

export const useIdentity = () => useContext(IdentityContext);

/** True when the signed-in operator holds the role. False while still loading. */
export function useHasRole(role: OperatorRole): boolean {
  const { identity } = useIdentity();
  return identity?.roles.includes(role) ?? false;
}

/**
 * Renders its children only for an operator holding the role (AC-11).
 *
 * Presentation only. A control hidden here is still refused server-side if
 * reached another way, which is the property that actually protects anything.
 */
export function Can({ role, children }: { role: OperatorRole; children: ReactNode }) {
  return useHasRole(role) ? <>{children}</> : null;
}
