import express from 'express';
import pinoHttp from 'pino-http';
import { config } from './config.js';
import { logger } from './logging.js';
import { createIapAuth } from './middleware/iapAuth.js';

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

app.get('/api/me', (req, res) => {
  // Roles are resolved from the role binding store in a later change. Returning
  // the verified identity alone keeps the console honest in the meantime: it
  // reads who it is from the server, never from a client held token.
  res.status(200).json({ email: req.identity!.email, subject: req.identity!.subject, roles: [] });
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
