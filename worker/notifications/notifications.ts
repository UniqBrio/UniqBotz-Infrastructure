import type pg from "pg";
import type { SecretRef } from "../connection/types";

/**
 * Notification interface (Phase 3C §14). SENDING IS DISABLED. Events are rendered to a summary (never
 * personal records, never secrets) and recorded in control.notification_outbox with status 'suppressed'
 * (the database constrains the status, so nothing can be marked as sent).
 *
 * A future channel implementation (WhatsApp / email provider — undecided, decision N-1) implements
 * NotificationChannel and resolves its credentials through a MESSAGING secret reference.
 */
export type NotificationEvent =
  | "threshold_alert" | "archive_started" | "archive_verified" | "deletion_approved"
  | "deletion_completed" | "failure" | "recovery" | "database_critical";
export const NOTIFICATION_EVENTS: NotificationEvent[] = [
  "threshold_alert", "archive_started", "archive_verified", "deletion_approved", "deletion_completed", "failure", "recovery", "database_critical",
];

export interface NotificationMessage {
  event: NotificationEvent;
  applicationId: string | null;
  jobId?: string | null;
  /** Short operator-facing summary: counts, levels, job IDs. No row data. */
  summary: string;
  facts: Record<string, string | number | boolean | null>;
}

export interface NotificationChannel {
  readonly channel: "whatsapp" | "email";
  readonly credentialRef: SecretRef | null;
  send(message: NotificationMessage): Promise<{ delivered: boolean; reason: string }>;
}

/** The only channel implementation in Phase 3C: refuses to deliver. */
export class DisabledChannel implements NotificationChannel {
  readonly credentialRef = null;
  constructor(readonly channel: "whatsapp" | "email") {}
  async send() {
    return { delivered: false, reason: "NOTIFICATIONS DISABLED (Phase 3C): no provider configured and sending is switched off" };
  }
}

const FORBIDDEN_FACT = /password|secret|token|key|phone|email|name|address/i;

export function buildMessage(event: NotificationEvent, applicationId: string | null, facts: NotificationMessage["facts"], jobId?: string | null): NotificationMessage {
  for (const k of Object.keys(facts)) if (FORBIDDEN_FACT.test(k)) throw new Error(`notification fact '${k}' is not allowed (no personal data or secrets in notifications)`);
  const parts = Object.entries(facts).map(([k, v]) => `${k}=${v}`).join(", ");
  return { event, applicationId, jobId: jobId ?? null, summary: `[${event}] ${applicationId ?? "system"}${jobId ? ` job ${jobId}` : ""}: ${parts}`, facts };
}

export class NotificationDispatcher {
  constructor(private cp: pg.Client, private channels: NotificationChannel[] = [new DisabledChannel("whatsapp"), new DisabledChannel("email")]) {}

  /** Records what WOULD be sent. Returns the suppression reasons. Nothing leaves the system. */
  async dispatch(message: NotificationMessage): Promise<string[]> {
    const reasons: string[] = [];
    for (const ch of this.channels) {
      const r = await ch.send(message);
      if (r.delivered) throw new Error("invariant violated: a notification channel reported delivery while notifications are disabled");
      reasons.push(r.reason);
      await this.cp.query(
        `INSERT INTO control.notification_outbox (event_type, application_id, job_id, channel, payload, reason) VALUES ($1,$2,$3,$4,$5,$6)`,
        [message.event, message.applicationId, message.jobId ?? null, ch.channel, JSON.stringify({ summary: message.summary, facts: message.facts }), r.reason]);
    }
    return reasons;
  }
}
