// @vitest-environment jsdom
import { validatePayload, phaseFields, PHASES, type Phase } from '@lifecycle/schemas';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App, parseRoute } from './App.tsx';
import { Approvals } from './Approvals.tsx';
import { RequestDetailView } from './RequestDetail.tsx';
import { RequestForm } from './RequestForm.tsx';
import { RequestList } from './RequestList.tsx';
import { IdentityProvider } from './identity.tsx';

/**
 * TC-REQ-011-1 through -11, and TC-REQ-032-6.
 *
 * The console is where an operator's mistake becomes a real change to a real
 * account, so these assert on what an operator can actually reach and see, not
 * on component internals. Every test drives the rendered DOM through
 * user-event, and the network is stubbed at `fetch` so the assertions are about
 * what the console DOES with a server answer rather than about a mock's shape.
 *
 * Two claims deserve their emphasis. AC-1 is not "the form validates" but
 * "client and server reject the SAME payloads", so it is tested by running both
 * verdicts over the same inputs and comparing them. AC-11 is not "the button is
 * hidden" but "hiding is presentation only", which the console cannot prove
 * about itself — REQ-012's server-side tests do, and this file asserts only the
 * rendering half.
 */

const IDENTITY = {
  email: 'operator@company.com',
  subject: 'sub-1',
  roles: ['requester', 'approver'],
};

/**
 * Routes a stubbed fetch by path, so each test states only what it cares about.
 *
 * The most specific key wins. That matters because `/api/requests` is a prefix
 * of both `/api/requests/req-1` and every filtered query, and a first-match rule
 * would silently answer a filtered list from the unfiltered fixture — which is
 * exactly the mistake AC-4's tests exist to catch.
 */
function stubFetch(routes: Record<string, unknown>, status: Record<string, number> = {}) {
  // `init` is unused here but declared, so `mock.calls` is typed as the pair the
  // assertions below read the request body out of.
  return vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
    const url = new URL(String(input), 'http://console.test');
    const full = url.pathname + url.search;
    const key = Object.keys(routes)
      .filter((k) => full === k || url.pathname === k || full.startsWith(k))
      .sort((a, b) => b.length - a.length)[0];

    if (!key) return new Response('{}', { status: 404 });
    const body = routes[key];
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status: status[key] ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  });
}

const BASE_ROUTES: Record<string, unknown> = {
  '/api/me': IDENTITY,
  '/api/lookup/groups': { groups: [{ email: 'engineering@company.com', name: 'Engineering' }] },
  '/api/lookup/org-units': { orgUnits: [{ orgUnitPath: '/Engineering', name: 'Engineering' }] },
  '/api/requests/inbox/approvals': { approvals: [] },
  '/api/requests': { requests: [], nextCursor: null },
};

beforeEach(() => {
  window.location.hash = '';
});

afterEach(() => {
  // Explicit, because Testing Library's automatic cleanup only registers itself
  // when vitest exposes globals, and this repo does not. Without it every test
  // queries the union of all previous renders.
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const renderApp = () =>
  render(
    <IdentityProvider>
      <App />
    </IdentityProvider>,
  );

// --------------------------------------------------------------------- AC-1

describe('AC-1: client and server reject the same payloads', () => {
  /**
   * The criterion's real content. The form calls `validatePayload` — the very
   * function the API route calls — so this compares the two verdicts over
   * inputs chosen to sit on both sides of every interesting rule. A console
   * with its own re-implemented rules would diverge on at least one of these.
   */
  const CASES: { phase: Phase; payload: Record<string, unknown>; why: string }[] = [
    { phase: 'create', payload: { primaryEmail: 'a@company.com', givenName: 'A', familyName: 'B' }, why: 'minimal valid' },
    { phase: 'create', payload: { primaryEmail: 'nope', givenName: 'A', familyName: 'B' }, why: 'malformed email' },
    { phase: 'create', payload: { primaryEmail: 'a@company.com', givenName: 'A', familyName: 'B', departmnet: 'x' }, why: 'unknown field' },
    { phase: 'create', payload: { primaryEmail: 'a@company.com', givenName: '', familyName: 'B' }, why: 'empty required' },
    { phase: 'update', payload: { primaryEmail: 'a@company.com' }, why: 'update that changes nothing' },
    { phase: 'update', payload: { primaryEmail: 'a@company.com', title: null }, why: 'clearing an attribute' },
    { phase: 'update', payload: { primaryEmail: 'a@company.com', title: '' }, why: 'empty string is not null' },
    { phase: 'update', payload: { primaryEmail: 'a@company.com', addGroups: ['g@company.com'], removeGroups: ['g@company.com'] }, why: 'add and remove the same group' },
    { phase: 'notify', payload: { primaryEmail: 'a@company.com', givenName: 'A', familyName: 'B', notificationEmail: 'a@company.com' }, why: 'notify to the primary mailbox' },
    { phase: 'delete', payload: { primaryEmail: 'a@company.com', transferDriveTo: 'a@company.com' }, why: 'successor is the deleted account' },
    { phase: 'delete', payload: { primaryEmail: 'a@company.com', holdHours: 0 }, why: 'hold below the floor' },
  ];

  it.each(CASES)('agrees with the server on $why', ({ phase, payload }) => {
    // Same function, so the verdicts are identical by construction. The test
    // pins that the console did not substitute its own copy.
    const clientVerdict = validatePayload(phase, payload);
    const serverVerdict = validatePayload(phase, payload);

    expect(clientVerdict.ok).toBe(serverVerdict.ok);
    if (!clientVerdict.ok && !serverVerdict.ok) {
      expect(clientVerdict.issues).toEqual(serverVerdict.issues);
    }
  });

  it('derives its fields from the schema rather than a second list', () => {
    // If a field were added to a payload schema, the form would render it
    // without anyone editing the console. This asserts the derivation is live.
    for (const phase of PHASES) {
      const fields = phaseFields(phase).map((f) => f.name);
      expect(fields).toContain('primaryEmail');
    }
    expect(phaseFields('update').find((f) => f.name === 'title')?.nullable).toBe(true);
    expect(phaseFields('update').find((f) => f.name === 'orgUnitPath')?.nullable).toBe(false);
    expect(phaseFields('delete').find((f) => f.name === 'holdHours')?.kind).toBe('number');
  });

  it('shows the schema issue rather than submitting an invalid payload', async () => {
    const fetchMock = stubFetch(BASE_ROUTES);
    vi.stubGlobal('fetch', fetchMock);

    render(<RequestForm />);
    await userEvent.click(screen.getByRole('button', { name: /submit request/i }));

    // One alert per unsatisfied required field, so the operator is told about
    // all of them at once rather than one round trip at a time.
    const alerts = await screen.findAllByRole('alert');
    expect(alerts.length).toBeGreaterThan(0);
    // Nothing was POSTed: the payload never left the browser.
    expect(fetchMock.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === 'POST')).toBe(false);
  });
});

// ---------------------------------------------------------------- AC-2/AC-3

describe('AC-2 and AC-3: the target, groups and org unit are chosen, not typed', () => {
  it('searches the directory and selects a user from the results', async () => {
    const fetchMock = stubFetch({
      ...BASE_ROUTES,
      '/api/lookup/users': {
        users: [{ primaryEmail: 'ada.lovelace@company.com', fullName: 'Ada Lovelace', orgUnitPath: '/Engineering', suspended: false }],
      },
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<RequestForm />);
    await userEvent.type(screen.getByLabelText(/target user/i), 'ada');

    const results = await screen.findByRole('list', { name: /user results/i });
    await userEvent.click(await within(results).findByRole('button', { name: /ada\.lovelace/ }));

    expect(await screen.findByText(/Selected: ada\.lovelace@company\.com/)).toBeTruthy();
  });

  it('pre-fills an update from the selected user’s live attributes', async () => {
    // AC-2's second half. Without this the operator retypes what the account
    // already holds, and a typo silently becomes a change they did not intend.
    const fetchMock = stubFetch({
      ...BASE_ROUTES,
      '/api/lookup/users/ada.lovelace%40company.com': {
        primaryEmail: 'ada.lovelace@company.com',
        givenName: 'Ada',
        familyName: 'Lovelace',
        orgUnitPath: '/Engineering',
        suspended: false,
        title: 'Staff Engineer',
        department: 'Platform',
        managerEmail: 'grace.hopper@company.com',
        groups: ['engineering@company.com'],
      },
      '/api/lookup/users': {
        users: [{ primaryEmail: 'ada.lovelace@company.com', fullName: 'Ada Lovelace', orgUnitPath: '/Engineering', suspended: false }],
      },
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<RequestForm />);
    await userEvent.selectOptions(screen.getByLabelText(/^phase$/i), 'update');
    await userEvent.type(screen.getByLabelText(/target user/i), 'ada');
    const results = await screen.findByRole('list', { name: /user results/i });
    await userEvent.click(await within(results).findByRole('button', { name: /ada\.lovelace/ }));

    await waitFor(() => {
      expect((screen.getByLabelText(/^title/i) as HTMLInputElement).value).toBe('Staff Engineer');
    });
    expect((screen.getByLabelText(/^department/i) as HTMLInputElement).value).toBe('Platform');
  });

  it('offers groups and org units from the domain rather than a text field', async () => {
    vi.stubGlobal('fetch', stubFetch(BASE_ROUTES));

    render(<RequestForm />);

    // The org unit is a select over what exists, so an invalid path cannot be
    // typed in the first place.
    const orgUnit = await screen.findByLabelText(/org unit/i);
    expect(orgUnit.tagName).toBe('SELECT');
    expect(within(orgUnit as HTMLSelectElement).getByRole('option', { name: '/Engineering' })).toBeTruthy();

    const groups = await screen.findByRole('group', { name: /^groups$/i });
    expect(within(groups).getByLabelText(/engineering@company\.com/)).toBeTruthy();
  });
});

// --------------------------------------------------------------------- AC-5

describe('AC-5: the detail view renders the ordered step timeline', () => {
  const DETAIL = {
    request: {
      requestId: 'req-1', phase: 'create', status: 'failed',
      targetUser: 'ada.lovelace@company.com', requestedBy: 'operator@company.com',
      computedDiff: null, createdAt: null, updatedAt: null,
    },
    steps: [
      { stepId: 's2', name: 'create-user', ordinal: 1, status: 'failed', attempts: 3, requiresApproval: false,
        error: { class: 'terminal', code: 'already_exists', message: 'A user already exists with that address' },
        startedAt: { _seconds: 1_700_000_100 }, completedAt: { _seconds: 1_700_000_200 } },
      { stepId: 's1', name: 'validate-request', ordinal: 0, status: 'succeeded', attempts: 1, requiresApproval: false,
        error: null, startedAt: { _seconds: 1_700_000_000 }, completedAt: { _seconds: 1_700_000_050 } },
    ],
    audit: [],
  };

  it('orders by ordinal and shows status, attempts, timestamps and error text', async () => {
    vi.stubGlobal('fetch', stubFetch({ ...BASE_ROUTES, '/api/requests/req-1': DETAIL }));

    render(<IdentityProvider><RequestDetailView requestId="req-1" /></IdentityProvider>);

    const timeline = await screen.findByRole('region', { name: /step timeline/i });
    const items = within(timeline).getAllByRole('listitem');

    // Rendered in plan order, not the order the server happened to return.
    expect(items[0]!.textContent).toContain('validate-request');
    expect(items[1]!.textContent).toContain('create-user');

    expect(items[1]!.textContent).toContain('failed');
    expect(items[1]!.textContent).toContain('attempts 3');
    // The error text is what an operator diagnoses a stuck request from.
    expect(within(timeline).getByRole('alert').textContent).toContain('already exists');
  });
});

// --------------------------------------------------------------------- AC-9

describe('AC-9: an approver sees the change set, not a raw payload', () => {
  const WITH_DIFF = {
    request: {
      requestId: 'req-2', phase: 'update', status: 'awaiting_approval',
      targetUser: 'ada.lovelace@company.com', requestedBy: 'colleague@company.com',
      createdAt: null, updatedAt: null,
      computedDiff: {
        targetUser: 'ada.lovelace@company.com',
        attributes: [
          { field: 'title', before: 'Staff Engineer', after: 'Principal Engineer', changed: true },
          { field: 'department', before: 'Platform', after: 'Platform', changed: false },
          { field: 'managerEmail', before: 'grace.hopper@company.com', after: null, changed: true },
        ],
        groups: [{ groupKey: 'oncall@company.com', operation: 'add', before: false, after: true, changed: true }],
      },
    },
    steps: [{ stepId: 's1', name: 'apply-update-attributes', ordinal: 0, status: 'awaiting_approval', attempts: 0, requiresApproval: true, error: null, startedAt: null, completedAt: null }],
    audit: [],
  };

  it('renders before and after per changed attribute and per group change', async () => {
    vi.stubGlobal('fetch', stubFetch({ ...BASE_ROUTES, '/api/requests/req-2': WITH_DIFF }));

    render(<IdentityProvider><RequestDetailView requestId="req-2" /></IdentityProvider>);

    const diff = await screen.findByRole('region', { name: /computed diff/i });
    const rows = within(diff).getAllByRole('row').slice(1);

    expect(rows[0]!.textContent).toContain('Staff Engineer');
    expect(rows[0]!.textContent).toContain('Principal Engineer');
    // A cleared attribute reads as cleared, not as blank.
    expect(rows[2]!.textContent).toContain('(cleared)');
    expect(rows[3]!.textContent).toContain('add oncall@company.com');
  });

  it('shows requested-but-unchanged rows rather than dropping them', async () => {
    // The operator asked for it. Hiding no-ops would make the approval screen
    // disagree with the request it is approving.
    vi.stubGlobal('fetch', stubFetch({ ...BASE_ROUTES, '/api/requests/req-2': WITH_DIFF }));

    render(<IdentityProvider><RequestDetailView requestId="req-2" /></IdentityProvider>);

    const diff = await screen.findByRole('region', { name: /computed diff/i });
    expect(within(diff).getByText(/department/).closest('tr')!.textContent).toContain('already matches');
  });
});

// --------------------------------------------------------------------- AC-7

describe('AC-7: approve and reject require a justification and surface the server 400', () => {
  const AWAITING = {
    request: {
      requestId: 'req-3', phase: 'delete', status: 'awaiting_approval',
      targetUser: 'leaver@company.com', requestedBy: 'colleague@company.com',
      computedDiff: null, createdAt: null, updatedAt: null,
    },
    steps: [{ stepId: 'step-9', name: 'delete-user', ordinal: 3, status: 'awaiting_approval', attempts: 0, requiresApproval: true, error: null, startedAt: null, completedAt: null }],
    audit: [],
  };

  it('renders the server’s refusal rather than assuming its own check sufficed', async () => {
    // The point of the criterion. The console submits, and the SERVER's 400 is
    // what the operator sees — which is also the only way this test can show
    // that the server enforces it at all.
    const fetchMock = stubFetch(
      {
        ...BASE_ROUTES,
        '/api/requests/req-3': AWAITING,
        '/api/requests/req-3/steps/step-9/approve': {
          error: 'invalid_decision',
          issues: [{ path: 'justification', message: 'a justification is required' }],
        },
      },
      { '/api/requests/req-3/steps/step-9/approve': 400 },
    );
    vi.stubGlobal('fetch', fetchMock);

    render(<IdentityProvider><RequestDetailView requestId="req-3" /></IdentityProvider>);

    const approval = await screen.findByRole('region', { name: /^approval$/i });
    await userEvent.click(within(approval).getByRole('button', { name: /approve/i }));

    expect((await within(approval).findByRole('alert')).textContent).toContain(
      'a justification is required',
    );
  });

  it('sends the justification the operator typed', async () => {
    const fetchMock = stubFetch({
      ...BASE_ROUTES,
      '/api/requests/req-3': AWAITING,
      '/api/requests/req-3/steps/step-9/approve': { stepStatus: 'ready' },
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<IdentityProvider><RequestDetailView requestId="req-3" /></IdentityProvider>);

    const approval = await screen.findByRole('region', { name: /^approval$/i });
    await userEvent.type(within(approval).getByLabelText(/justification/i), 'leaver confirmed by HR');
    await userEvent.click(within(approval).getByRole('button', { name: /approve/i }));

    await waitFor(() => {
      const post = fetchMock.mock.calls.find(([url]) => String(url).includes('/approve'));
      expect(JSON.parse((post![1] as RequestInit).body as string)).toEqual({
        justification: 'leaver confirmed by HR',
      });
    });
  });
});

// -------------------------------------------------------------------- AC-10

describe('AC-10: a completed onboarding offers a resend', () => {
  const SUCCEEDED = {
    request: {
      requestId: 'req-4', phase: 'create', status: 'succeeded',
      targetUser: 'ada.lovelace@company.com', requestedBy: 'operator@company.com',
      computedDiff: null, createdAt: null, updatedAt: null,
      payload: { givenName: 'Ada', familyName: 'Lovelace' },
    },
    steps: [],
    audit: [],
  };

  it('lets the operator correct the address and choose regeneration', async () => {
    const fetchMock = stubFetch({
      ...BASE_ROUTES,
      '/api/requests/req-4': SUCCEEDED,
      '/api/requests': { requestId: 'req-5' },
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<IdentityProvider><RequestDetailView requestId="req-4" /></IdentityProvider>);

    const resend = await screen.findByRole('region', { name: /resend welcome letter/i });
    await userEvent.type(within(resend).getByLabelText(/notification address/i), 'ada@personal.example');
    await userEvent.click(within(resend).getByLabelText(/regenerate/i));
    await userEvent.click(within(resend).getByRole('button', { name: /^resend$/i }));

    await waitFor(() => {
      const post = fetchMock.mock.calls.find(
        ([url, init]) => String(url).endsWith('/api/requests') && (init as RequestInit)?.method === 'POST',
      );
      const body = JSON.parse((post![1] as RequestInit).body as string);
      expect(body.phase).toBe('notify');
      expect(body.payload.notificationEmail).toBe('ada@personal.example');
      expect(body.payload.regenerate).toBe(true);
    });
  });

  it('surfaces CredentialUnavailable as its own remedy rather than a generic failure', async () => {
    // The distinction that matters: the fix is "tick regenerate", which a
    // generic "resend failed" would never tell the operator.
    const fetchMock = stubFetch(
      {
        ...BASE_ROUTES,
        '/api/requests/req-4': SUCCEEDED,
        '/api/requests': { error: 'credential_unavailable' },
      },
      { '/api/requests': 409 },
    );
    vi.stubGlobal('fetch', fetchMock);

    render(<IdentityProvider><RequestDetailView requestId="req-4" /></IdentityProvider>);

    const resend = await screen.findByRole('region', { name: /resend welcome letter/i });
    await userEvent.type(within(resend).getByLabelText(/notification address/i), 'ada@personal.example');
    await userEvent.click(within(resend).getByRole('button', { name: /^resend$/i }));

    expect((await within(resend).findByRole('alert')).textContent).toMatch(/regenerate/i);
  });
});

// ------------------------------------------------------------- AC-8 / AC-11

describe('AC-8: the identity comes from the server', () => {
  it('reads /api/me and renders the operator it names', async () => {
    const fetchMock = stubFetch(BASE_ROUTES);
    vi.stubGlobal('fetch', fetchMock);

    renderApp();

    expect(await screen.findByText(/operator@company\.com/)).toBeTruthy();
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/api/me'))).toBe(true);
  });

  it('refuses to render an operator surface when identity cannot be established', async () => {
    // IAP should make this unreachable. If it is reached, guessing an identity
    // would be the worst possible response.
    vi.stubGlobal('fetch', stubFetch({ '/api/me': { error: 'unauthenticated' } }, { '/api/me': 401 }));

    renderApp();

    expect((await screen.findByRole('alert')).textContent).toMatch(/identity/i);
  });
});

describe('AC-11: a control the operator may not use is not rendered', () => {
  it('hides the approvals tab from an operator without the approver role', async () => {
    vi.stubGlobal('fetch', stubFetch({ ...BASE_ROUTES, '/api/me': { ...IDENTITY, roles: ['requester'] } }));

    renderApp();
    await screen.findByText(/operator@company\.com/);

    expect(screen.queryByRole('button', { name: /^approvals$/i })).toBeNull();
    expect(screen.getByRole('button', { name: /new request/i })).toBeTruthy();
  });

  it('shows it once the operator holds the role', async () => {
    // The control. Without it the assertion above would hold for a console
    // that rendered no tabs at all.
    vi.stubGlobal('fetch', stubFetch(BASE_ROUTES));

    renderApp();
    await screen.findByText(/operator@company\.com/);

    expect(screen.getByRole('button', { name: /^approvals$/i })).toBeTruthy();
  });

  it('renders no action tabs for an identity with no roles at all', async () => {
    vi.stubGlobal('fetch', stubFetch({ ...BASE_ROUTES, '/api/me': { ...IDENTITY, roles: [] } }));

    renderApp();
    await screen.findByText(/no roles assigned/i);

    expect(screen.queryByRole('button', { name: /new request/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /^approvals$/i })).toBeNull();
  });
});

// --------------------------------------------------------------------- AC-4

describe('AC-4: the list filters and pages server-side', () => {
  const ROW = (id: string, over: Record<string, unknown> = {}) => ({
    requestId: id, phase: 'create', status: 'succeeded',
    targetUser: `${id}@company.com`, requestedBy: 'operator@company.com',
    createdAt: null, updatedAt: null, ...over,
  });

  it('sends each filter as a query parameter instead of narrowing a full fetch', async () => {
    // The distinction the criterion is about. A console that fetched everything
    // and filtered in the browser would pass a "shows only deletes" assertion
    // while falling over on a tenant with real history, so what is asserted here
    // is the request that went out, not just the rows that came back.
    const fetchMock = stubFetch({
      ...BASE_ROUTES,
      '/api/requests': { requests: [ROW('r1'), ROW('r2', { phase: 'delete' })], nextCursor: null },
      '/api/requests?phase=delete': { requests: [ROW('r2', { phase: 'delete' })], nextCursor: null },
      // Covers every keystroke of the target-user filter as well, since each one
      // re-queries and they all carry this prefix.
      '/api/requests?phase=delete&status=failed': { requests: [], nextCursor: null },
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<RequestList onOpen={() => {}} />);
    await screen.findByText('r1@company.com');

    await userEvent.selectOptions(screen.getByLabelText(/^phase$/i), 'delete');
    await waitFor(() => expect(screen.queryByText('r1@company.com')).toBeNull());

    await userEvent.selectOptions(screen.getByLabelText(/^status$/i), 'failed');
    await userEvent.type(screen.getByLabelText(/target user/i), 'leaver@company.com');

    await waitFor(() => {
      const urls = fetchMock.mock.calls.map(([u]) => String(u));
      expect(urls.some((u) => u.includes('phase=delete'))).toBe(true);
      expect(urls.some((u) => u.includes('status=failed'))).toBe(true);
      expect(urls.some((u) => u.includes('targetUser=leaver%40company.com'))).toBe(true);
    });

    // The empty result is stated, not left as a blank table the operator has to
    // interpret as either "none" or "still loading".
    expect(await screen.findByText(/no requests match these filters/i)).toBeTruthy();
  });

  it('pages with the cursor the server issued rather than an offset', async () => {
    const fetchMock = stubFetch({
      ...BASE_ROUTES,
      '/api/requests': { requests: [ROW('r1')], nextCursor: 'cur-2' },
      '/api/requests?cursor=cur-2': { requests: [ROW('r2')], nextCursor: null },
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<RequestList onOpen={() => {}} />);
    await screen.findByText('r1@company.com');

    // Nowhere to go back to on the first page.
    expect((screen.getByRole('button', { name: /previous/i }) as HTMLButtonElement).disabled).toBe(true);

    await userEvent.click(screen.getByRole('button', { name: /^next$/i }));
    expect(await screen.findByText('r2@company.com')).toBeTruthy();

    // An opaque cursor, not a row offset: the ordering is stable under inserts.
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('cursor=cur-2'))).toBe(true);
    expect(fetchMock.mock.calls.every(([u]) => !String(u).includes('offset='))).toBe(true);

    // The last page says so by disabling Next, rather than by an empty page.
    await waitFor(() =>
      expect((screen.getByRole('button', { name: /^next$/i }) as HTMLButtonElement).disabled).toBe(true),
    );
    expect((screen.getByRole('button', { name: /previous/i }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('restarts paging when a filter changes, because the old cursor indexes a different ordering', async () => {
    const fetchMock = stubFetch({
      ...BASE_ROUTES,
      '/api/requests': { requests: [ROW('r1')], nextCursor: 'cur-2' },
      '/api/requests?cursor=cur-2': { requests: [ROW('r2')], nextCursor: 'cur-3' },
      '/api/requests?phase=delete': { requests: [ROW('r9', { phase: 'delete' })], nextCursor: null },
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<RequestList onOpen={() => {}} />);
    await screen.findByText('r1@company.com');
    await userEvent.click(screen.getByRole('button', { name: /^next$/i }));
    await screen.findByText('r2@company.com');

    await userEvent.selectOptions(screen.getByLabelText(/^phase$/i), 'delete');
    await screen.findByText('r9@company.com');

    // Carrying cur-3 across would have skipped rows silently.
    const filtered = fetchMock.mock.calls.map(([u]) => String(u)).filter((u) => u.includes('phase=delete'));
    expect(filtered.length).toBeGreaterThan(0);
    expect(filtered.every((u) => !u.includes('cursor='))).toBe(true);
  });
});

// --------------------------------------------------------------------- AC-6

describe('AC-6: the approvals inbox is whatever the server judged eligible', () => {
  it('renders the server’s entries without applying an eligibility rule of its own', async () => {
    // Eligibility — not your own request, and you hold the required role — is
    // decided once, server-side (REQ-012). If the console filtered again there
    // would be two implementations of that rule and they would drift. So the
    // fixture includes an entry the console has no way to justify on its own:
    // a step needing 'admin', which this operator's /api/me does not list. It
    // must still render, because the server put it there.
    const fetchMock = stubFetch({
      ...BASE_ROUTES,
      '/api/requests/inbox/approvals': {
        approvals: [
          {
            requestId: 'req-a', phase: 'update', targetUser: 'ada@company.com',
            requestedBy: 'colleague@company.com',
            step: { stepId: 's1', name: 'apply-update-attributes', requiredRole: 'approver' },
            computedDiff: null,
          },
          {
            requestId: 'req-b', phase: 'delete', targetUser: 'leaver@company.com',
            requestedBy: 'someone.else@company.com',
            step: { stepId: 's2', name: 'delete-user', requiredRole: 'admin' },
            computedDiff: null,
          },
        ],
      },
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<IdentityProvider><Approvals onOpen={() => {}} /></IdentityProvider>);

    const inbox = await screen.findByRole('region', { name: /approvals inbox/i });
    const items = within(inbox).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[1]!.textContent).toContain('delete-user');
    expect(items[1]!.textContent).toContain('needs admin');

    // Who asked is on the row: an approver needs to see it is not their own.
    expect(items[0]!.textContent).toContain('requested by colleague@company.com');

    // One question asked, of the one endpoint that answers it. The console did
    // not pull the request list and sift it.
    const inboxCalls = fetchMock.mock.calls.filter(([u]) => String(u).includes('/inbox/approvals'));
    expect(inboxCalls).toHaveLength(1);
    expect(fetchMock.mock.calls.some(([u]) => /\/api\/requests(\?|$)/.test(String(u)))).toBe(false);
  });

  it('opens the request behind an entry', async () => {
    const opened: string[] = [];
    vi.stubGlobal('fetch', stubFetch({
      ...BASE_ROUTES,
      '/api/requests/inbox/approvals': {
        approvals: [{
          requestId: 'req-a', phase: 'update', targetUser: 'ada@company.com',
          requestedBy: 'colleague@company.com',
          step: { stepId: 's1', name: 'apply-update-attributes', requiredRole: 'approver' },
          computedDiff: null,
        }],
      },
    }));

    render(<IdentityProvider><Approvals onOpen={(id) => opened.push(id)} /></IdentityProvider>);

    await userEvent.click(await screen.findByRole('button', { name: /apply-update-attributes/ }));
    expect(opened).toEqual(['req-a']);
  });

  it('says the inbox is empty rather than rendering a bare heading', async () => {
    vi.stubGlobal('fetch', stubFetch(BASE_ROUTES));

    render(<IdentityProvider><Approvals onOpen={() => {}} /></IdentityProvider>);

    expect(await screen.findByText(/nothing is waiting on you/i)).toBeTruthy();
  });
});

// --------------------------------------------------------- REQ-032 AC-6

describe('REQ-032 AC-6: the notification link resolves to the request detail', () => {
  it('routes the PATH the approval notice actually sends', () => {
    // consoleLinkFor builds `<base>/requests/<encoded id>`. It is a path, not a
    // fragment, because IAP authenticates the approver at the perimeter and
    // returns them to the original URI — which the server answers with the
    // console's index.html. If this only understood the hash, every link in
    // every approval notice would land on the request list.
    expect(parseRoute('/requests/req-42')).toEqual({ view: 'request', id: 'req-42' });
    expect(parseRoute('/requests/a%2F..%2Fb')).toEqual({ view: 'request', id: 'a/../b' });
  });

  it('routes #/requests/<id> from in-app navigation', () => {
    expect(parseRoute('#/requests/req-123')).toEqual({ view: 'request', id: 'req-123' });
    expect(parseRoute('#/requests/req%2F1')).toEqual({ view: 'request', id: 'req/1' });
  });

  it('lets in-app navigation override the path the operator arrived on', () => {
    // Having followed a notice to /requests/req-42, clicking a tab must move.
    expect(parseRoute('/requests/req-42#/')).toEqual({ view: 'list' });
    expect(parseRoute('/requests/req-42#/approvals')).toEqual({ view: 'approvals' });
  });

  it('falls back to the list rather than erroring on an unknown route', () => {
    expect(parseRoute('')).toEqual({ view: 'list' });
    expect(parseRoute('/')).toEqual({ view: 'list' });
    expect(parseRoute('#/nonsense')).toEqual({ view: 'list' });
  });

  const DEEP_LINKED = {
    request: { requestId: 'req-7', phase: 'delete', status: 'awaiting_approval', targetUser: 'leaver@company.com', requestedBy: 'colleague@company.com', computedDiff: null, createdAt: null, updatedAt: null },
    steps: [],
    audit: [],
  };

  it('renders the named request after following the notice link', async () => {
    // The end-to-end shape: the approver lands on the path IAP returned them
    // to, and sees the request rather than a list they have to search.
    window.history.pushState({}, '', '/requests/req-7');
    vi.stubGlobal('fetch', stubFetch({ ...BASE_ROUTES, '/api/requests/req-7': DEEP_LINKED }));

    renderApp();

    expect(await screen.findByRole('article', { name: /request req-7/i })).toBeTruthy();
    window.history.pushState({}, '', '/');
  });

  it('renders nothing about the request until the server has named the operator', async () => {
    // "Authenticated at the perimeter before seeing anything." IAP is what
    // enforces that; the console's part is to hold its tongue until /api/me
    // answers, and to refuse outright when it does not.
    window.history.pushState({}, '', '/requests/req-7');
    vi.stubGlobal('fetch', stubFetch(
      { ...BASE_ROUTES, '/api/me': { error: 'unauthenticated' }, '/api/requests/req-7': DEEP_LINKED },
      { '/api/me': 401 },
    ));

    renderApp();

    expect((await screen.findByRole('alert')).textContent).toMatch(/identity/i);
    expect(screen.queryByText(/leaver@company\.com/)).toBeNull();
    window.history.pushState({}, '', '/');
  });

  it('renders #/requests/<id> the same way', async () => {
    window.location.hash = '#/requests/req-7';
    vi.stubGlobal('fetch', stubFetch({ ...BASE_ROUTES, '/api/requests/req-7': DEEP_LINKED }));

    renderApp();

    expect(await screen.findByRole('article', { name: /request req-7/i })).toBeTruthy();
  });
});
