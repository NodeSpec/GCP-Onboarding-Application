import type { NextFunction, Request, RequestHandler, Response } from 'express';

/**
 * Express 4 does not forward a rejected promise from an async handler to the
 * error middleware. The rejection becomes an unhandled promise rejection, and
 * Node's default for those is to kill the process; Cloud Run then answers the
 * caller with a plain-text 503 and drops every other request that instance was
 * serving.
 *
 * That is not a theoretical failure mode. During a deploy, a sign-in that
 * arrived while the worker was still cold made the group lookup inside role
 * resolution reject, and each attempt took the whole API instance down. The
 * console showed "Service Unavailable is not valid JSON" and the failure wore
 * an authentication costume for three separate incidents before this file
 * existed.
 *
 * guarded() is the bridge Express 5 provides natively: a rejection is handed
 * to next(), where the error middleware logs it with its correlation id and
 * answers a JSON 500 without a stack trace. Every async handler and async
 * middleware in this service is registered through it; a bare `async (req,
 * res)` passed straight to the router is the bug this module exists to end.
 */
export function guarded(handler: RequestHandler): RequestHandler {
  return function guardedHandler(req: Request, res: Response, next: NextFunction): void {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}
