import type { AuditEntry } from "@/lib/domain/types";
import { ALERT_TODAY } from "./alerts";
import { daysAgo, hoursAgo, minutesAgo } from "./clock";

const OPS = { type: "user" as const, name: "ops@uniqbotz (demo)" };
const SYS = { type: "system" as const, name: "retention-monitor (demo)" };
const ENGINE = { type: "system" as const, name: "archive-engine (demo)" };
const NOTIFY = { type: "system" as const, name: "notifier (demo)" };

let n = 0;
function e(at: string, applicationId: string | null, action: AuditEntry["action"], tableName: string | null, actor: AuditEntry["actor"], result: AuditEntry["result"], detail: string | null, jobId: string | null = null): AuditEntry {
  n += 1;
  return { id: `AUD-${String(9000 - n).padStart(5, "0")}`, at, applicationId, action, tableName, actor, result, detail, jobId };
}

export const seedAuditLog: AuditEntry[] = [
  e(minutesAgo(18), "rosifit", "archive_started", "attendance_records", ENGINE, "success", "Verification of stored archive started (125,249 rows expected).", "JOB-00124"),
  e(minutesAgo(50), "rosifit", "archive_started", "workout_logs", SYS, "success", "Scheduled archive run started. 125,311 rows selected.", "JOB-00127"),
  e(hoursAgo(3), "rosifit", "archive_started", "attendance_records", OPS, "success", "Archive started. 124,999 before final day + 250 final day = 125,249.", "JOB-00124"),
  e(ALERT_TODAY, "jalsa", "alert_sent", "orders", NOTIFY, "success", "HIGH (escalated from MEDIUM). WhatsApp delivered to 9994871158."),
  e(hoursAgo(17), "uniqbrio", "archive_verified", "attendance", ENGINE, "success", "125,118 / 125,118 rows · checksum match. Deletion now allowed (awaiting review).", "JOB-00126"),
  e(hoursAgo(20), "uniqbrio", "archive_started", "attendance", OPS, "success", "Archive started. 125,118 rows selected.", "JOB-00126"),
  e(daysAgo(1, 14, 5), "jalsa", "alert_sent", null, NOTIFY, "success", "Database capacity MEDIUM (87.6%). WhatsApp delivered."),
  e(daysAgo(1, 3, 12), "uniqbrio", "table_discovered", "chat_messages", SYS, "success", "New table discovered. Policy defaulted to Review Required."),
  e(daysAgo(2, 11, 41), "uniqbrio", "archive_verification_failed", "session_logs", ENGINE, "failure", "Expected 125,318 rows, found 124,902. Deletion blocked — 0 records deleted.", "JOB-00125"),
  e(daysAgo(2, 11, 41), "uniqbrio", "job_failed", "session_logs", ENGINE, "failure", "Job failed at Archive Verified. Source data untouched.", "JOB-00125"),
  e(daysAgo(2, 8, 35), "rosifit", "alert_sent", null, NOTIFY, "success", "Database capacity MEDIUM (82.4%). Delivered on retry 1."),
  e(daysAgo(2, 8, 30), "rosifit", "alert_sent", null, NOTIFY, "failure", "WhatsApp delivery failed: provider timeout (demo)."),
  e(daysAgo(2, 3, 10), "rosifit", "table_discovered", "trainer_feedback", SYS, "success", "New table discovered. Policy defaulted to Review Required."),
  e(daysAgo(3, 3, 10), "jalsa", "table_discovered", "delivery_partner_events", SYS, "success", "New table discovered. Policy defaulted to Review Required."),
  e(daysAgo(4, 11, 15), "jalsa", "alert_sent", "order_items", NOTIFY, "success", "MEDIUM (escalated from LOW). WhatsApp delivered."),
  e(daysAgo(4, 9, 0), "jalsa", "alert_sent", "payments", NOTIFY, "blocked", "Duplicate LOW alert suppressed within 24 h window."),
  e(daysAgo(5, 9, 0), "jalsa", "alert_sent", "payments", NOTIFY, "success", "LOW. WhatsApp delivered."),
  e(daysAgo(6, 3, 48), "jalsa", "job_failed", "audit_logs", ENGINE, "failure", "Deletion halted at batch 39/63 (lock timeout). 76,000 rows deleted; resumable. Requires review.", "JOB-00121"),
  e(daysAgo(6, 3, 0), "jalsa", "deletion_started", "audit_logs", OPS, "success", "Deletion confirmed after verification PASSED. Batch size 2,000.", "JOB-00121"),
  e(daysAgo(6, 2, 40), "jalsa", "archive_verified", "audit_logs", ENGINE, "success", "125,302 / 125,302 rows · checksum match.", "JOB-00121"),
  e(daysAgo(9, 16, 20), "jalsa", "policy_changed", "audit_logs", OPS, "success", "Protected period 12 → 6 months."),
  e(daysAgo(12, 4, 0), "jalsa", "deletion_completed", "orders, order_items", ENGINE, "success", "126,120 rows deleted in 64 batches. Deletion verified.", "JOB-00123"),
  e(daysAgo(12, 2, 20), "jalsa", "deletion_started", "orders, order_items", OPS, "success", "Deletion confirmed after verification PASSED.", "JOB-00123"),
  e(daysAgo(12, 2, 10), "jalsa", "archive_verified", "orders, order_items", ENGINE, "success", "126,120 / 126,120 rows · checksum match.", "JOB-00123"),
  e(daysAgo(12, 0, 31), "jalsa", "archive_started", "orders, order_items", OPS, "success", "Multi-table archive started. 126,120 rows selected.", "JOB-00123"),
  e(daysAgo(14, 12, 5), "jalsa", "policy_created", "payments", OPS, "success", "Policy: Archive · paid_at · 12 months · target 125,000."),
  e(daysAgo(19, 3, 10), "rosifit", "deletion_completed", "workout_logs", ENGINE, "success", "125,480 rows deleted. Deletion verified.", "JOB-00122"),
  e(daysAgo(26, 10, 30), "rosifit", "policy_changed", "class_bookings", OPS, "success", "Enabled → Disabled pending review of booking disputes."),
  e(daysAgo(34, 4, 28), "rosifit", "deletion_completed", "attendance_records", ENGINE, "success", "125,036 rows deleted. Deletion verified.", "JOB-00120"),
  e(daysAgo(40, 9, 0), null, "settings_changed", null, OPS, "success", "Default archive target set to 125,000."),
];
