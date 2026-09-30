"use client";

import { Lock, RotateCcw } from "lucide-react";
import { useState, type ReactNode } from "react";
import type { InfrastructureSettings } from "@/lib/domain/types";
import { formatInt, formatLakh } from "@/lib/domain/format";
import { useMutations, useSettings } from "@/lib/data/hooks";
import { MockDataSource } from "@/lib/data/mock/mockDataSource";
import { validateSettings } from "@/lib/data/validation";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { DataState } from "@/components/ui/DataState";
import { Field, NumberInput, Select, TextInput, Toggle } from "@/components/ui/Form";
import { PageHeader } from "@/components/ui/PageHeader";
import { LoadingState } from "@/components/ui/States";
import { SeverityBadge } from "@/components/status/SeverityBadge";

export function SettingsView() {
  const settings = useSettings();
  return (
    <>
      <PageHeader
        title="Settings"
        description="Global configuration for thresholds, archive targets, notifications and safety. In this phase changes are saved to local mock state and reset on reload."
      />
      <DataState resource={settings} loading={<LoadingState rows={10} />}>
        {(s) => <SettingsForm key={JSON.stringify(s)} initial={s} />}
      </DataState>
      <PrototypeControls />
    </>
  );
}

function Section({ title, description, children }: { title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <Card title={title} description={description}>
      {children}
    </Card>
  );
}

function SettingsForm({ initial }: { initial: InfrastructureSettings }) {
  const { source, invalidate } = useMutations();
  const [s, setS] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const errors = validateSettings(s);
  const dirty = JSON.stringify(s) !== JSON.stringify(initial);

  const save = async () => {
    if (Object.keys(errors).length) return;
    setSaving(true);
    setMessage(null);
    try {
      await source.updateSettings(s);
      setMessage({ tone: "ok", text: "Saved to local mock state. Severities across the dashboard now use these values." });
      invalidate();
    } catch (e) {
      setMessage({ tone: "error", text: e instanceof Error ? e.message : String(e) });
    } finally {
      setSaving(false);
    }
  };

  const setT = (k: keyof InfrastructureSettings["recordThresholds"], v: number | null) =>
    setS((p) => ({ ...p, recordThresholds: { ...p.recordThresholds, [k]: v ?? 0 } }));
  const setC = (k: keyof InfrastructureSettings["capacityThresholdsPct"], v: number | null) =>
    setS((p) => ({ ...p, capacityThresholdsPct: { ...p.capacityThresholdsPct, [k]: v ?? 0 } }));

  return (
    <div className="space-y-5 pb-5">
      {s.runtime && (
        <Section title="Runtime safety state" description="Reported by the control plane. Read-only; these cannot be changed from the dashboard.">
          <div className="flex flex-wrap gap-2 text-xs">
            <Badge tone={s.runtime.allowDeletion ? "high" : "ok"}>PRODUCTION DELETION: {s.runtime.allowDeletion ? "ENABLED" : "DISABLED"}</Badge>
            <Badge tone={s.runtime.deletionKillSwitch ? "ok" : "med"}>KILL SWITCH: {s.runtime.deletionKillSwitch ? "ON" : "OFF"}</Badge>
            <Badge tone="ok">AUTOMATED SCHEDULING: {s.runtime.schedulingEnabled ? "ENABLED" : "DISABLED"}</Badge>
            <Badge tone="ok">NOTIFICATIONS: {s.runtime.notificationsEnabled ? "ENABLED" : "DISABLED"}</Badge>
            <Badge tone="neutral">POLICY EDITING: {s.runtime.policyEditing === "prototype" ? "PROTOTYPE" : "DISABLED UNTIL AUTH"}</Badge>
            <Badge tone="neutral">GRACE PERIOD: {s.safety.gracePeriodDays === null ? "NOT CONFIGURED" : `${s.safety.gracePeriodDays} days`}</Badge>
          </div>
        </Section>
      )}
      <div className="grid gap-5 xl:grid-cols-2">
        <Section title="Record thresholds" description="Per-table record counts that raise alerts. Thresholds never archive data by themselves.">
          <div className="space-y-3">
            {(["low", "medium", "high"] as const).map((k) => (
              <Field
                key={k}
                htmlFor={`t-${k}`}
                label={
                  <span className="inline-flex items-center gap-2">
                    <SeverityBadge severity={k.toUpperCase() as "LOW" | "MEDIUM" | "HIGH"} size="xs" />
                    {formatLakh(s.recordThresholds[k])}
                  </span>
                }
                error={errors[k]}
              >
                <NumberInput id={`t-${k}`} value={s.recordThresholds[k]} onValueChange={(v) => setT(k, v)} suffix="records" min={1} step={10000} invalid={!!errors[k]} />
              </Field>
            ))}
          </div>
        </Section>

        <Section
          title="Database capacity thresholds"
          description={
            <span className="inline-flex flex-wrap items-center gap-1">
              Percent of plan capacity. Configurable — not confirmed business rules.{" "}
              {s.capacityThresholdsFinal ? <Badge tone="ok" size="xs">FINAL</Badge> : <Badge tone="med" size="xs">NOT FINAL</Badge>}
            </span>
          }
        >
          <div className="grid grid-cols-3 gap-3">
            {(["low", "medium", "high"] as const).map((k) => (
              <Field key={k} htmlFor={`c-${k}`} label={k.toUpperCase()}>
                <NumberInput id={`c-${k}`} value={s.capacityThresholdsPct[k]} onValueChange={(v) => setC(k, v)} suffix="%" min={1} max={100} invalid={!!errors.capacity} />
              </Field>
            ))}
          </div>
          {errors.capacity && <p className="mt-2 text-xs font-medium text-high-ink">{errors.capacity}</p>}
        </Section>

        <Section title="Archive target" description="Default target for new Archive policies. Selection always completes the final day, so runs land slightly above it.">
          <Field htmlFor="target" label="Default archive target" error={errors.defaultArchiveTarget} hint={`Currently ${formatInt(s.defaultArchiveTarget)} records per run`}>
            <NumberInput id="target" value={s.defaultArchiveTarget} onValueChange={(v) => setS((p) => ({ ...p, defaultArchiveTarget: v ?? 0 }))} suffix="records" min={1} step={1000} invalid={!!errors.defaultArchiveTarget} />
          </Field>
          <Field htmlFor="format" label="Archive format" className="mt-3" hint="Streamed/chunked export. Storage provider is selected in the backend phase.">
            <Select id="format" value={s.archiveFormat} onChange={(e) => setS((p) => ({ ...p, archiveFormat: e.target.value as InfrastructureSettings["archiveFormat"] }))}>
              <option value="csv.gz">CSV (gzip)</option>
              <option value="jsonl.gz">JSON Lines (gzip)</option>
              <option value="parquet">Parquet</option>
            </Select>
          </Field>
        </Section>

        <Section title="Notifications" description="Alert destinations. Nothing is sent in this phase.">
          <div className="space-y-3">
            <Field htmlFor="wa" label="WhatsApp number" error={errors.whatsappNumber}>
              <TextInput id="wa" inputMode="tel" className="num" value={s.notifications.whatsappNumber} invalid={!!errors.whatsappNumber} onChange={(e) => setS((p) => ({ ...p, notifications: { ...p.notifications, whatsappNumber: e.target.value } }))} />
            </Field>
            <Field htmlFor="email" label="Email" error={errors.email} hint="Optional — leave blank to disable email alerts.">
              <TextInput id="email" type="email" placeholder="ops@example.com" value={s.notifications.email} invalid={!!errors.email} onChange={(e) => setS((p) => ({ ...p, notifications: { ...p.notifications, email: e.target.value } }))} />
            </Field>
            <Field htmlFor="dup" label="Duplicate suppression window" error={errors.duplicateSuppressionHours}>
              <NumberInput id="dup" value={s.notifications.duplicateSuppressionHours} suffix="hours" min={1} onValueChange={(v) => setS((p) => ({ ...p, notifications: { ...p.notifications, duplicateSuppressionHours: v ?? 0 } }))} />
            </Field>
            <Toggle label="Notify on escalation" checked={s.notifications.notifyOnEscalation} onChange={(v) => setS((p) => ({ ...p, notifications: { ...p.notifications, notifyOnEscalation: v } }))} />
            <Toggle label="Notify on recovery" checked={s.notifications.notifyOnRecovery} onChange={(v) => setS((p) => ({ ...p, notifications: { ...p.notifications, notifyOnRecovery: v } }))} />
          </div>
        </Section>
      </div>

      <Section title="Safety" description="Concepts the archive engine will enforce. Displayed and editable here; no behaviour is implemented yet.">
        <div className="grid gap-5 md:grid-cols-3">
          <Field htmlFor="grace" label="Grace period" error={errors.gracePeriodDays} hint="Extra days held back beyond each protected period for late, backdated or offline-synced records.">
            <NumberInput id="grace" value={s.safety.gracePeriodDays} suffix="days" min={0} onValueChange={(v) => setS((p) => ({ ...p, safety: { ...p.safety, gracePeriodDays: v ?? 0 } }))} />
          </Field>
          <Field htmlFor="batch" label="Deletion batch size" error={errors.deletionBatchSize} hint="Rows per short delete transaction. Avoids one massive DELETE; progress is resumable.">
            <NumberInput id="batch" value={s.safety.deletionBatchSize} suffix="rows" min={100} step={500} invalid={!!errors.deletionBatchSize} onValueChange={(v) => setS((p) => ({ ...p, safety: { ...p.safety, deletionBatchSize: v ?? 0 } }))} />
          </Field>
          <div className="space-y-4">
            <div className="flex items-start gap-3">
              <Lock className="mt-0.5 size-4 text-ink-3" aria-hidden />
              <div>
                <div className="flex items-center gap-2 text-[13px] font-medium">
                  Archive verification required <Badge tone="ok" size="xs">ALWAYS ON</Badge>
                </div>
                <p className="text-xs text-ink-3">Hard gate — cannot be disabled. Failed verification means 0 records deleted.</p>
              </div>
            </div>
            <Toggle
              label="Manual deletion review"
              checked={s.safety.manualDeletionReviewRequired}
              onChange={(v) => setS((p) => ({ ...p, safety: { ...p.safety, manualDeletionReviewRequired: v } }))}
              description="Require an operator to review and confirm every deletion."
            />
          </div>
        </div>
      </Section>

      <div className="fixed right-0 bottom-0 left-0 z-20 border-t border-line bg-surface/95 px-4 py-3 backdrop-blur lg:left-64 lg:px-6">
        <div className="mx-auto flex max-w-[1480px] flex-wrap items-center justify-end gap-3">
          {message && (
            <span role="status" className={message.tone === "ok" ? "mr-auto text-xs text-ok-ink" : "mr-auto text-xs text-high-ink"}>
              {message.text}
            </span>
          )}
          {!message && Object.keys(errors).length > 0 && (
            <span className="mr-auto text-xs font-medium text-high-ink">Fix {Object.keys(errors).length} validation issue(s) before saving.</span>
          )}
          <Button onClick={() => setS(initial)} disabled={!dirty || saving}>
            <RotateCcw className="size-3.5" aria-hidden /> Discard changes
          </Button>
          {source.mode === "live" && (
            <span className="mr-auto text-xs text-ink-2">Read-only in live mode — settings changes need authentication (not implemented yet).</span>
          )}
          <Button variant="primary" onClick={save} disabled={source.mode === "live" || !dirty || saving || Object.keys(errors).length > 0}>
            {saving ? "Saving…" : "Save settings"}
          </Button>
        </div>
      </div>
    </div>
  );
}

/** Review aids for the mock source only: latency and forced failures. */
function PrototypeControls() {
  const { source, invalidate } = useMutations();
  const [, force] = useState(0);
  if (!(source instanceof MockDataSource)) return null;
  const sim = source.simulation;
  const update = (patch: Partial<typeof sim>) => {
    source.setSimulation(patch);
    force((n) => n + 1);
    invalidate();
  };
  return (
    <div className="mb-24">
      <Card title="Prototype controls" description="Review loading and error states. Affects this browser session only.">
        <div className="grid gap-5 md:grid-cols-2">
          <Field htmlFor="latency" label="Simulated latency">
            <NumberInput id="latency" value={sim.latencyMs} suffix="ms" min={0} step={250} onValueChange={(v) => update({ latencyMs: Math.max(0, v ?? 0) })} />
          </Field>
          <Toggle label="Simulate data-source failure" checked={sim.failReads} onChange={(v) => update({ failReads: v })} description="Every page shows its error state until turned off." />
        </div>
      </Card>
    </div>
  );
}
