import { useEffect, useState } from 'react';
import {
  ApiError,
  deleteRoleBinding,
  getApprovalPolicy,
  listAudit,
  listRoleBindings,
  putApprovalPolicy,
  putRoleBinding,
  type ApprovalPolicyDoc,
  type AuditRow,
  type OperatorRole,
  type RoleBindingRow,
} from './api.js';

/**
 * The admin surface (REQ-012 AC-5): role bindings, the approval policy, and
 * the full audit trail. These routes existed from the first deployment; this
 * view is what makes them reachable without hand-writing Firestore documents,
 * which is how the first requester of every deployment had to be granted.
 *
 * Everything here is presentation over admin-only routes. Rendering is gated
 * by <Can role="admin"> in the shell, and every call is refused server-side
 * without the role, so nothing in this file is load-bearing for security
 * (AC-8, AC-11).
 */

const ROLES: OperatorRole[] = ['requester', 'approver', 'admin'];

/**
 * Grant-or-edit plus the list, in one place.
 *
 * PUT replaces the whole role set, so the form always states the complete
 * intended roles rather than a delta. An empty selection is refused client-side
 * with the same rule the server enforces: removal is the Delete button, and
 * letting an empty save mean "remove" would make an accidental submit strip
 * someone's access.
 */
function RoleBindings() {
  const [bindings, setBindings] = useState<RoleBindingRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const [subject, setSubject] = useState('');
  const [kind, setKind] = useState<'user' | 'group'>('user');
  const [roles, setRoles] = useState<OperatorRole[]>([]);

  const load = () =>
    listRoleBindings()
      .then((r) => setBindings(r.bindings))
      .catch(() => setError('could not load role bindings'));

  useEffect(() => {
    void load();
  }, []);

  const toggleRole = (role: OperatorRole) =>
    setRoles((r) => (r.includes(role) ? r.filter((x) => x !== role) : [...r, role]));

  async function save() {
    setError(null);
    setNote(null);
    if (roles.length === 0) {
      setError('select at least one role; removing a binding is the Delete button');
      return;
    }
    try {
      const res = await putRoleBinding(subject.trim().toLowerCase(), kind, roles);
      setNote(
        res.previousRoles === null
          ? `Granted ${res.roles.join(', ')} to ${res.subject}.`
          : `Changed ${res.subject} from ${res.previousRoles.join(', ')} to ${res.roles.join(', ')}.`,
      );
      setSubject('');
      setRoles([]);
      await load();
    } catch (err) {
      setError(
        err instanceof ApiError
          ? (err.issues[0]?.message ?? (err.body as { message?: string })?.message ?? `refused (${err.status})`)
          : 'the binding could not be saved',
      );
    }
  }

  async function remove(target: string) {
    setError(null);
    setNote(null);
    try {
      const res = await deleteRoleBinding(target);
      setNote(`Removed ${target}, which held ${res.previousRoles.join(', ')}.`);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? `removal refused (${err.status})` : 'the removal failed');
    }
  }

  return (
    <section aria-label="role bindings">
      <h3>Role bindings</h3>
      <p>
        Who may do what, keyed on the verified email. A <em>group</em> binding grants its roles to
        every member of that Google group. Every change here is audited with the roles before and
        after.
      </p>

      <table>
        <thead>
          <tr>
            <th>Subject</th>
            <th>Kind</th>
            <th>Roles</th>
            <th>Last changed by</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {bindings.map((b) => (
            <tr key={b.subject}>
              <td>{b.subject}</td>
              <td>{b.kind}</td>
              <td>{b.roles.join(', ')}</td>
              <td>{b.updatedBy}</td>
              <td>
                <button
                  type="button"
                  onClick={() => {
                    setSubject(b.subject);
                    setKind(b.kind);
                    setRoles(b.roles);
                  }}
                >
                  Edit
                </button>
                <button type="button" onClick={() => remove(b.subject)}>
                  Delete
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {bindings.length === 0 && !error && (
        <p role="status">
          No bindings yet. Bootstrap admins come from configuration; everyone else starts here.
        </p>
      )}

      <div className="field">
        <label htmlFor="binding-subject">Subject email</label>
        <input
          id="binding-subject"
          type="email"
          autoComplete="off"
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
        />
        <label htmlFor="binding-kind">Kind</label>
        <select
          id="binding-kind"
          value={kind}
          onChange={(e) => setKind(e.target.value as 'user' | 'group')}
        >
          <option value="user">user</option>
          <option value="group">group</option>
        </select>
        <fieldset>
          <legend>Roles</legend>
          {ROLES.map((role) => (
            <label key={role}>
              <input
                type="checkbox"
                checked={roles.includes(role)}
                onChange={() => toggleRole(role)}
              />
              {role}
            </label>
          ))}
        </fieldset>
        <button type="button" onClick={save}>
          Save binding
        </button>
      </div>

      {note && <p role="status">{note}</p>}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}

/**
 * Shown when no policy document exists. All four phases must be present in a
 * saved policy, and the delete-user floor is stated rather than left implicit:
 * the server enforces approval on delete-user regardless, so a template that
 * omitted it would look more permissive than the system actually is.
 */
const POLICY_TEMPLATE: ApprovalPolicyDoc = {
  create: {},
  notify: {},
  update: {},
  delete: {
    'delete-user': { requiresApproval: true, approverRole: 'admin' },
  },
};

/**
 * The policy is edited as the JSON document the server validates, not through
 * a per-knob form. The document is small, its schema is strict, and the
 * server's field-level issues render verbatim, so the JSON is the honest
 * interface; a form would be a second implementation of the schema that could
 * drift from it. docs/approval-policy.md documents every knob with examples.
 */
function ApprovalPolicyEditor() {
  const [text, setText] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [empty, setEmpty] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [issues, setIssues] = useState<{ path: string; message: string }[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getApprovalPolicy()
      .then((r) => {
        setEmpty(r.policy === null);
        setText(JSON.stringify(r.policy ?? POLICY_TEMPLATE, null, 2));
        setLoaded(true);
      })
      .catch(() => setError('could not load the approval policy'));
  }, []);

  async function save() {
    setError(null);
    setNote(null);
    setIssues([]);

    let parsed: ApprovalPolicyDoc;
    try {
      parsed = JSON.parse(text) as ApprovalPolicyDoc;
    } catch {
      setError('this is not valid JSON');
      return;
    }

    try {
      const res = await putApprovalPolicy(parsed);
      setEmpty(false);
      setText(JSON.stringify(res.policy, null, 2));
      // The server says it, the console repeats it: in-flight requests keep
      // the snapshot they were created with (REQ-002 AC-6).
      setNote(`Saved. Applies to ${res.appliesTo}`);
    } catch (err) {
      if (err instanceof ApiError) {
        setIssues(err.issues);
        setError(`the server refused the policy (${err.status})`);
      } else {
        setError('the policy could not be saved');
      }
    }
  }

  return (
    <section aria-label="approval policy">
      <h3>Approval policy</h3>
      {empty && (
        <p role="status">
          No policy is stored. The system is running on its built-in default, which gates the
          destructive steps; the editor below is pre-filled with a template stating that default
          explicitly. See docs/approval-policy.md for every knob.
        </p>
      )}
      {loaded && (
        <>
          <label htmlFor="policy-json">Policy document</label>
          <textarea
            id="policy-json"
            rows={16}
            value={text}
            onChange={(e) => setText(e.target.value)}
            spellCheck={false}
          />
          <button type="button" onClick={save}>
            Save policy
          </button>
        </>
      )}
      {issues.map((i) => (
        <p key={`${i.path}:${i.message}`} role="alert">
          {i.path}: {i.message}
        </p>
      ))}
      {note && <p role="status">{note}</p>}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}

/** The whole trail, newest first, paged by the cursor the server issues. */
function AuditTrail() {
  const [events, setEvents] = useState<AuditRow[]>([]);
  const [nextBefore, setNextBefore] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadPage = (before?: number) =>
    listAudit(before === undefined ? { limit: 50 } : { limit: 50, before })
      .then((r) => {
        setEvents((prev) => (before === undefined ? r.events : [...prev, ...r.events]));
        setNextBefore(r.events.length === 0 ? null : r.nextBefore);
      })
      .catch(() => setError('could not load the audit trail'));

  useEffect(() => {
    void loadPage();
  }, []);

  return (
    <section aria-label="audit trail">
      <h3>Audit trail</h3>
      <table>
        <thead>
          <tr>
            <th>When</th>
            <th>Action</th>
            <th>Actor</th>
            <th>Target</th>
            <th>Request</th>
            <th>Outcome</th>
          </tr>
        </thead>
        <tbody>
          {events.map((e) => (
            <tr key={e.eventId}>
              <td>{e.timestamp.replace('T', ' ').slice(0, 19)}</td>
              <td>{e.action}</td>
              <td>{e.actor.email}</td>
              <td>{e.targetUser ?? '—'}</td>
              <td>{e.requestId ?? '—'}</td>
              <td data-status={e.outcome === 'success' ? undefined : 'failed'}>{e.outcome}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {events.length === 0 && !error && <p role="status">No audit events yet.</p>}
      {nextBefore !== null && (
        <button type="button" onClick={() => loadPage(nextBefore)}>
          Load older events
        </button>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}

export function AdminView() {
  return (
    <div aria-label="administration">
      <h2>Administration</h2>
      <RoleBindings />
      <ApprovalPolicyEditor />
      <AuditTrail />
    </div>
  );
}
