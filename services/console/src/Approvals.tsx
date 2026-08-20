import { useEffect, useState } from 'react';
import { getApprovals, type InboxEntry } from './api.js';

/**
 * The approvals inbox (REQ-011 AC-6).
 *
 * The server decides what belongs here — it excludes the operator's own
 * requests and anything whose required role they do not hold — and this does
 * not filter again. A second filter on the client would be a second place for
 * the rule to live, and the two would eventually disagree about who may
 * approve what.
 */
export function Approvals({ onOpen }: { onOpen: (requestId: string) => void }) {
  const [entries, setEntries] = useState<InboxEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    getApprovals()
      .then((r) => setEntries(r.approvals))
      .catch(() => setError('could not load the approvals inbox'))
      .finally(() => setLoaded(true));
  }, []);

  if (error) return <p role="alert">{error}</p>;

  return (
    <section aria-label="approvals inbox">
      <div className="page-head">
        <h2>Awaiting your approval</h2>
        <p>Requests paused for a decision only you can make. Your own requests never appear here.</p>
      </div>
      {loaded && entries.length === 0 && <p role="status">Nothing is waiting on you.</p>}
      <ul className="inbox">
        {entries.map((e) => (
          <li key={`${e.requestId}:${e.step.stepId}`}>
            <button type="button" onClick={() => onOpen(e.requestId)}>
              <span className="tag" data-phase={e.phase}>{e.phase}</span>{' '}
              <span className="mono">{e.targetUser}</span> · {e.step.name} (needs {e.step.requiredRole})
            </button>
            <span> requested by {e.requestedBy}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
