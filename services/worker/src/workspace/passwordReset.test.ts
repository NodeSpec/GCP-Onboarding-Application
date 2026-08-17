import type { admin_directory_v1 } from 'googleapis';
import { describe, expect, it } from 'vitest';
import { DirectoryClient, WorkspaceError } from './directoryClient.js';

/**
 * TC-REQ-030-4: what regeneration actually sends to Workspace.
 *
 * The Directory API is injected, so the real client builds the real request
 * body and only the network is substituted. That matters here more than usual:
 * the criterion is specifically about which API is called and which fields go
 * with the new password, and a test that stubbed the client method would have
 * asserted nothing about either.
 */

/** Records every users.update the client issues. */
function recordingApi(): {
  api: admin_directory_v1.Admin;
  updates: { userKey: string; body: admin_directory_v1.Schema$User }[];
  inserts: unknown[];
} {
  const updates: { userKey: string; body: admin_directory_v1.Schema$User }[] = [];
  const inserts: unknown[] = [];

  const api = {
    users: {
      update: async (params: { userKey: string; requestBody: admin_directory_v1.Schema$User }) => {
        updates.push({ userKey: params.userKey, body: params.requestBody });
        return { data: { primaryEmail: params.userKey } };
      },
      insert: async (params: unknown) => {
        inserts.push(params);
        return { data: {} };
      },
    },
  } as unknown as admin_directory_v1.Admin;

  return { api, updates, inserts };
}

function client(api: admin_directory_v1.Admin): DirectoryClient {
  return new DirectoryClient({ customerId: 'my_customer', api, sleep: async () => {} });
}

const NEW_PASSWORD = 'Rn3w3d-Passw0rd-For-Handover';

describe('AC-4: a regenerated password is set through users.update', () => {
  it('calls users.update on the target account', async () => {
    const { api, updates } = recordingApi();

    await client(api).resetPassword('ada.lovelace@company.com', NEW_PASSWORD);

    expect(updates).toHaveLength(1);
    expect(updates[0]!.userKey).toBe('ada.lovelace@company.com');
    expect(updates[0]!.body.password).toBe(NEW_PASSWORD);
  });

  it('sets changePasswordAtNextLogin alongside the password, always', async () => {
    // Not optional and not a caller's choice. A reset that left the flag alone
    // would hand the operator a password the account holder could keep using,
    // which is a shared credential rather than a handoff.
    const { api, updates } = recordingApi();

    await client(api).resetPassword('ada.lovelace@company.com', NEW_PASSWORD);

    expect(updates[0]!.body.changePasswordAtNextLogin).toBe(true);
  });

  it('creates no account, so a reset against a missing user cannot become a create', async () => {
    // users.insert and users.update are one keystroke apart and the failure
    // would be silent: a resend for a deleted account would quietly recreate it
    // rather than failing validation (AC-9).
    const { api, inserts } = recordingApi();

    await client(api).resetPassword('ada.lovelace@company.com', NEW_PASSWORD);

    expect(inserts).toEqual([]);
  });

  it('sends nothing but the password and the flag', async () => {
    // A patch that also carried, say, an org unit or a name would silently undo
    // an attribute change made since the account was created.
    const { api, updates } = recordingApi();

    await client(api).resetPassword('ada.lovelace@company.com', NEW_PASSWORD);

    expect(Object.keys(updates[0]!.body).sort()).toEqual(['changePasswordAtNextLogin', 'password']);
  });

  it('classifies a missing account as not_found rather than retrying it', async () => {
    // The account is gone. Retrying will not bring it back, and burning the
    // retry budget on it delays the failure the operator needs to see.
    const api = {
      users: {
        update: async () => {
          throw { code: 404, message: 'Resource Not Found: userKey' };
        },
      },
    } as unknown as admin_directory_v1.Admin;

    await expect(client(api).resetPassword('gone@company.com', NEW_PASSWORD)).rejects.toMatchObject({
      errorClass: 'not_found',
    });
  });

  it('names the operation without quoting any part of the password', async () => {
    const api = {
      users: {
        update: async () => {
          throw { code: 400, message: 'Invalid Input' };
        },
      },
    } as unknown as admin_directory_v1.Admin;

    let err: WorkspaceError | undefined;
    try {
      await client(api).resetPassword('ada.lovelace@company.com', NEW_PASSWORD);
    } catch (caught) {
      err = caught as WorkspaceError;
    }

    expect(err).toBeInstanceOf(WorkspaceError);
    expect(err!.operation).toBe('users.update.password');
    // The message is written to the step record and mirrored to logs, so a
    // password appearing in it would outlive the request that generated it.
    expect(err!.message).not.toContain(NEW_PASSWORD);
  });
});
