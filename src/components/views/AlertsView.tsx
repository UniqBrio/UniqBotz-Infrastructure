"use client";

import { MessageCircle, Mail, TrendingUp } from "lucide-react";
import { useState } from "react";
import type { Alert } from "@/lib/domain/types";
import { combineResources, useAlerts, useApplicationNames, useSettings } from "@/lib/data/hooks";
import { useScopedAppId } from "@/lib/data/scope";
import { formatDateTime, formatInt, formatLakh, formatMb } from "@/lib/domain/format";
import { Card } from "@/components/ui/Card";
import { DataState } from "@/components/ui/DataState";
import { SegmentedControl } from "@/components/ui/Form";
import { KeyValueList } from "@/components/ui/KeyValue";
import { PageHeader } from "@/components/ui/PageHeader";
import { LoadingState } from "@/components/ui/States";
import { MetricCard } from "@/components/monitoring/MetricCard";
import { AlertTable } from "@/components/alerts/AlertTable";
import { NotificationStatusBadge } from "@/components/status/NotificationStatus";
import { SeverityBadge } from "@/components/status/SeverityBadge";
import { ScopeEyebrow } from "./ScopeEyebrow";

type Filter = "all" | "LOW" | "MEDIUM" | "HIGH" | "RESOLVED";

export function AlertsView() {
  const appId = useScopedAppId();
  const names = useApplicationNames();
  const [filter, setFilter] = useState<Filter>("all");
  const all = combineResources({ alerts: useAlerts(appId), settings: useSettings() });

  return (
    <>
      <PageHeader
        eyebrow={<ScopeEyebrow />}
        title="Alerts"
        description="Threshold and capacity alerts with escalation, recovery and duplicate suppression. Notification delivery shown here is simulated — no WhatsApp or email is sent in this phase."
      />
      <DataState resource={all} loading={<LoadingState rows={8} />}>
        {({ alerts, settings }) => {
          const active = alerts.filter((a) => a.state === "active");
          const matches = (a: Alert) =>
            filter === "all" || (filter === "RESOLVED" ? a.state === "resolved" : a.state === "active" && a.level === filter);
          const featured = active.filter((a) => a.level === "HIGH");
          const n = settings.notifications;
          return (
            <div className="space-y-5">
              <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                <MetricCard label="HIGH" value={active.filter((a) => a.level === "HIGH").length} tone="high" hint="Active" />
                <MetricCard label="MEDIUM" value={active.filter((a) => a.level === "MEDIUM").length} tone="med" hint="Active" />
                <MetricCard label="LOW" value={active.filter((a) => a.level === "LOW").length} tone="low" hint="Active" />
                <MetricCard label="RESOLVED" value={alerts.filter((a) => a.state === "resolved").length} tone="neutral" hint="Recovered below threshold" />
              </div>

              <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
                <div className="space-y-4">
                  {featured.map((a) => (
                    <FeaturedAlert key={a.id} alert={a} appName={names[a.applicationId] ?? a.applicationId} />
                  ))}
                </div>
                <Card title="Notification destinations" description="Configured in Settings">
                  <KeyValueList
                    columns={1}
                    items={[
                      {
                        label: "WhatsApp",
                        value: (
                          <span className="inline-flex items-center gap-1.5">
                            <MessageCircle className="size-3.5 text-ink-3" aria-hidden />
                            <span className="num font-semibold">{n.whatsappNumber}</span>
                          </span>
                        ),
                      },
                      {
                        label: "Email",
                        value: (
                          <span className="inline-flex items-center gap-1.5">
                            <Mail className="size-3.5 text-ink-3" aria-hidden />
                            {n.email || <span className="text-ink-3">Not configured</span>}
                          </span>
                        ),
                      },
                      { label: "Duplicate suppression", value: `Same level within ${n.duplicateSuppressionHours} h` },
                      { label: "Escalation / recovery notices", value: `${n.notifyOnEscalation ? "On" : "Off"} / ${n.notifyOnRecovery ? "On" : "Off"}` },
                    ]}
                  />
                </Card>
              </div>

              <Card
                title="Alert history"
                actions={
                  <SegmentedControl<Filter>
                    label="Filter alerts"
                    size="sm"
                    value={filter}
                    onChange={setFilter}
                    options={[
                      { value: "all", label: "All", count: alerts.length },
                      { value: "HIGH", label: "HIGH" },
                      { value: "MEDIUM", label: "MEDIUM" },
                      { value: "LOW", label: "LOW" },
                      { value: "RESOLVED", label: "RESOLVED" },
                    ]}
                  />
                }
                flush
              >
                <AlertTable alerts={alerts.filter(matches)} appNames={names} caption="Alert history" />
              </Card>
            </div>
          );
        }}
      </DataState>
    </>
  );
}

function FeaturedAlert({ alert: a, appName }: { alert: Alert; appName: string }) {
  const wa = [...a.notifications].reverse().find((x) => x.channel === "whatsapp");
  return (
    <article className="rounded-lg border border-high-line bg-surface">
      <div className="flex flex-wrap items-center gap-2 border-b border-high-line bg-high-soft/60 px-4 py-2.5">
        <SeverityBadge severity={a.level} size="md" />
        <span className="text-[15px] font-semibold">{appName}</span>
        {a.tableName && <span className="font-mono text-[13px]">{a.tableName}</span>}
        {a.escalatedFrom && (
          <span className="ml-auto inline-flex items-center gap-1 text-xs text-high-ink">
            <TrendingUp className="size-3.5" aria-hidden /> Escalated from {a.escalatedFrom}
          </span>
        )}
      </div>
      <div className="px-4 py-3">
        <KeyValueList
          columns={4}
          items={[
            {
              label: "Observed",
              value: <span className="text-base font-semibold">{a.kind === "table_records" ? `${formatInt(a.observedValue)} records` : formatMb(a.observedValue)}</span>,
            },
            { label: "Threshold", value: a.kind === "table_records" ? `${formatLakh(a.threshold)} (${formatInt(a.threshold)})` : formatMb(a.threshold) },
            { label: "Average growth", value: a.avgDailyGrowth !== null ? `${formatInt(a.avgDailyGrowth)}/day` : "—" },
            { label: "Detected", value: formatDateTime(a.detectedAt) },
          ]}
        />
        {wa && (
          <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-line pt-2.5 text-xs text-ink-2">
            <MessageCircle className="size-3.5 text-ink-3" aria-hidden /> WhatsApp → <span className="num font-medium">{wa.destination}</span>
            <NotificationStatusBadge status={wa.status} />
            {wa.detail && <span className="text-ink-3">{wa.detail}</span>}
          </div>
        )}
      </div>
    </article>
  );
}
