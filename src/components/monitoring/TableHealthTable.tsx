import Link from "next/link";
import type { RetentionPolicy, TableHealth } from "@/lib/domain/types";
import { formatInt, formatMb, formatRelative } from "@/lib/domain/format";
import { Badge, DemoTag } from "@/components/ui/Badge";
import { Table, TD, TH, THead, TR } from "@/components/ui/Table";
import { EmptyState } from "@/components/ui/States";
import { PolicyBadge } from "@/components/status/PolicyBadge";
import { SeverityBadge } from "@/components/status/SeverityBadge";

/**
 * Per-table monitoring table.
 *  - "overview": Table / Records / Growth / Threshold / Severity / Retention / Action (application detail)
 *  - "technical": Rows / Est. size / Index size / Growth / Retention (database health)
 */
export function TableHealthTable({
  tables,
  variant = "overview",
  policies,
  onView,
  caption,
}: {
  tables: TableHealth[];
  variant?: "overview" | "technical";
  policies?: RetentionPolicy[];
  onView?: (t: TableHealth) => void;
  caption: string;
}) {
  if (tables.length === 0) {
    return <EmptyState title="No tables" description="No tables have been discovered for this application yet." />;
  }
  return (
    <Table caption={caption}>
      <THead>
        <tr>
          <TH>Table</TH>
          <TH align="right">{variant === "technical" ? "Rows" : "Records"}</TH>
          {variant === "technical" && (
            <>
              <TH align="right">
                Est. size <DemoTag />
              </TH>
              <TH align="right">
                Index size <DemoTag />
              </TH>
            </>
          )}
          <TH align="right">Growth/day</TH>
          {variant === "overview" && <TH align="right">Next threshold</TH>}
          <TH>Severity</TH>
          <TH>Retention</TH>
          {variant === "overview" && <TH align="right">Action</TH>}
          {variant === "technical" && <TH align="right">Checked</TH>}
        </tr>
      </THead>
      <tbody>
        {tables.map((t) => {
          const policy = policies?.find((p) => p.tableName === t.tableName && p.applicationId === t.applicationId);
          return (
            <TR key={`${t.applicationId}.${t.tableName}`} className="hover:bg-surface-2">
              <TD>
                <span className="font-mono text-[12.5px] font-medium">{t.tableName}</span>
                {t.isNewlyDiscovered && (
                  <Badge tone="info" size="xs" className="ml-2">
                    NEW
                  </Badge>
                )}
              </TD>
              <TD align="right">{formatInt(t.rowCount)}</TD>
              {variant === "technical" && (
                <>
                  <TD align="right">{formatMb(t.estimatedSizeMb)}</TD>
                  <TD align="right">{formatMb(t.indexSizeMb)}</TD>
                </>
              )}
              <TD align="right">{formatInt(t.avgDailyGrowth6m)}</TD>
              {variant === "overview" && (
                <TD align="right" className="text-ink-2">
                  {t.nextThreshold ? (
                    <span title={`${formatInt(t.recordsRemaining)} records remaining`}>
                      {formatInt(t.nextThreshold.threshold)} <span className="text-[11px] text-ink-3">{t.nextThreshold.level}</span>
                    </span>
                  ) : (
                    "Above HIGH"
                  )}
                </TD>
              )}
              <TD>{t.severity === "NONE" ? <span className="text-ink-3">—</span> : <SeverityBadge severity={t.severity} />}</TD>
              <TD>
                <span className="inline-flex items-center gap-1.5">
                  <PolicyBadge policy={t.policy} />
                  {policy?.policy === "archive" && !policy.enabled && (
                    <span className="text-[11px] text-ink-3">(disabled)</span>
                  )}
                </span>
              </TD>
              {variant === "overview" && (
                <TD align="right">
                  {onView ? (
                    <button type="button" onClick={() => onView(t)} className="text-xs font-medium text-accent hover:underline">
                      View
                    </button>
                  ) : (
                    <Link href={`/applications/${t.applicationId}?table=${t.tableName}`} className="text-xs font-medium text-accent hover:underline">
                      View
                    </Link>
                  )}
                </TD>
              )}
              {variant === "technical" && (
                <TD align="right" className="text-xs text-ink-3">
                  {formatRelative(t.lastCheckedAt)}
                </TD>
              )}
            </TR>
          );
        })}
      </tbody>
    </Table>
  );
}
