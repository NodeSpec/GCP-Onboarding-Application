import { createLogger } from '@lifecycle/shared/logging';

/**
 * The worker logger. Same shared factory, same redaction filter. The worker
 * handles plaintext passwords in memory during Phase 1, so this is the service
 * where a second, weaker logger would do the most damage.
 */
export const logger = createLogger({ name: 'lifecycle-worker' });
