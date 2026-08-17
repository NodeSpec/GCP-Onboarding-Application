import { Firestore } from '@google-cloud/firestore';
import {
  ANONYMOUS_ACTOR,
  CredentialStore,
  LifecycleStore,
  SecretManagerKeyProvider,
  normalisePolicy,
  policyPath,
  type ApprovalPolicy,
} from '@lifecycle/shared';
import express from 'express';
import pinoHttp from 'pino-http';
import { config } from './config.js';
import { logger } from './logging.js';
import { createIapAuth } from './middleware/iapAuth.js';
import { adminRoutes } from './routes/admin.js';
import { requestRoutes } from './routes/requests.js';
import { roleBindingRoutes } from './routes/roleBindings.js';
import { BindingRoleResolver } from './roles.js';
import { createDispatcher } from './tasks/dispatcher.js';

/**
 * Service entry point.
 *
 * Ordering here is load bearing: iapAuth is mounted before every route that
 * follows it, so no handler can be reached without a verified identity. The
 * health endpoint is mounted before it, because Cloud Run probes it without an
 * assertion and it exposes nothing.
 */

const app = express();

app.disable('x-powered-by');
app.use(express.json({ limit: '256kb' }));
app.use(pinoHttp({ logger }));

// Platform health check. No identity, no data.
app.get('/healthz', (_req, res) => {
  res.status(200).json({ status: 'ok' });
});

const db = new Firestore({
  projectId: config.GCP_PROJECT_ID,
  databaseId: config.FIRESTORE_DATABASE,
});
const store = new LifecycleStore(db);

// Retrieval is the only path by which a credential leaves the system, and it
// terminates at an authenticated operator inside the perimeter (REQ-017).
const credentials = new CredentialStore(
  db,
  new SecretManagerKeyProvider(config.CREDENTIAL_KEY_SECRET),
);

/**
 * Records an authorisation refusal (REQ-010 AC-3).
 *
 * Shared by the 401 path and every role check. requestId is null for a 401,
 * which is refused before any route runs and therefore belongs to no request;
 * a sentinel id would make the per-request audit query answer for events that
 * were never about it.
 */
const auditRefusal = (event: {
  actor: Parameters<typeof store.recordDenied>[0]['actor'];
  action: string;
  reason: string;
  path: string;
  sourceIp: string;
}) =>
  store.recordDenied({ requestId: null, ...event });

// Everything past this point requires a verified IAP assertion. Built here, in
// the composition root, rather than at module scope in the middleware: that
// kept the middleware module unimportable without a full environment.
app.use(
  createIapAuth({
    auditDenied: ({ reason, path, sourceIp }) =>
      auditRefusal({
        // Nothing about this caller was verified, so no identity is recorded.
        actor: ANONYMOUS_ACTOR,
        action: 'auth.assertion_refused',
        reason,
        path,
        sourceIp,
      }),
    audience: config.IAP_AUDIENCE ?? '',
    clockToleranceSeconds: config.IAP_CLOCK_SKEW_SECONDS,
    // Spread rather than assign: under exactOptionalPropertyTypes an explicit
    // undefined is a supplied bypass identity of the wrong type, not an absent
    // one, and this is the field whose absence keeps verification switched on.
    ...(config.AUTH_MODE === 'dev-insecure'
      ? {
          bypassIdentity: {
            email: config.DEV_OPERATOR_EMAIL!.toLowerCase(),
            subject: 'dev-subject',
          },
        }
      : {}),
  }),
);


/**
 * Reads the live approval policy. Called per submission rather than cached, so
 * an admin's edit takes effect on the next request without a redeploy; each
 * request then snapshots what it read (REQ-002 AC-6).
 */
async function loadPolicy(): Promise<ApprovalPolicy> {
  const snap = await db.doc(policyPath()).get();
  return normalisePolicy(snap.exists ? snap.data() : undefined);
}

const dispatcher = createDispatcher();

/**
 * Roles come from the binding store now, not from the provisional resolver that
 * granted 'requester' to everyone and left the approve and reject routes
 * unreachable. An operator with no binding is authenticated and authorized for
 * nothing (REQ-012 AC-2); BOOTSTRAP_ADMINS is the only way into an empty store.
 *
 * Group membership needs the worker's read-only directory lookup (REQ-029),
 * which is not built, so only individual bindings resolve today. Caching is
 * left off: it would trade revocation latency for read volume, and read volume
 * is not this service's problem.
 */
const resolver = new BindingRoleResolver(store, { bootstrapAdmins: config.BOOTSTRAP_ADMINS });

/**
 * Every role refusal is audited with the identity that was refused, what was
 * required, and where they were reaching (REQ-010 AC-3). Fire-and-forget for
 * the same reason as the 401: the refusal is the answer, and an audit write
 * that fails must not turn a 403 into a 500.
 */
const onDenied = (event: {
  identity: { email: string };
  required: string;
  path: string;
  sourceIp: string;
}) => {
  void auditRefusal({
    actor: { kind: 'human', email: event.identity.email },
    action: 'authz.role_refused',
    reason: `requires role '${event.required}'`,
    path: event.path,
    sourceIp: event.sourceIp,
  }).catch((err: unknown) => logger.error({ err }, 'failed to audit a role refusal'));
};

app.use(
  '/api/requests',
  requestRoutes({ store, loadPolicy, dispatcher, resolver, credentials, onDenied }),
);
app.use(
  '/api/role-bindings',
  roleBindingRoutes({ store, resolver, onChanged: (subject) => resolver.invalidate(subject) }),
);
app.use('/api/admin', adminRoutes({ store, dispatcher, resolver }));

app.get('/api/me', async (req, res) => {
  // The console reads who it is, and what it may do, from the server. It must
  // never infer either from a client-held token, and hiding a control based on
  // this response is presentation only: every action is authorized again
  // server-side (REQ-012 AC-8).
  const identity = req.identity!;
  res.status(200).json({
    email: identity.email,
    subject: identity.subject,
    roles: await resolver.rolesFor(identity),
  });
});

// Unknown route under the authenticated surface.
app.use((_req, res) => {
  res.status(404).json({ error: 'not_found' });
});

// Error handler. Never returns a stack trace to the caller.
app.use((err: unknown, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const correlationId = req.id ?? undefined;
  logger.error({ err, correlationId }, 'unhandled error');
  res.status(500).json({ error: 'internal_error', correlationId });
});

const server = app.listen(config.PORT, () => {
  logger.info(
    { port: config.PORT, authMode: config.AUTH_MODE, nodeEnv: config.NODE_ENV },
    'lifecycle-api listening',
  );
});

// Cloud Run sends SIGTERM before reclaiming an instance. Drain in flight work
// rather than cutting requests off mid response.
process.on('SIGTERM', () => {
  logger.info('SIGTERM received, draining');
  server.close(() => {
    logger.info('drained, exiting');
    process.exit(0);
  });
});

export { app };
