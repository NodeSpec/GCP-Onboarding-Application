import { Logging } from '@google-cloud/logging';
import type { AuditLogWriter, MirroredEvent } from './auditMirror.js';

/**
 * The Cloud Logging half of the audit mirror (REQ-018 AC-1).
 *
 * Entries go to a named log, and a Terraform log sink routes that log name into
 * the dedicated bucket carrying the locked retention policy (AC-3 to AC-5). The
 * split is deliberate: the application decides WHAT is mirrored, and the
 * infrastructure decides where it lands and who may shorten its retention.
 * Nothing here can weaken the retention policy, which is the point — the
 * runtime identities are the ones this control is protecting the trail from.
 *
 * `insertId` is the audit event's own eventId. Cloud Logging deduplicates on
 * it, so a re-run of the sweep after a crash writes nothing new, and the id is
 * also what reconciliation joins the two stores on.
 */

export interface CloudLoggingAuditOptions {
  /** The log name the sink routes into the retention bucket. */
  logName: string;
  /**
   * What to read from when reconciling. Entries routed into a dedicated bucket
   * are read through that bucket's view, not through the project, so a
   * deployment supplies the view resource name here. Defaults to the project,
   * which is right only while the sink is still writing to _Default.
   */
  readResourceNames?: string[];
  projectId?: string;
}

export class CloudLoggingAuditWriter implements AuditLogWriter {
  private readonly logging: Logging;

  constructor(
    private readonly options: CloudLoggingAuditOptions,
    logging?: Logging,
  ) {
    this.logging = logging ?? new Logging(
      options.projectId ? { projectId: options.projectId } : {},
    );
  }

  async write(entries: MirroredEvent[]): Promise<void> {
    if (entries.length === 0) return;

    const log = this.logging.log(this.options.logName);

    await log.write(
      entries.map((entry) =>
        log.entry(
          {
            // Audit events are about the application, not about a GCP resource
            // being acted on, so the generic resource is the honest choice.
            resource: { type: 'global' },
            insertId: entry.insertId,
            timestamp: entry.timestamp,
            severity: 'NOTICE',
          },
          entry.payload,
        ),
      ),
      // Written as-is. Partial success is not something to paper over: a
      // rejected batch must fail the sweep so the watermark does not advance
      // past events that never landed.
      { partialSuccess: false },
    );
  }

  async insertIdsBetween(from: Date, to: Date): Promise<Set<string>> {
    const filter = [
      `logName:"${this.options.logName}"`,
      `timestamp>="${from.toISOString()}"`,
      `timestamp<="${to.toISOString()}"`,
    ].join(' AND ');

    const ids = new Set<string>();
    const [entries] = await this.logging.getEntries({
      filter,
      pageSize: 1000,
      autoPaginate: true,
      ...(this.options.readResourceNames
        ? { resourceNames: this.options.readResourceNames }
        : {}),
    });

    for (const entry of entries) {
      const insertId = (entry.metadata as { insertId?: string } | undefined)?.insertId;
      if (insertId) ids.add(insertId);
    }

    return ids;
  }
}
