import { Firestore } from '@google-cloud/firestore';
import express from 'express';
import {
  AuditMirror,
  CloudLoggingAuditWriter,
  CredentialStore,
  LifecycleStore,
  SecretManagerKeyProvider,
} from '@lifecycle/shared';
import { requireCaller } from './auth/taskAuth.js';
import { config } from './config.js';
import { logger } from './logging.js';
import { lookupRoutes } from './routes/lookup.js';
import { taskRoutes } from './routes/tasks.js';
import { advance } from './steps/advance.js';
import { createDispatcher } from './tasks/dispatcher.js';
import { notifyApprovers } from './notify/approvers.js';
import { SmtpNotificationSender } from './notify/sender.js';
import { useNotificationSender } from './phases/notify.js';
import { DirectoryClient } from './workspace/directoryClient.js';

// Registering the phase modules is what populates the step handler registry.
// Import for side effects; resolveHandler throws for an unregistered step name,
// so a missing import here fails loudly at execution rather than silently
// skipping work.
import './phases/create.js';
import './phases/notify.js';
import './phases/update.js';
import './phases/delete.js';

/**
 * Worker entry point.
 *
 * Route mounting is the security boundary. /tasks/* admits only the Cloud Tasks
 * queue invoker; /lookup/* admits only the API service. Each router is mounted
 * behind its own requireCaller, so neither identity can reach the other's
 * routes even though run.invoker is granted at the service level and cannot
 * tell them apart.
 *
 * This service is not attached to the load balancer and has no human callers,
 * which is why it is not behind IAP. See REQ-007.
 */

const db = new Firestore({
  projectId: config.GCP_PROJECT_ID,
  databaseId: config.FIRESTORE_DATABASE,
});

const store = new LifecycleStore(db);
const credentials = new CredentialStore(db, new SecretManagerKeyProvider(config.CREDENTIAL_KEY_SECRET));
const directory = new DirectoryClient({ customerId: config.WORKSPACE_CUSTOMER_ID });
const dispatcher = createDispatcher();

// One sender for both message kinds. The worker is the only service holding an
// SMTP credential, which is why approval notices are queued to it rather than
// sent by the API service (REQ-004 AC-7, REQ-032 AC-9).
const sender = new SmtpNotificationSender();
useNotificationSender(sender);

/**
 * The audit trail's second copy (REQ-018 AC-1), swept on a schedule.
 *
 * Built only when a log name is configured. An unconfigured deployment starts
 * and runs; what it does NOT do is claim to have a tamper-evident copy — the
 * sweep route answers 'not_configured' and logs a warning, which is the
 * difference between a missing control and a control that silently does
 * nothing.
 */
const auditMirror = config.AUDIT_LOG_NAME
  ? new AuditMirror(
      db,
      new CloudLoggingAuditWriter({
        logName: config.AUDIT_LOG_NAME,
        projectId: config.GCP_PROJECT_ID,
        ...(config.AUDIT_LOG_VIEW ? { readResourceNames: [config.AUDIT_LOG_VIEW] } : {}),
      }),
    )
  : null;

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '256kb' }));

// Platform health check. No caller identity, no data.
app.get('/healthz', (_req, res) => {
  res.status(200).json({ status: 'ok' });
});

app.use(
  '/tasks',
  requireCaller('cloud-tasks'),
  taskRoutes({
    store,
    directory,
    credentials,
    advance: (requestId, completedStepId) =>
      advance({ store, dispatcher }, requestId, completedStepId),
    notifyApprovers: (params) => notifyApprovers({ store, sender }, params),
    // Supplied only when the mirror is configured, so the route can say so
    // rather than reporting a sweep that never happened (REQ-018).
    ...(auditMirror ? { sweepAuditMirror: () => auditMirror.sweep() } : {}),
  }),
);

// Read-only directory lookup for the console's pickers (REQ-029). Mounted
// behind the API service's identity, so the Cloud Tasks invoker admitted on
// /tasks cannot reach it, and vice versa.
app.use('/lookup', requireCaller('api-service'), lookupRoutes({ directory }));

app.use((_req, res) => {
  res.status(404).json({ error: 'not_found' });
});

const server = app.listen(config.PORT, () => {
  logger.info(
    { port: config.PORT, workspaceMode: config.WORKSPACE_MODE, nodeEnv: config.NODE_ENV },
    'lifecycle-worker listening',
  );
});

// Cloud Run sends SIGTERM before reclaiming an instance. A step mid-flight has
// already claimed itself in Firestore, so an abrupt exit would leave it running
// until the retry budget notices. Draining lets it finish and settle.
process.on('SIGTERM', () => {
  logger.info('SIGTERM received, draining');
  server.close(() => {
    logger.info('drained, exiting');
    process.exit(0);
  });
});

export { app };
