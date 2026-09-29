import { MessageCircle, Mail, TrendingUp } from "lucide-react";
import type { Alert } from "@/lib/domain/types";
import { formatDateTime, formatInt, formatLakh, formatMb, formatRelative } from "@/lib/domain/format";
import { Table, TD, TH, THead, TR } from "@/components/ui/Table";
import { EmptyState } from "@/components/ui/States";
import { NotificationStatusBadge } from "@/components/status/NotificationStatus";
import { ResolvedBadge, SeverityBadge } from "@/components/status/SeverityBadge";

function thresholdLabel(a: Alert) {
  return a.kind === "table_records" ? `${formatInt(a.threshold)} (${formatLakh(a.threshold)})` : `${formatMb(a.threshold)} capacity mark`;
}

export function AlertTable({ alerts, appNames, caption }: { alerts: Alert[]; appNames: Record<string, string>; caption: string }) {
  if (alerts.length === 0) return <EmptyState title="No alerts" description="Nothing matches the current scope and filters." />;
  return (
    <Table caption={caption}>
      <THead>
        <tr>
          <TH>Level</TH>
          <TH>Application</TH>
          <TH>Subject</TH>
          <TH align="right">Observed</TH>
          <TH align="right">Threshold</TH>
          <TH align="right">Avg growth</TH>
          <TH>Detected</TH>
          <TH>Notifications</TH>
        </tr>
      </THead>
      <tbody>
        {alerts.map((a) => (
          <TR key={a.id} className={a.state === "resolved" ? "text-ink-2" : undefined}>
            <TD>
              <div className="flex flex-col items-start gap-1">
                {a.state === "resolved" ? (
                  <>
                    <ResolvedBadge />
                    <span className="text-[11px] text-ink-3">was {a.level}</span>
                  </>
                ) : (
                  <SeverityBadge severity={a.level} />
                )}
                {a.escalatedFrom && a.state === "active" && (
                  <span className="inline-flex items-center gap-0.5 text-[11px] text-ink-3">
                    <TrendingUp className="size-3" aria-hidden /> from {a.escalatedFrom}
                  </span>
                )}
              </div>
            </TD>
            <TD className="whitespace-nowrap font-medium">{appNames[a.applicationId] ?? a.applicationId}</TD>
            <TD>
              {a.kind === "table_records" ? (
                <span className="font-mono text-[12.5px]">{a.tableName}</span>
              ) : (
                <span>Database capacity</span>
              )}
              <div className="font-mono text-[10px] text-ink-3">{a.id}</div>
            </TD>
            <TD align="right" className="font-medium">
              {a.kind === "table_records" ? `${formatInt(a.observedValue)} records` : formatMb(a.observedValue)}
            </TD>
            <TD align="right" className="text-ink-2">
              {thresholdLabel(a)}
            </TD>
            <TD align="right">{a.avgDailyGrowth !== null ? `${formatInt(a.avgDailyGrowth)}/day` : "—"}</TD>
            <TD className="whitespace-nowrap text-xs">
              <div>{formatDateTime(a.detectedAt)}</div>
              <div className="text-ink-3">
                {a.resolvedAt ? `Resolved ${formatRelative(a.resolvedAt)}` : formatRelative(a.detectedAt)}
              </div>
            </TD>
            <TD>
              <ul className="space-y-1">
                {a.notifications.filter((n) => n.status !== "not_configured").map((n, i) => (
                  <li key={i} className="flex flex-wrap items-center gap-1.5 text-xs">
                    {n.channel === "whatsapp" ? (
                      <MessageCircle className="size-3.5 text-ink-3" aria-label="WhatsApp" />
                    ) : (
                      <Mail className="size-3.5 text-ink-3" aria-label="Email" />
                    )}
                    <span className="sr-only">{n.channel === "whatsapp" ? "WhatsApp" : "Email"}</span>
                    <NotificationStatusBadge status={n.status} />
                    {n.at && <span className="text-ink-3">{formatRelative(n.at)}</span>}
                    {n.detail && <span className="w-full pl-5 text-[11px] text-ink-3">{n.detail}</span>}
                  </li>
                ))}
              </ul>
            </TD>
          </TR>
        ))}
      </tbody>
    </Table>
  );
}
