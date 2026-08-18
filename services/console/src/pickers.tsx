import { useEffect, useState } from 'react';
import { listGroups, listOrgUnits, searchUsers, type UserHit } from './api.js';

/**
 * The directory pickers (REQ-011 AC-2, AC-3).
 *
 * Every one of these is backed by REQ-029's lookup surface rather than a text
 * box. The reason is not convenience: a typed address or group name is only
 * validated when the worker executes, so a typo becomes a request that fails
 * minutes later against a real account. Choosing from what the domain actually
 * contains removes that class of failure at the point of entry.
 *
 * These are still not authoritative. The executing step re-reads live state
 * (REQ-029 AC-9), because anything shown here is already stale by the time the
 * operator submits.
 */

/** AC-2: the target user is chosen, not typed. */
export function UserPicker({
  value,
  onSelect,
  label = 'Target user',
}: {
  value: string;
  onSelect: (user: UserHit) => void;
  label?: string;
}) {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<UserHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const term = query.trim();
    if (term.length < 2) {
      setHits([]);
      return;
    }

    // Debounced: the lookup is a Workspace round trip, and one per keystroke
    // would be both slow and rude to the Directory API's quota.
    let live = true;
    const timer = setTimeout(() => {
      setSearching(true);
      searchUsers(term)
        .then((r) => live && setHits(r.users))
        .catch(() => live && setError('directory lookup is unavailable'))
        .finally(() => live && setSearching(false));
    }, 250);

    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [query]);

  return (
    <div className="picker">
      <label htmlFor="user-search">{label}</label>
      <input
        id="user-search"
        type="search"
        autoComplete="off"
        placeholder="search the directory"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {value && <p className="picked">Selected: {value}</p>}
      {searching && <p role="status">searching…</p>}
      {error && <p role="alert">{error}</p>}
      <ul aria-label="user results">
        {hits.map((u) => (
          <li key={u.primaryEmail}>
            <button
              type="button"
              onClick={() => {
                onSelect(u);
                setQuery('');
                setHits([]);
              }}
            >
              {u.primaryEmail}
              {u.fullName ? ` — ${u.fullName}` : ''}
              {u.suspended ? ' (suspended)' : ''}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** AC-3: groups come from the domain, so an invalid one cannot be submitted. */
export function GroupPicker({
  label,
  selected,
  onChange,
}: {
  label: string;
  selected: string[];
  onChange: (groups: string[]) => void;
}) {
  const [groups, setGroups] = useState<{ email: string; name: string }[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listGroups()
      .then((r) => setGroups(r.groups))
      .catch(() => setError('group lookup is unavailable'));
  }, []);

  const toggle = (email: string) =>
    onChange(selected.includes(email) ? selected.filter((g) => g !== email) : [...selected, email]);

  return (
    <fieldset className="picker">
      <legend>{label}</legend>
      {error && <p role="alert">{error}</p>}
      {groups.map((g) => (
        <label key={g.email}>
          <input
            type="checkbox"
            checked={selected.includes(g.email)}
            onChange={() => toggle(g.email)}
          />
          {g.email}
        </label>
      ))}
    </fieldset>
  );
}

/** AC-3: the org unit is chosen from the tree that exists. */
export function OrgUnitPicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (path: string) => void;
}) {
  const [units, setUnits] = useState<{ orgUnitPath: string; name: string }[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listOrgUnits()
      .then((r) => setUnits(r.orgUnits))
      .catch(() => setError('org unit lookup is unavailable'));
  }, []);

  return (
    <div className="picker">
      <label htmlFor="org-unit">Org unit</label>
      {error && <p role="alert">{error}</p>}
      <select id="org-unit" value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">(domain root)</option>
        {units.map((u) => (
          <option key={u.orgUnitPath} value={u.orgUnitPath}>
            {u.orgUnitPath}
          </option>
        ))}
      </select>
    </div>
  );
}
