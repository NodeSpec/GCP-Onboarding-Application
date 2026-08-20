import { PHASES, type Phase } from '@lifecycle/schemas';
import { useEffect, useState } from 'react';
import { listRequests, type RequestStatus, type RequestSummary } from './api.js';

/**
 * The request list (REQ-011 AC-4).
 *
 * Every filter and the paging are query parameters, answered by Firestore. The
 * console holds one page at a time and a cursor stack; it never fetches the
 * collection to filter it here, which would work for a demo tenant and fall
 * over on one with real history.
 */

const STATUSES: RequestStatus[] = [
  'draft', 'running', 'awaiting_approval', 'held',
  'succeeded', 'failed', 'rejected', 'cancelled',
];

export function RequestList({ onOpen }: { onOpen: (requestId: string) => void }) {
  const [phase, setPhase] = useState<Phase | ''>('');
  const [status, setStatus] = useState<RequestStatus | ''>('');
  const [targetUser, setTargetUser] = useState('');
  const [rows, setRows] = useState<RequestSummary[]>([]);
  const [next, setNext] = useState<string | null>(null);
  // A stack, so "previous" is exact rather than a re-query that can drift.
  const [history, setHistory] = useState<(string | null)[]>([]);
  const [error, setError] = useState<string | null>(null);

  function load(cursor: string | null) {
    listRequests({ phase, status, targetUser, cursor })
      .then((page) => {
        setRows(page.requests);
        setNext(page.nextCursor);
        setError(null);
      })
      .catch(() => setError('could not load requests'));
  }

  // Changing a filter restarts paging: a cursor from the old filter set points
  // into a different ordering and would silently skip rows.
  useEffect(() => {
    setHistory([]);
    load(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, status, targetUser]);

  return (
    <section aria-label="requests">
      <div className="page-head">
        <h2>Requests</h2>
        <p>Every lifecycle action across the tenant, newest first.</p>
      </div>

      <div className="filters">
        <label htmlFor="filter-phase">Phase</label>
        <select id="filter-phase" value={phase} onChange={(e) => setPhase(e.target.value as Phase | '')}>
          <option value="">all</option>
          {PHASES.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>

        <label htmlFor="filter-status">Status</label>
        <select id="filter-status" value={status} onChange={(e) => setStatus(e.target.value as RequestStatus | '')}>
          <option value="">all</option>
          {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>

        <label htmlFor="filter-target">Target user</label>
        <input id="filter-target" value={targetUser} onChange={(e) => setTargetUser(e.target.value)} />
      </div>

      {error && <p role="alert">{error}</p>}

      <div className="table-card">
        <table>
          <thead>
            <tr><th>Phase</th><th>Target</th><th>Status</th><th>Requested by</th><th /></tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.requestId}>
                <td><span className="tag" data-phase={r.phase}>{r.phase}</span></td>
                <td>{r.targetUser}</td>
                <td><span className="pill" data-status={r.status}>{r.status}</span></td>
                <td>{r.requestedBy}</td>
                <td>
                  <button type="button" onClick={() => onOpen(r.requestId)}>open</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length === 0 && !error && <p role="status">No requests match these filters.</p>}

      <div className="paging">
        <button
          type="button"
          disabled={history.length === 0}
          onClick={() => {
            const prev = [...history];
            const cursor = prev.pop() ?? null;
            setHistory(prev);
            load(cursor);
          }}
        >
          Previous
        </button>
        <button
          type="button"
          disabled={next === null}
          onClick={() => {
            setHistory((h) => [...h, rows.length > 0 ? (history[history.length - 1] ?? null) : null]);
            load(next);
          }}
        >
          Next
        </button>
      </div>
    </section>
  );
}
