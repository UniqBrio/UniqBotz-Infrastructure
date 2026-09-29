import { Settings2 } from "lucide-react";
import type { RetentionPolicy, TableHealth } from "@/lib/domain/types";
import { formatInt } from "@/lib/domain/format";
import { Badge } from "@/components/ui/Badge";
import { Table, TD, TH, THead, TR } from "@/components/ui/Table";
import { EmptyState } from "@/components/ui/States";
import { PolicyBadge } from "@/components/status/PolicyBadge";

export interface PolicyRow {
  table: TableHealth;
  policy: RetentionPolicy;
}

function statusCell(p: RetentionPolicy) {
  if (p.policy === "review_required") return <Badge tone="low" size="xs">AWAITING DECISION</Badge>;
  if (p.policy === "dont_archive") return <Badge tone="neutral" size="xs">EXCLUDED</Badge>;
  return p.enabled ? <Badge tone="ok" size="xs">ENABLED</Badge> : <Badge tone="neutral" size="xs">DISABLED</Badge>;
}

export function RetentionPolicyTable({ rows, onEdit, caption }: { rows: PolicyRow[]; onEdit: (row: PolicyRow) => void; caption: string }) {
  if (rows.length === 0) {
    return <EmptyState title="No tables match" description="Try a different policy filter or search term." />;
  }
  return (
    <Table caption={caption}>
      <THead>
        <tr>
          <TH>Table</TH>
          <TH align="right">Records</TH>
          <TH>Policy</TH>
          <TH>Date column</TH>
          <TH align="right">Protected period</TH>
          <TH align="right">Archive target</TH>
          <TH>Status</TH>
          <TH align="right">
            <span className="sr-only">Configure</span>
          </TH>
        </tr>
      </THead>
      <tbody>
        {rows.map((row) => {
          const { table: t, policy: p } = row;
          const archive = p.policy === "archive";
          return (
            <TR key={`${t.applicationId}.${t.tableName}`} className="cursor-pointer hover:bg-surface-2" onClick={() => onEdit(row)}>
              <TD>
                <span className="font-mono text-[12.5px] font-medium">{t.tableName}</span>
                {t.isNewlyDiscovered && (
                  <Badge tone="info" size="xs" className="ml-2" title="Discovered recently — defaulted to Review Required">
                    NEW
                  </Badge>
                )}
              </TD>
              <TD align="right">{formatInt(t.rowCount)}</TD>
              <TD>
                <PolicyBadge policy={p.policy} />
              </TD>
              <TD className="font-mono text-[12px] text-ink-2">{archive ? p.dateColumn ?? "—" : "—"}</TD>
              <TD align="right" className="text-ink-2">
                {archive && p.protectedPeriodMonths ? `${p.protectedPeriodMonths} months` : "—"}
              </TD>
              <TD align="right" className="text-ink-2">
                {archive && p.archiveTargetRecords ? formatInt(p.archiveTargetRecords) : "—"}
              </TD>
              <TD>{statusCell(p)}</TD>
              <TD align="right">
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onEdit(row);
                  }}
                  className="inline-flex items-center gap-1 text-xs font-medium text-accent hover:underline"
                  aria-label={`Configure retention for ${t.tableName}`}
                >
                  <Settings2 className="size-3.5" aria-hidden /> Configure
                </button>
              </TD>
            </TR>
          );
        })}
      </tbody>
    </Table>
  );
}
