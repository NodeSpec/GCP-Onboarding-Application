import { useEffect, useState } from 'react';
import { AdminView } from './Admin.tsx';
import { Approvals } from './Approvals.tsx';
import { RequestDetailView } from './RequestDetail.tsx';
import { RequestForm } from './RequestForm.tsx';
import { RequestList } from './RequestList.tsx';
import { Can, useIdentity } from './identity.tsx';

/**
 * The console shell: a left sidebar on desktop that becomes a drawer behind a
 * top bar on small screens, with the theme toggle and the signed-in operator
 * in the sidebar's foot.
 *
 * Routing is done here rather than by a router library, because there are only
 * four views and one real requirement on them: REQ-032 AC-6, that the approval
 * notice's link resolve to the request detail after IAP has authenticated the
 * recipient. That link is a path, so the API serves index.html for it and
 * `parseRoute` reads it; in-app navigation then uses the hash.
 *
 * Navigation is role-gated for presentation only (AC-11). Every action behind
 * these buttons is authorized again server-side.
 *
 * The mobile breakpoint lives entirely in the stylesheet. The drawer state
 * here is one class on the shell; whether that class means anything is a media
 * query's decision, so this component never has to ask how wide the window is.
 */

type Route =
  | { view: 'list' }
  | { view: 'new' }
  | { view: 'approvals' }
  | { view: 'admin' }
  | { view: 'request'; id: string };

function segmentRoute(segment: string): Route {
  const detail = /^requests\/(.+)$/.exec(segment);
  if (detail?.[1]) return { view: 'request', id: decodeURIComponent(detail[1]) };
  if (segment === 'new') return { view: 'new' };
  if (segment === 'approvals') return { view: 'approvals' };
  if (segment === 'admin') return { view: 'admin' };
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

type Theme = 'dark' | 'light';

/** index.html applies the stored theme before first paint; this reads it. */
function initialTheme(): Theme {
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
}

/** The retro-circle brand mark, sized by its container. */
function BrandMark() {
  return (
    <span className="brand-mark" aria-hidden="true">
      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
        <path d="M21 12a9 9 0 1 1-3-6.7" />
        <path d="M21 4v5h-5" />
      </svg>
    </span>
  );
}

const ICONS = {
  list: (
    <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
      <path d="M8 6h12M8 12h12M8 18h12" />
      <circle cx="4" cy="6" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="4" cy="12" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="4" cy="18" r="1.1" fill="currentColor" stroke="none" />
    </svg>
  ),
  new: (
    <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
      <path d="M12 5v14M5 12h14" />
    </svg>
  ),
  approvals: (
    <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
      <circle cx="12" cy="12" r="8.5" />
      <path d="M8.4 12.2l2.4 2.4 4.8-5.2" />
    </svg>
  ),
  admin: (
    <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
      <path d="M4 8h9M19 8h1M4 16h1M11 16h9" />
      <circle cx="16" cy="8" r="2.4" />
      <circle cx="8" cy="16" r="2.4" />
    </svg>
  ),
};

function ThemeIcon({ theme }: { theme: Theme }) {
  return theme === 'dark' ? (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
      <path d="M21 12.8A8.5 8.5 0 1 1 11.2 3 6.6 6.6 0 0 0 21 12.8z" />
    </svg>
  ) : (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4 12H2M22 12h-2M5 5l1.5 1.5M17.5 17.5L19 19M19 5l-1.5 1.5M6.5 17.5L5 19" />
    </svg>
  );
}

export function App() {
  const { identity, loading, error } = useIdentity();
  const [route, setRoute] = useState<Route>(() => parseRoute(currentLocation()));
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const [drawerOpen, setDrawerOpen] = useState(false);

  useEffect(() => {
    const onHash = () => setRoute(parseRoute(currentLocation()));
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem('console-theme', theme);
    } catch {
      // Storage can be unavailable; the theme then simply resets per visit.
    }
  }, [theme]);

  const go = (hash: string) => {
    window.location.hash = hash;
    setRoute(parseRoute(hash));
    setDrawerOpen(false);
  };
  const openRequest = (id: string) => go(`#/requests/${encodeURIComponent(id)}`);
  const toggleTheme = () => setTheme((t) => (t === 'dark' ? 'light' : 'dark'));

  if (loading) return <p role="status">loading…</p>;

  // The console cannot usefully render without a verified identity, and it must
  // not guess one. IAP should have prevented this from ever being reached.
  if (error || !identity) {
    return <p role="alert">Could not establish your identity. {error ?? ''}</p>;
  }

  const initials = identity.email.slice(0, 2);

  return (
    <div className={`shell${drawerOpen ? ' drawer-open' : ''}`}>
      <header className="mobile-bar">
        <button type="button" aria-label="menu" onClick={() => setDrawerOpen((o) => !o)}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" aria-hidden="true">
            <path d="M4 7h16M4 12h16M4 17h16" />
          </svg>
        </button>
        <BrandMark />
        <span className="brand-name">The Pack</span>
        <button type="button" aria-label="switch theme" onClick={toggleTheme}>
          <ThemeIcon theme={theme} />
        </button>
      </header>

      {drawerOpen && <div className="overlay" onClick={() => setDrawerOpen(false)} />}

      <aside aria-label="primary">
        <div className="brand">
          <BrandMark />
          <div>
            <h1>The Pack</h1>
            <p className="brand-sub">GCP Onboarding Console</p>
          </div>
        </div>

        <nav aria-label="sections">
          <button
            type="button"
            data-active={route.view === 'list' || route.view === 'request'}
            onClick={() => go('#/')}
          >
            {ICONS.list}
            Requests
          </button>
          <Can role="requester">
            <button type="button" data-active={route.view === 'new'} onClick={() => go('#/new')}>
              {ICONS.new}
              New request
            </button>
          </Can>
          <Can role="approver">
            <button
              type="button"
              data-active={route.view === 'approvals'}
              onClick={() => go('#/approvals')}
            >
              {ICONS.approvals}
              Approvals
            </button>
          </Can>
          <Can role="admin">
            <button type="button" data-active={route.view === 'admin'} onClick={() => go('#/admin')}>
              {ICONS.admin}
              Admin
            </button>
          </Can>
        </nav>

        <div className="side-foot">
          <button type="button" className="theme-toggle" onClick={toggleTheme}>
            <ThemeIcon theme={theme} />
            {theme === 'dark' ? 'Switch to light' : 'Switch to dark'}
          </button>
          <div className="operator">
            <span className="avatar" aria-hidden="true">
              {initials}
            </span>
            <div>
              <p className="email">
                <strong>{identity.email}</strong>
              </p>
              <p className="roles">
                {identity.roles.length > 0 ? identity.roles.join(' · ') : 'no roles assigned'}
              </p>
            </div>
          </div>
          <button
            type="button"
            className="signout"
            onClick={() => {
              // IAP's own sign-out: clearing its session cookie sends the next
              // request back through Google sign-in, which is where an operator
              // switches accounts. The console holds no auth state of its own
              // to clear, and the Google account session itself is Google's to
              // end, not this application's.
              window.location.href = '/?gcp-iap-mode=CLEAR_LOGIN_COOKIE';
            }}
          >
            Sign out
          </button>
        </div>
      </aside>

      <main>
        <div className="content">
          {route.view === 'list' && <RequestList onOpen={openRequest} />}
          {route.view === 'new' && <RequestForm onSubmitted={openRequest} />}
          {route.view === 'approvals' && <Approvals onOpen={openRequest} />}
          {route.view === 'admin' && <AdminView />}
          {route.view === 'request' && <RequestDetailView requestId={route.id} />}
        </div>
      </main>
    </div>
  );
}
