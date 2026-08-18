import { useEffect, useState } from 'react';
import { Approvals } from './Approvals.tsx';
import { RequestDetailView } from './RequestDetail.tsx';
import { RequestForm } from './RequestForm.tsx';
import { RequestList } from './RequestList.tsx';
import { Can, useIdentity } from './identity.tsx';

/**
 * The console shell.
 *
 * Routing is done here rather than by a router library, because there are only
 * four views and one real requirement on them: REQ-032 AC-6, that the approval
 * notice's link resolve to the request detail after IAP has authenticated the
 * recipient. That link is a path, so the API serves index.html for it and
 * `parseRoute` reads it; in-app navigation then uses the hash.
 *
 * Navigation is role-gated for presentation only (AC-11). Every action behind
 * these tabs is authorized again server-side.
 */

type Route = { view: 'list' } | { view: 'new' } | { view: 'approvals' } | { view: 'request'; id: string };

function segmentRoute(segment: string): Route {
  const detail = /^requests\/(.+)$/.exec(segment);
  if (detail?.[1]) return { view: 'request', id: decodeURIComponent(detail[1]) };
  if (segment === 'new') return { view: 'new' };
  if (segment === 'approvals') return { view: 'approvals' };
  return { view: 'list' };
}

/**
 * Resolves a location — `pathname + hash` — to a view.
 *
 * Both forms are real. REQ-032's approval notice links to the PATH
 * `/requests/<id>`, because that is the URI IAP returns the approver to after it
 * authenticates them at the perimeter; the API serves index.html for it. In-app
 * navigation then uses the hash, so once the console is running the hash is
 * authoritative and a path left over from the original deep link must not
 * override it. Reading only the hash, as this once did, sent every notification
 * link to the request list instead of the request.
 */
export function parseRoute(location: string): Route {
  const hashAt = location.indexOf('#');
  const segment = hashAt === -1 ? location : location.slice(hashAt + 1);
  return segmentRoute(segment.replace(/^\/+/, ''));
}

const currentLocation = () => window.location.pathname + window.location.hash;

export function App() {
  const { identity, loading, error } = useIdentity();
  const [route, setRoute] = useState<Route>(() => parseRoute(currentLocation()));

  useEffect(() => {
    const onHash = () => setRoute(parseRoute(currentLocation()));
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const go = (hash: string) => {
    window.location.hash = hash;
    setRoute(parseRoute(hash));
  };
  const openRequest = (id: string) => go(`#/requests/${encodeURIComponent(id)}`);

  if (loading) return <p role="status">loading…</p>;

  // The console cannot usefully render without a verified identity, and it must
  // not guess one. IAP should have prevented this from ever being reached.
  if (error || !identity) {
    return <p role="alert">Could not establish your identity. {error ?? ''}</p>;
  }

  return (
    <main>
      <header>
        <h1>Lifecycle Console</h1>
        <p>
          Signed in as <strong>{identity.email}</strong>
          {identity.roles.length > 0 ? ` (${identity.roles.join(', ')})` : ' — no roles assigned'}
        </p>
        <nav aria-label="sections">
          <button type="button" onClick={() => go('#/')}>Requests</button>
          <Can role="requester">
            <button type="button" onClick={() => go('#/new')}>New request</button>
          </Can>
          <Can role="approver">
            <button type="button" onClick={() => go('#/approvals')}>Approvals</button>
          </Can>
        </nav>
      </header>

      {route.view === 'list' && <RequestList onOpen={openRequest} />}
      {route.view === 'new' && <RequestForm onSubmitted={openRequest} />}
      {route.view === 'approvals' && <Approvals onOpen={openRequest} />}
      {route.view === 'request' && <RequestDetailView requestId={route.id} />}
    </main>
  );
}
