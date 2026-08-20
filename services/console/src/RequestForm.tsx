import { PHASES, phaseFields, validatePayload, type Phase } from '@lifecycle/schemas';
import { useEffect, useState } from 'react';
import { ApiError, getUser, submitRequest, type UserHit } from './api.js';
import { GroupPicker, OrgUnitPicker, UserPicker } from './pickers.tsx';

/**
 * The phase submission form (REQ-011 AC-1, AC-2, AC-3).
 *
 * AC-1 is the reason this is one component rather than four hand-written forms.
 * The field list comes from `phaseFields`, which introspects the very schema the
 * API validates against, and the client verdict comes from `validatePayload` —
 * the exact function the route calls. Client and server therefore reject the
 * same payloads because they are running the same code, not because two
 * implementations were kept in agreement.
 *
 * The pickers replace free text for the three things that must exist in the
 * domain: the target user, the groups, the org unit (AC-2, AC-3).
 *
 * Client validation is a courtesy, never a gate. The submission goes to the
 * server regardless of what this thinks, and a server 400 is rendered as the
 * authority (see AC-7's equivalent on the approval path).
 */

/** Fields the pickers own, so the generic renderer leaves them alone. */
const PICKER_FIELDS = new Set([
  'primaryEmail',
  'orgUnitPath',
  'groups',
  'addGroups',
  'removeGroups',
]);

type Values = Record<string, unknown>;

function labelFor(name: string): string {
  return name
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, (c) => c.toUpperCase())
    .trim();
}

export function RequestForm({ onSubmitted }: { onSubmitted?: (requestId: string) => void }) {
  const [phase, setPhase] = useState<Phase>('create');
  const [values, setValues] = useState<Values>({});
  const [target, setTarget] = useState('');
  const [issues, setIssues] = useState<{ path: string; message: string }[]>([]);
  const [serverError, setServerError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const fields = phaseFields(phase);

  // Switching phase discards the payload: the phases do not share a shape, and
  // carrying values across would submit fields the new phase refuses.
  useEffect(() => {
    setValues({});
    setTarget('');
    setIssues([]);
    setServerError(null);
  }, [phase]);

  const set = (name: string, value: unknown) =>
    setValues((v) => ({ ...v, [name]: value }));

  /**
   * AC-2: selecting a user on an update pre-fills from live state, so the
   * operator edits what the account currently holds rather than retyping it.
   */
  async function selectUser(user: UserHit) {
    setTarget(user.primaryEmail);
    set('primaryEmail', user.primaryEmail);

    if (phase !== 'update') return;
    try {
      const detail = await getUser(user.primaryEmail);
      setValues((v) => ({
        ...v,
        primaryEmail: detail.primaryEmail,
        givenName: detail.givenName,
        familyName: detail.familyName,
        ...(detail.title === null ? {} : { title: detail.title }),
        ...(detail.department === null ? {} : { department: detail.department }),
        ...(detail.managerEmail === null ? {} : { managerEmail: detail.managerEmail }),
        orgUnitPath: detail.orgUnitPath,
      }));
    } catch {
      setServerError('could not pre-fill from the directory; the fields are editable');
    }
  }

  /** Drops empty strings so an untouched optional field is absent, not blank. */
  function payload(): Values {
    const out: Values = {};
    for (const [k, v] of Object.entries(values)) {
      if (v === '' || v === undefined) continue;
      if (Array.isArray(v) && v.length === 0) continue;
      out[k] = v;
    }
    return out;
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setServerError(null);

    // AC-1: the API's own validator, not a copy of its rules.
    const verdict = validatePayload(phase, payload());
    if (!verdict.ok) {
      setIssues(verdict.issues);
      return;
    }
    setIssues([]);

    setSubmitting(true);
    try {
      const { requestId } = await submitRequest(phase, payload());
      onSubmitted?.(requestId);
      setValues({});
      setTarget('');
    } catch (err) {
      if (err instanceof ApiError) {
        // The server is the authority. Its issues replace ours.
        setIssues(err.issues);
        setServerError(
          err.status === 409
            ? ((err.body as { message?: string })?.message ?? 'refused: conflicting or protected')
            : `submission refused (${err.status})`,
        );
      } else {
        setServerError('submission failed');
      }
    } finally {
      setSubmitting(false);
    }
  }

  const issueFor = (name: string) => issues.find((i) => i.path === name)?.message;

  return (
    <>
      <div className="page-head">
        <h2>New request</h2>
        <p>Pick a phase, then choose targets from the live directory. Every field is validated again on submit.</p>
      </div>

      <form onSubmit={submit} aria-label="new request">
      <label htmlFor="phase">Phase</label>
      <select id="phase" value={phase} onChange={(e) => setPhase(e.target.value as Phase)}>
        {PHASES.map((p) => (
          <option key={p} value={p}>
            {p}
          </option>
        ))}
      </select>

      {phase === 'create' ? (
        /* The one phase whose target must NOT exist. The picker can only emit
           accounts the directory already holds, which the create phase must
           refuse, so offering it here made creation impossible by construction.
           A typed address is safe: the schema validates its shape on submit and
           validate-request checks live Workspace state before create-user runs,
           so a typo becomes a refused request rather than a broken account. */
        <div className="field">
          <label htmlFor="new-account-email">New account email *</label>
          <input
            id="new-account-email"
            type="email"
            autoComplete="off"
            placeholder="new.starter@yourdomain.com"
            value={(values.primaryEmail as string) ?? ''}
            onChange={(e) => {
              setTarget(e.target.value);
              set('primaryEmail', e.target.value);
            }}
          />
        </div>
      ) : (
        <UserPicker value={target} onSelect={selectUser} />
      )}
      {issueFor('primaryEmail') && <p role="alert">{issueFor('primaryEmail')}</p>}

      {fields
        .filter((f) => !PICKER_FIELDS.has(f.name))
        .map((f) => (
          <div key={f.name} className="field">
            <label htmlFor={f.name}>
              {labelFor(f.name)}
              {f.required ? ' *' : ''}
            </label>

            {f.kind === 'boolean' ? (
              <input
                id={f.name}
                type="checkbox"
                checked={values[f.name] === true}
                onChange={(e) => set(f.name, e.target.checked)}
              />
            ) : (
              <input
                id={f.name}
                type={f.kind === 'number' ? 'number' : 'text'}
                value={
                  values[f.name] === null ? '' : ((values[f.name] as string | number | undefined) ?? '')
                }
                onChange={(e) =>
                  set(f.name, f.kind === 'number'
                    ? (e.target.value === '' ? '' : Number(e.target.value))
                    : e.target.value)
                }
              />
            )}

            {/* A nullable field can be CLEARED, which is different from leaving
                it alone. Without this control the operator has no way to say
                "remove this person's manager" (REQ-005). */}
            {f.nullable && (
              <label className="clear">
                <input
                  type="checkbox"
                  checked={values[f.name] === null}
                  onChange={(e) => set(f.name, e.target.checked ? null : '')}
                />
                clear
              </label>
            )}

            {issueFor(f.name) && <p role="alert">{issueFor(f.name)}</p>}
          </div>
        ))}

      {fields.some((f) => f.name === 'orgUnitPath') && (
        <OrgUnitPicker
          value={(values.orgUnitPath as string) ?? ''}
          onChange={(p) => set('orgUnitPath', p)}
        />
      )}

      {fields.some((f) => f.name === 'groups') && (
        <GroupPicker
          label="Groups"
          selected={(values.groups as string[]) ?? []}
          onChange={(g) => set('groups', g)}
        />
      )}
      {fields.some((f) => f.name === 'addGroups') && (
        <>
          <GroupPicker
            label="Add to groups"
            selected={(values.addGroups as string[]) ?? []}
            onChange={(g) => set('addGroups', g)}
          />
          <GroupPicker
            label="Remove from groups"
            selected={(values.removeGroups as string[]) ?? []}
            onChange={(g) => set('removeGroups', g)}
          />
        </>
      )}

      {issues
        .filter((i) => i.path === '(root)' || !fields.some((f) => f.name === i.path))
        .map((i) => (
          <p key={`${i.path}:${i.message}`} role="alert">
            {i.message}
          </p>
        ))}
      {serverError && <p role="alert">{serverError}</p>}

      <button type="submit" disabled={submitting}>
        {submitting ? 'Submitting…' : 'Submit request'}
      </button>
      </form>
    </>
  );
}
