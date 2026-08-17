import { Timestamp } from '@google-cloud/firestore';
import type {
  AttributeChange,
  GroupChange,
  UpdatableAttribute,
  UpdateDiff,
} from '@lifecycle/shared';
import { UserNotFoundError, WorkspaceError } from '../workspace/directoryClient.js';
import { registerHandler, type StepContext, type StepResult } from '../steps/handler.js';

/**
 * Phase 3: change an existing user's attributes, org unit, and group
 * memberships (REQ-005).
 *
 * The shape that matters here is compute-then-apply. The operator submits a
 * desired state; a diff step resolves that against the live account and freezes
 * the result on the request; the apply steps read the frozen diff rather than
 * recomputing. That ordering is what makes the approval meaningful: an approver
 * looks at a concrete change set, and what executes is that change set, not
 * whatever the account happens to look like by the time the step runs.
 *
 * Applying still reads live state first, as every handler here does, so a
 * redelivered task or an account someone else already moved resolves to
 * 'skipped' rather than a redundant write (REQ-013). The frozen diff decides
 * WHAT to change; the live read decides WHETHER it is still needed.
 *
 * On "role": this phase changes group memberships and the attributes that
 * describe a job. It does not touch Workspace ADMIN roles, and nothing in this
 * codebase does. That is a deliberate boundary, recorded on the requirement and
 * enforced by the absent scope rather than by convention (AC-9).
 */

/** The attribute fields this phase can change, in the order a diff lists them. */
const UPDATABLE: readonly UpdatableAttribute[] = [
  'givenName',
  'familyName',
  'title',
  'department',
  'managerEmail',
  'orgUnitPath',
];

interface UpdatePayload {
  primaryEmail: string;
  givenName?: string;
  familyName?: string;
  title?: string | null;
  department?: string | null;
  managerEmail?: string | null;
  orgUnitPath?: string;
  addGroups?: string[];
  removeGroups?: string[];
}

function payloadOf(ctx: StepContext): UpdatePayload {
  return ctx.request.payload as unknown as UpdatePayload;
}

/**
 * The Workspace user, described by what this phase reads and writes rather than
 * imported from the Directory typings.
 *
 * Two reasons, and the first is enforced by a test. No phase handler may reach
 * the Google API client package at all: the Directory client is the single
 * construction site for Workspace access, and a handler that imports the SDK
 * is one edit away from building its own client (REQ-008 AC-6).
 *
 * The second is that the generated types leave organizations and relations as
 * loose arrays, so a misspelled key inside one compiles and silently does
 * nothing. Naming the fields is the difference between a typo failing the build
 * and a title update that quietly never applies.
 */
interface Organization {
  title?: string | null;
  department?: string | null;
  primary?: boolean | null;
  [key: string]: unknown;
}

interface Relation {
  value?: string | null;
  type?: string | null;
  [key: string]: unknown;
}

interface LiveUser {
  name?: { givenName?: string | null; familyName?: string | null } | null;
  orgUnitPath?: string | null;
  suspended?: boolean | null;
  organizations?: Organization[] | null;
  relations?: Relation[] | null;
}

/** The fields an attribute patch may carry. Nothing else is ever sent. */
interface UserPatch {
  name?: { givenName: string | null; familyName: string | null };
  orgUnitPath?: string;
  organizations?: Organization[];
  relations?: Relation[];
}

function relationsOf(user: LiveUser): Relation[] {
  return user.relations ?? [];
}

/**
 * Reads one attribute off a live Workspace user.
 *
 * Normalises absent to null so that "no title" has a single representation. The
 * Directory API can express it as undefined, as a missing organizations entry,
 * or as an empty string depending on how the account was last written, and a
 * diff that treated those as different values would report changes nobody
 * asked for.
 */
function liveValue(user: LiveUser, field: UpdatableAttribute): string | null {
  const organization = user.organizations?.[0] ?? {};
  const manager = relationsOf(user).find((relation) => relation.type === 'manager');

  const raw =
    field === 'givenName'
      ? user.name?.givenName
      : field === 'familyName'
        ? user.name?.familyName
        : field === 'orgUnitPath'
          ? user.orgUnitPath
          : field === 'title'
            ? organization.title
            : field === 'department'
              ? organization.department
              : manager?.value;

  return raw === undefined || raw === null || raw === '' ? null : raw;
}

/**
 * Resolves the submitted payload against the live account.
 *
 * Every requested field appears in the result, including the ones that turn out
 * to match already: an approver needs to see what was asked for, not only what
 * survived (AC-2).
 */
export function computeDiff(
  payload: UpdatePayload,
  user: LiveUser,
  memberships: Map<string, boolean>,
): Omit<UpdateDiff, 'computedAt'> {
  const attributes: AttributeChange[] = [];
  for (const field of UPDATABLE) {
    const requested = payload[field];
    if (requested === undefined) continue;

    const before = liveValue(user, field);
    const after = requested === null ? null : requested;
    attributes.push({ field, before, after, changed: before !== after });
  }

  const groups: GroupChange[] = [];
  for (const groupKey of payload.addGroups ?? []) {
    const before = memberships.get(groupKey) === true;
    groups.push({ groupKey, operation: 'add', before, after: true, changed: !before });
  }
  for (const groupKey of payload.removeGroups ?? []) {
    const before = memberships.get(groupKey) === true;
    groups.push({ groupKey, operation: 'remove', before, after: false, changed: before });
  }

  return { targetUser: payload.primaryEmail, attributes, groups };
}

/**
 * Refuses a request whose target is not in the domain, before anything is
 * mutated (AC-8).
 *
 * Suspended accounts are deliberately NOT refused. A suspended user is still a
 * user, and moving one between org units or groups while it is suspended is a
 * normal part of a leaver-then-returner flow. What is refused is an account
 * that is gone, which is what a deleted user looks like from here.
 */
registerHandler({
  name: 'validate-update-request',
  async execute(ctx: StepContext): Promise<StepResult> {
    const payload = payloadOf(ctx);
    const user = await ctx.directory.getUser(payload.primaryEmail);

    if (!user) {
      throw new UserNotFoundError(payload.primaryEmail, 'validate-update-request');
    }

    return {
      status: 'succeeded',
      output: { validated: payload.primaryEmail, suspended: user.suspended === true },
    };
  },
});

/**
 * Computes the change set against live state and freezes it on the request
 * (AC-1).
 *
 * Reads memberships one group at a time rather than listing every group the
 * user belongs to. Listing would be one call instead of N, but it returns the
 * user's whole membership graph, and a request that asks about two groups has
 * no business reading the other forty.
 */
registerHandler({
  name: 'compute-update-diff',
  async execute(ctx: StepContext): Promise<StepResult> {
    const payload = payloadOf(ctx);
    const user = await ctx.directory.getUser(payload.primaryEmail);
    if (!user) {
      throw new UserNotFoundError(payload.primaryEmail, 'compute-update-diff');
    }

    const requestedGroups = [...new Set([...(payload.addGroups ?? []), ...(payload.removeGroups ?? [])])];
    const memberships = new Map<string, boolean>();
    for (const groupKey of requestedGroups) {
      memberships.set(groupKey, await ctx.directory.hasMember(groupKey, payload.primaryEmail));
    }

    const diff: UpdateDiff = {
      ...computeDiff(payload, user, memberships),
      computedAt: Timestamp.now(),
    };

    await ctx.store.recordComputedDiff({
      requestId: ctx.request.requestId,
      stepId: ctx.step.stepId,
      diff,
      actor: { kind: 'system', email: 'lifecycle-worker', onBehalfOf: ctx.request.requestedBy },
    });

    return {
      status: 'succeeded',
      output: {
        attributesChanging: diff.attributes.filter((a) => a.changed).length,
        groupsChanging: diff.groups.filter((g) => g.changed).length,
        requested: diff.attributes.length + diff.groups.length,
      },
    };
  },
});

/** The frozen diff, or a terminal failure if the diff step did not run. */
function requireDiff(ctx: StepContext): UpdateDiff {
  const diff = ctx.request.computedDiff;
  if (!diff) {
    // Not retryable: the plan puts compute-update-diff ahead of every apply
    // step, so reaching one without a diff means the plan itself is wrong.
    throw new WorkspaceError(
      `Request ${ctx.request.requestId} has no computed diff; the update plan is out of order`,
      'terminal',
      500,
      ctx.step.name,
    );
  }
  return diff;
}

/**
 * Applies the attribute half of the diff in one patch (AC-3, AC-4).
 *
 * One call rather than one per field, because Workspace applies a patch
 * atomically and six separate calls would leave the account half-updated if the
 * fourth failed.
 *
 * The patch is built from live state merged with the approved values, not from
 * the diff alone. `organizations` and `relations` are whole-array fields even
 * under patch semantics, so sending only the changed title would drop the
 * department sitting beside it.
 */
registerHandler({
  name: 'apply-update-attributes',
  async execute(ctx: StepContext): Promise<StepResult> {
    const payload = payloadOf(ctx);
    const diff = requireDiff(ctx);

    const user = await ctx.directory.getUser(payload.primaryEmail);
    if (!user) {
      throw new UserNotFoundError(payload.primaryEmail, 'apply-update-attributes');
    }

    // Re-resolved against the account as it stands now, not as it stood when
    // the diff was computed. The diff decides which fields were approved for
    // change; this decides whether they still need changing (REQ-013 AC-1).
    const outstanding = diff.attributes.filter(
      (change) => change.changed && liveValue(user, change.field) !== change.after,
    );

    if (outstanding.length === 0) {
      return {
        status: 'skipped',
        output: { reason: 'every requested attribute already matches live state' },
      };
    }

    const patch: UserPatch = {};
    const wanted = (field: UpdatableAttribute) =>
      outstanding.find((change) => change.field === field);

    const givenName = wanted('givenName');
    const familyName = wanted('familyName');
    if (givenName || familyName) {
      // Both halves are always sent: name is a whole-object field, so patching
      // only the given name would drop the family name.
      patch.name = {
        givenName: givenName ? givenName.after : (user.name?.givenName ?? null),
        familyName: familyName ? familyName.after : (user.name?.familyName ?? null),
      };
    }

    const orgUnitPath = wanted('orgUnitPath');
    if (orgUnitPath && orgUnitPath.after !== null) patch.orgUnitPath = orgUnitPath.after;

    const title = wanted('title');
    const department = wanted('department');
    if (title || department) {
      // Merged onto the live entry so the field NOT being changed survives.
      const current = user.organizations?.[0] ?? {};
      patch.organizations = [
        {
          ...current,
          primary: true,
          title: title ? title.after : (current.title ?? null),
          department: department ? department.after : (current.department ?? null),
        },
      ];
    }

    const managerEmail = wanted('managerEmail');
    if (managerEmail) {
      // Every relation that is not the manager is carried across untouched;
      // clearing the manager drops just that entry.
      const others = relationsOf(user).filter((relation) => relation.type !== 'manager');
      patch.relations =
        managerEmail.after === null
          ? others
          : [...others, { value: managerEmail.after, type: 'manager' }];
    }

    await ctx.directory.patchUser(payload.primaryEmail, patch);

    return {
      status: 'succeeded',
      output: {
        applied: outstanding.map((change) => change.field),
        fields: Object.keys(patch),
      },
    };
  },
});

/** The group this step owns, named on its input so a failure identifies it. */
function groupKeyOf(ctx: StepContext): string {
  const groupKey = ctx.step.input.groupKey as string | undefined;
  if (!groupKey) {
    throw new WorkspaceError(
      `${ctx.step.name} step has no groupKey on its input`,
      'terminal',
      400,
      ctx.step.name,
    );
  }
  return groupKey;
}

/**
 * Adds one membership. Already a member is success, not an error: the intended
 * state holds and a second insert would be a redundant write (AC-5).
 */
registerHandler({
  name: 'add-group',
  async execute(ctx: StepContext): Promise<StepResult> {
    const payload = payloadOf(ctx);
    const groupKey = groupKeyOf(ctx);

    if (await ctx.directory.hasMember(groupKey, payload.primaryEmail)) {
      return { status: 'skipped', output: { group: groupKey, reason: 'already a member' } };
    }

    await ctx.directory.addMember(groupKey, payload.primaryEmail);
    return { status: 'succeeded', output: { group: groupKey, operation: 'add' } };
  },
});

/**
 * Removes one membership. Removing a membership the user does not have is
 * already satisfied, so it skips rather than failing (AC-6). Treating it as an
 * error would make an offboarding fail because part of it had already been done
 * by hand.
 */
registerHandler({
  name: 'remove-group',
  async execute(ctx: StepContext): Promise<StepResult> {
    const payload = payloadOf(ctx);
    const groupKey = groupKeyOf(ctx);

    if (!(await ctx.directory.hasMember(groupKey, payload.primaryEmail))) {
      return { status: 'skipped', output: { group: groupKey, reason: 'not a member' } };
    }

    await ctx.directory.removeMember(groupKey, payload.primaryEmail);
    return { status: 'succeeded', output: { group: groupKey, operation: 'remove' } };
  },
});

/**
 * Reads the account and the affected memberships back and compares them against
 * the approved diff.
 *
 * Necessary for the same reason phase 1 has one: every step above can
 * legitimately skip, and a plan made entirely of skips would otherwise report a
 * successful update without anyone having confirmed the account reached the
 * state that was asked for.
 */
registerHandler({
  name: 'verify-update',
  async execute(ctx: StepContext): Promise<StepResult> {
    const payload = payloadOf(ctx);
    const diff = requireDiff(ctx);

    const user = await ctx.directory.getUser(payload.primaryEmail);
    if (!user) {
      throw new UserNotFoundError(payload.primaryEmail, 'verify-update');
    }

    const problems: string[] = [];

    for (const change of diff.attributes) {
      const observed = liveValue(user, change.field);
      if (observed !== change.after) {
        problems.push(`${change.field} is ${observed ?? 'unset'}, expected ${change.after ?? 'unset'}`);
      }
    }

    for (const change of diff.groups) {
      const isMember = await ctx.directory.hasMember(change.groupKey, payload.primaryEmail);
      if (isMember !== change.after) {
        problems.push(
          `${change.groupKey} membership is ${isMember}, expected ${change.after}`,
        );
      }
    }

    if (problems.length > 0) {
      throw new WorkspaceError(
        `Verification failed for ${payload.primaryEmail}: ${problems.join('; ')}`,
        'terminal',
        422,
        'verify-update',
      );
    }

    return {
      status: 'succeeded',
      output: {
        verified: true,
        attributes: diff.attributes.length,
        groups: diff.groups.length,
      },
    };
  },
});
