"use client";

import { Archive, Ban, HelpCircle, Info } from "lucide-react";
import { useId, useState } from "react";
import type { RetentionPolicy, RetentionPolicyInput, RetentionPolicyKind, TableHealth } from "@/lib/domain/types";
import { POLICY_DESCRIPTION, POLICY_LABEL } from "@/lib/domain/labels";
import { formatDateTime, formatInt } from "@/lib/domain/format";
import { useMutations } from "@/lib/data/hooks";
import { validateRetentionPolicy } from "@/lib/data/validation";
import { cn } from "@/lib/cn";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Field, NumberInput, Select, TextInput, Toggle } from "@/components/ui/Form";
import { KeyValueList } from "@/components/ui/KeyValue";

const OPTIONS: { value: RetentionPolicyKind; Icon: typeof Archive }[] = [
  { value: "review_required", Icon: HelpCircle },
  { value: "dont_archive", Icon: Ban },
  { value: "archive", Icon: Archive },
];

/**
 * Side panel for configuring one table's retention policy. Saves go to the
 * data source (local mock state in Phase 1) — no policy engine runs.
 * Mount with a `key` per table so the form resets between tables.
 */
export function RetentionPolicyEditor({
  open,
  onClose,
  table,
  policy,
  appName,
  defaultTarget,
}: {
  open: boolean;
  onClose: () => void;
  table: TableHealth;
  policy: RetentionPolicy;
  appName: string;
  defaultTarget: number;
}) {
  const id = useId();
  const { source, invalidate } = useMutations();
  const [draft, setDraft] = useState<RetentionPolicyInput>(() => ({
    applicationId: policy.applicationId,
    tableName: policy.tableName,
    policy: policy.policy,
    dateColumn: policy.dateColumn,
    protectedPeriodMonths: policy.protectedPeriodMonths,
    archiveTargetRecords: policy.archiveTargetRecords,
    enabled: policy.enabled,
  }));
  const [touched, setTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);

  const errors = validateRetentionPolicy(draft);
  const isArchive = draft.policy === "archive";

  const choose = (kind: RetentionPolicyKind) =>
    setDraft((d) => ({
      ...d,
      policy: kind,
      dateColumn: kind === "archive" ? d.dateColumn ?? table.dateColumns[0] ?? null : d.dateColumn,
      protectedPeriodMonths: kind === "archive" ? d.protectedPeriodMonths ?? 12 : d.protectedPeriodMonths,
      archiveTargetRecords: kind === "archive" ? d.archiveTargetRecords ?? defaultTarget : d.archiveTargetRecords,
      enabled: kind === "archive" ? d.enabled : false,
    }));

  const save = async () => {
    setTouched(true);
    if (Object.keys(errors).length > 0) return;
    setSaving(true);
    setSaveError(null);
    try {
      const saved = await source.saveRetentionPolicy(draft);
      setSavedAt(saved.updatedAt);
      invalidate();
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      variant="panel"
      labelledBy={`${id}-title`}
      title={<span className="font-mono">{table.tableName}</span>}
      description={`${appName} · Retention policy`}
      footer={
        <>
          <span className="mr-auto self-center text-[11px] text-ink-3">
            {source.mode === "live"
              ? "Read-only: policy editing requires authentication (not implemented yet). Operators use the worker CLI."
              : "Saves to local mock state only."}
          </span>
          <Button onClick={onClose}>Close</Button>
          <Button variant="primary" onClick={save} disabled={saving || source.mode === "live"}>
            {saving ? "Saving…" : "Save policy"}
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        {savedAt && (
          <div role="status" className="rounded-md border border-ok-line bg-ok-soft px-3 py-2 text-xs text-ok-ink">
            Policy saved to local mock state at {formatDateTime(savedAt)}. An audit entry was recorded (simulated).
          </div>
        )}
        {saveError && (
          <div role="alert" className="rounded-md border border-high-line bg-high-soft px-3 py-2 text-xs text-high-ink">
            {saveError}
          </div>
        )}

        <Field label="Table name" htmlFor={`${id}-name`}>
          <TextInput id={`${id}-name`} value={`${table.schema}.${table.tableName}`} readOnly className="font-mono" />
        </Field>

        <KeyValueList
          columns={3}
          items={[
            { label: "Records", value: formatInt(table.rowCount) },
            { label: "Growth", value: `${formatInt(table.avgDailyGrowth6m)}/day` },
            { label: "Discovered", value: formatDateTime(table.discoveredAt) },
          ]}
        />

        <fieldset>
          <legend className="mb-1.5 text-xs font-semibold text-ink-2">Policy</legend>
          <div className="grid gap-2" role="radiogroup">
            {OPTIONS.map(({ value, Icon }) => (
              <label
                key={value}
                className={cn(
                  "flex cursor-pointer items-start gap-3 rounded-md border px-3 py-2.5",
                  draft.policy === value ? "border-accent bg-accent-soft" : "border-line hover:bg-surface-2",
                )}
              >
                <input
                  type="radio"
                  name={`${id}-policy`}
                  value={value}
                  checked={draft.policy === value}
                  onChange={() => choose(value)}
                  className="mt-1 accent-[var(--color-accent)]"
                />
                <Icon className="mt-0.5 size-4 text-ink-2" aria-hidden />
                <span>
                  <span className="block text-[13px] font-semibold">{POLICY_LABEL[value]}</span>
                  <span className="block text-xs text-ink-3">{POLICY_DESCRIPTION[value]}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        <div className={cn("space-y-4 rounded-md border border-line p-3", !isArchive && "opacity-60")}>
          <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-ink-3">
            Archive parameters {!isArchive && <span className="normal-case tracking-normal">· only used with the Archive policy</span>}
          </div>
          <Field
            label="Date column"
            htmlFor={`${id}-date`}
            hint="Determines which day each record belongs to. Whole days are always archived together."
            error={touched ? errors.dateColumn : undefined}
          >
            <Select
              id={`${id}-date`}
              disabled={!isArchive}
              value={draft.dateColumn ?? ""}
              invalid={touched && !!errors.dateColumn}
              onChange={(e) => setDraft((d) => ({ ...d, dateColumn: e.target.value || null }))}
            >
              <option value="">Select a column…</option>
              {table.dateColumns.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </Select>
          </Field>
          <Field
            label="Protected period"
            htmlFor={`${id}-protected`}
            hint="Records newer than this are never eligible for archival."
            error={touched ? errors.protectedPeriodMonths : undefined}
          >
            <NumberInput
              id={`${id}-protected`}
              disabled={!isArchive}
              min={1}
              step={1}
              suffix="months"
              value={draft.protectedPeriodMonths}
              invalid={touched && !!errors.protectedPeriodMonths}
              onValueChange={(v) => setDraft((d) => ({ ...d, protectedPeriodMonths: v }))}
            />
          </Field>
          <Field
            label="Archive target"
            htmlFor={`${id}-target`}
            hint="Selection stops on the first complete day that reaches or crosses this count."
            error={touched ? errors.archiveTargetRecords : undefined}
          >
            <NumberInput
              id={`${id}-target`}
              disabled={!isArchive}
              min={1}
              step={1000}
              suffix="records"
              value={draft.archiveTargetRecords}
              invalid={touched && !!errors.archiveTargetRecords}
              onValueChange={(v) => setDraft((d) => ({ ...d, archiveTargetRecords: v }))}
            />
          </Field>
          <Toggle
            label="Enabled"
            checked={draft.enabled}
            disabled={!isArchive}
            onChange={(v) => setDraft((d) => ({ ...d, enabled: v }))}
            description={isArchive ? "When off, the policy is saved but the table does not enter the archive engine." : "Only Archive policies can be enabled."}
          />
        </div>

        <div className="flex gap-2 rounded-md border border-line bg-surface-2 px-3 py-2 text-xs text-ink-2">
          <Info className="mt-0.5 size-3.5 shrink-0 text-ink-3" aria-hidden />
          <p>
            Retention decides <strong>eligibility</strong>. Record thresholds (10L / 11L / 12L) only decide when attention is
            needed — reaching a threshold never archives a table on its own.
          </p>
        </div>

        <p className="text-[11px] text-ink-3">
          Last updated {formatDateTime(policy.updatedAt)} by {policy.updatedBy}
        </p>
      </div>
    </Dialog>
  );
}
