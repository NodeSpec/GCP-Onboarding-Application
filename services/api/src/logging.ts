import { createLogger } from '@lifecycle/shared/logging';

/**
 * The API service logger. Built from the shared factory so the redaction filter
 * is the same one the worker uses; there is deliberately no second definition
 * of what counts as sensitive.
 */
export const logger = createLogger({ name: 'lifecycle-api' });
