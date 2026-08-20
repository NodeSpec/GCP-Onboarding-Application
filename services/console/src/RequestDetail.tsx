import { useEffect, useState } from 'react';
import {
  ApiError,
  adminCancelRequest,
  adminResumeRequest,
  cancelRequest,
  decideStep,
  getRequest,
  retrieveCredential,
  submitRequest,
  type RequestDetail as Detail,
  type StepView,
  type UpdateDiff,
} from './api.js';
import { Can, useIdentity } from './identity.tsx';

/**
 * One request in full (REQ-011 AC-5, AC-7, AC-9, AC-10).
 *
 * This is the view REQ-032's approval notice links to, so it has to stand on
 * its own for someone arriving cold from an email: what was asked for, what has
 * happened, what is waiting, and what they can do about it. The timeline and
 * the diff carry the record on the left; every act an operator can take sits
 * in cards on the right, and the two columns collapse to one on a phone.
 */

function stamp(t: { _seconds?: number } | null): string {
  if (!t?._seconds) return '—';
  return new Date(t._seconds * 1000).toISOString().replace('T', ' ').slice(0, 19);
}

/**
 * AC-9: the change set, not the raw payload.
 *
 * An approver is authorising a change to a real person's account, and
 * "payload: {...}" does not tell them what will happen to it. Unchanged rows
 * are rendered too, and marked: the operator asked for them, and silently
 * dropping them would make the screen disagree with the request it approves.
 */
export function DiffView({ diff }: { diff: UpdateDiff }) {
  return (
    <section aria-label="computed diff">
      <h3>What will change</h3>
      <table>
        <thead>
          <tr>
            <th>Field</th>
            <th>Before</th>
            <th>After</th>
          </tr>
        </thead>
        <tbody>
          {diff.attributes.map((a) => (
            <tr key={a.field} className={a.changed ? 'changed' : 'unchanged'}>
              <td>{a.field}</td>
              <td>{a.before ?? <em>(none)</em>}</td>
              <td>
                {a.after ?? <em>(cleared)</em>}
                {!a.changed && ' — already matches'}
              </td>
            </tr>
          ))}
          {diff.groups.map((g) => (
            <tr key={`${g.operation}:${g.groupKey}`} className={g.changed ? 'changed' : 'unchanged'}>
              <td>
                {g.operation} {g.groupKey}
              </td>
              <td>{g.before ? 'member' : 'not a member'}</td>
              <td>
                {g.after ? 'member' : 'not a member'}
                {!g.changed && ' — already matches'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

/** AC-5: the ordered timeline, with the detail a stuck request is diagnosed from. */
function Timeline({ steps }: { steps: StepView[] }) {
  return (
    <section aria-label="step timeline">
      <h3>Steps</h3>
      <ol>
        {[...steps]
          .sort((a, b) => a.ordinal - b.ordinal)
          .map((s) => (
            <li key={s.stepId} data-status={s.status}>
              <strong>{s.name}</strong> — {s.status}
              <span> · attempts {s.attempts}</span>
              <span> · started {stamp(s.startedAt)}</span>
              <span> · completed {stamp(s.completedAt)}</span>
              {s.error && (
                <p role="alert" className="step-error">
                  {s.error.class}/{s.error.code}: {s.error.message}
                </p>
              )}
            </li>
          ))}
      </ol>
    </section>
  );
}

/**
 * AC-7: approve and reject demand a justification, and the SERVER's refusal is
 * what is shown.
 *
 * The client check is a courtesy that saves a round trip. It is deliberately
 * not the gate: the button submits, and a 400 from the server is rendered
 * verbatim, because REQ-002 AC-5 requires the justification to be enforced
 * server-side independently of any client check. A console that only ever
 * showed its own message would hide whether the server actually enforces it.
 */
function ApprovalControls({
  requestId,
  step,
  onDone,
}: {
  requestId: string;
  step: StepView;
  onDone: () => void;
}) {
  const [justification, setJustification] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function decide(decision: 'approve' | 'reject') {
    setBusy(true);
    setError(null);
    try {
      await decideStep(requestId, step.stepId, decision, justification);
      setJustification('');
      onDone();
    } catch (err) {
      if (err instanceof ApiError) {
        const issue = err.issues[0]?.message;
        setError(issue ?? (err.body as { error?: string })?.error ?? `refused (${err.status})`);
      } else {
        setError('the decision could not be recorded');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-label="approval">
      <h3>Awaiting your decision: {step.name}</h3>
      <label htmlFor="justification">Justification</label>
      <textarea
        id="justification"
        value={justification}
        onChange={(e) => setJustification(e.target.value)}
      />
      {error && <p role="alert">{error}</p>}
      <button type="button" disabled={busy} onClick={() => decide('approve')}>
        Approve
      </button>
      <button type="button" disabled={busy} onClick={() => decide('reject')}>
        Reject
      </button>
    </section>
  );
}

/**
 * AC-10: resend, with the two decisions the operator actually has.
 *
 * The address is editable because the commonest reason to resend is that the
 * first one was wrong. Regeneration is a separate, explicit choice that
 * defaults to off, because resetting a real person's password is something an
 * operator asks for, never a fallback (REQ-030 AC-4). A CredentialUnavailable
 * refusal is surfaced as itself rather than as a generic failure, since the
 * remedy — tick regenerate — is a different action.
 */
/**
 * REQ-017: the one-time password, surfaced to the person it belongs with.
 *
 * The server enforces everything that matters: requester-only, read-once, the
 * ciphertext destroyed in the transaction that releases the plaintext. What the
 * console owes the operator is honesty about those properties, so the reveal
 * says it will not come back, and a 410 explains itself instead of reading as
 * an outage. The password lives in component state for as long as this view is
 * open and is never written anywhere else.
 */
function CredentialControls({ requestId }: { requestId: string }) {
  const [revealed, setRevealed] = useState<{ primaryEmail: string; password: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function retrieve() {
    setBusy(true);
    setError(null);
    try {
      const res = await retrieveCredential(requestId);
      setRevealed({ primaryEmail: res.primaryEmail, password: res.oneTimePassword });
    } catch (err) {
      if (err instanceof ApiError && err.status === 410) {
        setError(
          'This password is no longer retrievable: it was already retrieved, expired, or was replaced by a regeneration. Use "Resend welcome letter" with "regenerate" ticked to issue a new one.',
        );
      } else if (err instanceof ApiError && err.status === 403) {
        setError('Only the operator who submitted this request may retrieve its password.');
      } else {
        setError('the password could not be retrieved');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-label="one-time password">
      <h3>One-time password</h3>
      {!revealed && !error && (
        <>
          <p>
            Retrievable once, by you alone. Hand it to the account holder through a channel you
            trust; it is never emailed.
          </p>
          <button type="button" disabled={busy} onClick={retrieve}>
            {busy ? 'Retrieving…' : 'Retrieve one-time password'}
          </button>
        </>
      )}
      {revealed && (
        <>
          <p role="status">
            Password for <strong>{revealed.primaryEmail}</strong>:
          </p>
          <p className="credential">
            <code>{revealed.password}</code>
          </p>
          <p role="alert">
            This will not be shown again. It is no longer stored anywhere, so copy it now.
          </p>
        </>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}

/**
 * REQ-012 AC-5: the powers over other people's work. Resume releases a failed
 * request's halted step back to the queue; cancel here reaches ANY request,
 * where the requester's own cancel control reaches only their own. Both are
 * enforced server-side and both write an audit event naming the admin.
 */
function AdminControls({
  requestId,
  status,
  onDone,
}: {
  requestId: string;
  status: string;
  onDone: () => void;
}) {
  const [reason, setReason] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function resume() {
    setError(null);
    try {
      const res = await adminResumeRequest(requestId);
      setNote(
        res.dispatch === 'deferred'
          ? `Resumed at ${res.resumedStep}; the dispatch is deferred and reconciliation will deliver it.`
          : `Resumed at ${res.resumedStep}.`,
      );
      onDone();
    } catch (err) {
      setError(
        err instanceof ApiError
          ? ((err.body as { error?: string })?.error ?? `resume refused (${err.status})`)
          : 'the resume could not be submitted',
      );
    }
  }

  async function cancel() {
    setError(null);
    try {
      const res = await adminCancelRequest(requestId, reason);
      setNote(res.status === 'compensating' ? 'Cancellation accepted; the account is being restored.' : 'Request cancelled.');
      onDone();
    } catch (err) {
      setError(
        err instanceof ApiError
          ? (err.issues[0]?.message ?? (err.body as { error?: string })?.error ?? `cancel refused (${err.status})`)
          : 'the cancellation could not be submitted',
      );
    }
  }

  return (
    <section aria-label="admin actions">
      <h3>Admin actions</h3>
      {status === 'failed' && (
        <button type="button" onClick={resume}>
          Resume from the failed step
        </button>
      )}
      <label htmlFor="admin-cancel-reason">Cancellation reason</label>
      <input
        id="admin-cancel-reason"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
      />
      <button type="button" onClick={cancel}>
        Cancel as admin
      </button>
      {note && <p role="status">{note}</p>}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}

function ResendControls({ detail }: { detail: Detail }) {
  const payload = (detail.request.payload ?? {}) as Record<string, string>;
  const [address, setAddress] = useState('');
  const [regenerate, setRegenerate] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function resend() {
    setError(null);
    setMessage(null);
    try {
      const { requestId } = await submitRequest('notify', {
        primaryEmail: detail.request.targetUser,
        givenName: payload.givenName ?? '',
        familyName: payload.familyName ?? '',
        notificationEmail: address,
        regenerate,
      });
      setMessage(`Resend submitted as ${requestId}`);
    } catch (err) {
      if (err instanceof ApiError) {
        const detailText = JSON.stringify(err.body ?? {});
        setError(
          detailText.includes('credential_unavailable') || detailText.includes('CredentialUnavailable')
            ? 'The original one-time password is no longer retrievable. Tick "regenerate" to issue a new one.'
            : (err.issues[0]?.message ?? `resend refused (${err.status})`),
        );
      } else {
        setError('the resend could not be submitted');
      }
    }
  }

  return (
    <section aria-label="resend welcome letter">
      <h3>Resend welcome letter</h3>
      <label htmlFor="resend-address">Notification address</label>
      <input
        id="resend-address"
        type="email"
        value={address}
        onChange={(e) => setAddress(e.target.value)}
      />
      <label>
        <input
          type="checkbox"
          checked={regenerate}
          onChange={(e) => setRegenerate(e.target.checked)}
        />
        regenerate the password
      </label>
      {message && <p role="status">{message}</p>}
      {error && <p role="alert">{error}</p>}
      <button type="button" onClick={resend}>
        Resend
      </button>
    </section>
  );
}

export function RequestDetailView({ requestId }: { requestId: string }) {
  const { identity } = useIdentity();
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () =>
    getRequest(requestId)
      .then(setDetail)
      .catch(() => setError('could not load this request'));

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestId]);

  if (error) return <p role="alert">{error}</p>;
  if (!detail) return <p role="status">loading…</p>;

  const awaiting = detail.steps.find((s) => s.status === 'awaiting_approval');
  const isCompletedOnboarding =
    detail.request.phase === 'create' && detail.request.status === 'succeeded';
  // The retrieval control appears only for the operator the server would say
  // yes to. Showing it to anyone else would render a button that can only 403.
  const isOwn = identity?.email.toLowerCase() === detail.request.requestedBy;

  return (
    <article aria-label={`request ${requestId}`}>
      <div className="page-head">
        <h2>
          <span className="tag" data-phase={detail.request.phase}>{detail.request.phase}</span>{' '}
          <span className="mono">{detail.request.targetUser}</span>{' '}
          <span className="pill" data-status={detail.request.status}>{detail.request.status}</span>
        </h2>
        <p>
          Status: <strong>{detail.request.status}</strong> · requested by{' '}
          {detail.request.requestedBy}
        </p>
      </div>

      <div className="detail-grid">
        <div>
          <Timeline steps={detail.steps} />
          {detail.request.computedDiff && <DiffView diff={detail.request.computedDiff} />}
        </div>

        <div>
          {awaiting && (
            <Can role="approver">
              <ApprovalControls requestId={requestId} step={awaiting} onDone={load} />
            </Can>
          )}

          {isCompletedOnboarding && (
            <Can role="requester">
              {isOwn && <CredentialControls requestId={requestId} />}
              <ResendControls detail={detail} />
            </Can>
          )}

          <Can role="requester">
            <CancelControl requestId={requestId} onDone={load} />
          </Can>

          <Can role="admin">
            <AdminControls requestId={requestId} status={detail.request.status} onDone={load} />
          </Can>
        </div>
      </div>
    </article>
  );
}

function CancelControl({ requestId, onDone }: { requestId: string; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  async function cancel() {
    setError(null);
    try {
      const res = await cancelRequest(requestId, reason);
      // 'compensating' is not 'cancelled': an offboarding that already
      // suspended the account is being put back, and the request stays in
      // flight until that succeeds (REQ-006 AC-5). Saying "cancelled" here
      // would tell the operator the account is usable when it is not yet.
      setNote(
        res.status === 'compensating'
          ? 'Cancellation accepted. The account is being restored; the request completes when that succeeds.'
          : 'Request cancelled.',
      );
      onDone();
    } catch (err) {
      setError(
        err instanceof ApiError
          ? (err.issues[0]?.message ?? `cancellation refused (${err.status})`)
          : 'the cancellation could not be submitted',
      );
    }
  }

  return (
    <section aria-label="cancel request">
      <label htmlFor="cancel-reason">Cancellation reason</label>
      <input id="cancel-reason" value={reason} onChange={(e) => setReason(e.target.value)} />
      {note && <p role="status">{note}</p>}
      {error && <p role="alert">{error}</p>}
      <button type="button" onClick={cancel}>
        Cancel request
      </button>
    </section>
  );
}
