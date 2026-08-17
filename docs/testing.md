# Testing

How to run the tests, what each tier needs, and what a human has to check by hand..

Tests are organised in three tiers by what they require to run. The tiers matter because a test you cannot run is worse than no test: it goes stale, and someone eventually deletes it or, worse, trusts it.

| Tier | Needs | Runs in CI | Command |
|---|---|---|---|
| 1. Unit | Nothing | Yes, on every commit | `npm test` |
| 2. Integration | Firestore emulator | Yes, emulator started in the job | `npm run test:integration` |
| 3. Environment | A deployed stack and a Workspace test tenant | No, run before release | `npm run test:e2e` |
| 4. Manual | A human | No | See the checklist below |

## Tier 1: unit tests

No cloud dependencies, no network, no credentials. These should stay fast enough that nobody minds running them.

```bash
npm install
npm test
```

What they cover:

* **IAP assertion verification** (`services/api/src/middleware/iapAuth.test.ts`). Mints real ES256 assertions from a locally generated key pair and puts them through the same verification path production uses. Only the key source is substituted, so a pass means the real logic accepted or rejected the token.
* **Transition guard** (`packages/shared/src/transitions.test.ts`). Sweeps every status pair and asserts the closed table, not just that legal moves work.
* **Log redaction** (`packages/shared/src/logging.test.ts`). Asserts secrets are censored at depth, inside arrays, and inside error cause chains.
* **Directory error classification** (`services/worker/src/workspace/directoryClient.test.ts`). Sweeps the status-to-class table and checks no phase handler implements its own retry.
* **Configuration guards** (`services/api/src/config.test.ts`). Asserts the local development bypass cannot start outside development.

## Tier 2: integration tests

These exercise the Firestore transaction behaviour that unit tests cannot: the transactional pairing of a state change with its audit event, and the single-success guarantee under concurrent retrieval.

Start the emulator, then run:

```bash
gcloud emulators firestore start --host-port=localhost:8090

# in another shell
export FIRESTORE_EMULATOR_HOST=localhost:8090
npm run test:integration
```

The emulator holds data in memory and is discarded on exit, so no cleanup is needed between runs.

## Tier 3: environment tests

These need a deployed stack and a Workspace tenant you are willing to create and delete accounts in. **Do not point them at a production tenant.** They create users, add group memberships and delete accounts.

```bash
export TEST_WORKSPACE_DOMAIN=test.company.com
export TEST_TARGET_PREFIX=lifecycle-test-
npm run test:e2e
```

Every account they create is prefixed with `TEST_TARGET_PREFIX` so a failed run leaves an obvious, greppable mess rather than an ambiguous one. If a run fails partway, list and remove leftovers before re-running.

Some criteria can only be proven against real infrastructure and belong here: that each Cloud Run service refuses a direct `*.run.app` request, that every load-balancer backend has IAP enabled, and that an unauthenticated request to every route in the table is rejected.

## Tier 4: manual verification

These cannot be automated, either because they happen in the Google Workspace or Google Cloud consoles, or because the thing being checked is a human judgement. Each one is a criterion marked `[manual]` in its test plan.

Proving one has three steps: perform the check, tick the criterion box in the owning component's task document under `.nodespec/tasks/`, and have the change card approved in NodeSpec. That approval is what records it as met. Test results cannot flip a manual criterion, by design.

### Workspace configuration (REQ-027, REQ-008)

- [ ] A custom Workspace admin role exists carrying only: Users (create, read, update, delete), Groups (read and manage members), Organizational Units (read).
- [ ] That role carries **no** role-management privilege. Check the privilege list directly. A service account able to assign admin roles could grant itself Super Admin.
- [ ] The role is assigned to the worker's runtime service account by email, under Account > Admin roles > Assign service accounts, and to no other principal.
- [ ] Domain-Wide Delegation is **not** configured for that service account. Check Security > API controls > Domain-wide delegation and confirm its client id is absent.
- [ ] A read-only `users.list` call from the worker's identity succeeds, proving the grant is live before any mutating phase is exercised.

### Email delivery (REQ-028)

- [ ] App passwords are available in the tenant. Google restricts these periodically; if they are disabled this design is void and the IP-allowlisting path or a third-party provider must be used instead. **Check this before building anything that depends on it.**
- [ ] A dedicated no-reply Workspace account exists for sending, holding no admin role and belonging to no person.
- [ ] The SMTP relay permits that account as a sender and allows **any** recipient address, since welcome letters go to personal addresses outside the domain.
- [ ] SPF, DKIM and DMARC are configured for the sending domain, validated with a live send to an external address.
- [ ] A test letter to a personal-domain address arrives in the inbox rather than the spam folder.
- [ ] Return-Path points at a monitored group, and the runbook names who monitors it. Asynchronous bounces land there rather than in a webhook, so if nobody watches it, nobody learns that a welcome letter bounced.

### Access and perimeter (REQ-007, REQ-023)

- [ ] IAP is enabled on the operator backend service.
- [ ] `roles/iap.httpsResourceAccessor` is granted to the operator Google group only, not to individual users and not to `allAuthenticatedUsers`.
- [ ] An account outside the operator group is refused at the perimeter and never reaches the application.

### Audit retention (REQ-018)

- [ ] The audit log bucket carries a locked retention policy, set to the company's stated compliance requirement rather than a provider default.
- [ ] An attempt to shorten or remove that policy using each application runtime identity is refused.

### Deployment (REQ-009, REQ-015)

- [ ] A from-scratch Terraform apply into an empty project produces a reachable, IAP-protected endpoint using only the documented steps.
- [ ] An engineer who has not seen the repository can reach a working deployment following only the documents in `docs/`.

## Reporting results

Automated results bind to acceptance criteria through NodeSpec. Run the tests, then report each outcome with the test id from the plan and the criterion's exact text. A passing result flips the criterion to met; the binding is what makes the specification reflect reality rather than intent.

Test plans live alongside the task documents and regenerate when a requirement, a mapping or a bound source file changes. A test case marked stale means its recorded verdict may no longer hold: re-run it and report again rather than assuming the previous pass still stands.
