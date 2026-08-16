import { Firestore } from '@google-cloud/firestore';
import express from 'express';
import { LifecycleStore } from '@lifecycle/shared';
import { requireCaller } from './auth/taskAuth.js';
import { config } from './config.js';
import { CredentialStore } from './credentials/credentialStore.js';
import { logger } from './logging.js';
import { taskRoutes } from './routes/tasks.js';
import { advance } from './steps/advance.js';
import { CloudTasksDispatcher } from './tasks/dispatcher.js';
import { DirectoryClient } from './workspace/directoryClient.js';

// Registering the phase modules is what populates the step handler registry.
// Import for side effects; resolveHandler throws for an unregistered step name,
// so a missing import here fails loudly at execution rather than silently
// skipping work.
import './phases/create.js';

/**
 * Worker entry point.
 *
 * Route mounting is the security boundary. /tasks/* admits only the Cloud Tasks
 * queue invoker; /lookup/* will admit only the API service. Each router is
 * mounted behind its own requireCaller, so neither identity can reach the
 * other's routes even though run.invoker is granted at the service level and
 * cannot tell them apart.
 *
 * This service is not attached to the load balancer and has no human callers,
 * which is why it is not behind IAP. See REQ-007.
 */

const db = new Firestore({
  projectId: config.GCP_PROJECT_ID,
  databaseId: config.FIRESTORE_DATABASE,
});

const store = new LifecycleStore(db);
const credentials = new CredentialStore(db);
const directory = new DirectoryClient({ customerId: config.WORKSPACE_CUSTOMER_ID });
const dispatcher = new CloudTasksDispatcher();

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
  }),
);

// /lookup is mounted in the directory-lookup change (REQ-029), behind
// requireCaller('api-service').

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
