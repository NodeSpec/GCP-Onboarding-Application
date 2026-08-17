import { Firestore } from '@google-cloud/firestore';
import { LifecycleStore, normalisePolicy, policyPath, type ApprovalPolicy } from '@lifecycle/shared';
import express from 'express';
import pinoHttp from 'pino-http';
import { config } from './config.js';
import { logger } from './logging.js';
import { createIapAuth } from './middleware/iapAuth.js';
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

// Everything past this point requires a verified IAP assertion. Built here, in
// the composition root, rather than at module scope in the middleware: that
// kept the middleware module unimportable without a full environment.
app.use(
  createIapAuth({
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

const db = new Firestore({
  projectId: config.GCP_PROJECT_ID,
  databaseId: config.FIRESTORE_DATABASE,
});
const store = new LifecycleStore(db);

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

app.use('/api/requests', requestRoutes({ store, loadPolicy, dispatcher, resolver }));
app.use(
  '/api/role-bindings',
  roleBindingRoutes({ store, resolver, onChanged: (subject) => resolver.invalidate(subject) }),
);

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
