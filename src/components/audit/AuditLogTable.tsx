import Link from "next/link";
import { Bot, UserRound } from "lucide-react";
import type { AuditEntry, AuditResult } from "@/lib/domain/types";
import { AUDIT_ACTION_LABEL, AUDIT_RESULT_LABEL } from "@/lib/domain/labels";
import { formatDateTime } from "@/lib/domain/format";
import { Badge, type Tone } from "@/components/ui/Badge";
import { Table, TD, TH, THead, TR } from "@/components/ui/Table";
import { EmptyState } from "@/components/ui/States";

const RESULT_TONE: Record<AuditResult, Tone> = { success: "ok", failure: "high", blocked: "med", simulated: "info", info: "neutral" };

export function AuditLogTable({ entries, appNames, caption }: { entries: AuditEntry[]; appNames: Record<string, string>; caption: string }) {
  if (entries.length === 0) return <EmptyState title="No audit entries" description="Nothing matches the current scope and filters." />;
  return (
    <Table caption={caption}>
      <THead>
        <tr>
          <TH>Timestamp</TH>
          <TH>Application</TH>
          <TH>Action</TH>
          <TH>Table</TH>
          <TH>User / System</TH>
          <TH>Result</TH>
          <TH>Detail</TH>
        </tr>
      </THead>
      <tbody>
        {entries.map((e) => (
          <TR key={e.id} className="align-top">
            <TD className="whitespace-nowrap text-xs">
              <div className="num">{formatDateTime(e.at)}</div>
              <div className="font-mono text-[10px] text-ink-3">{e.id}</div>
            </TD>
            <TD className="whitespace-nowrap">{e.applicationId ? appNames[e.applicationId] ?? e.applicationId : <span className="text-ink-3">Global</span>}</TD>
            <TD className="whitespace-nowrap font-medium">{AUDIT_ACTION_LABEL[e.action]}</TD>
            <TD className="font-mono text-[12px]">{e.tableName ?? <span className="font-sans text-ink-3">—</span>}</TD>
            <TD className="whitespace-nowrap text-xs">
              <span className="inline-flex items-center gap-1">
                {e.actor.type === "user" ? <UserRound className="size-3.5 text-ink-3" aria-label="User" /> : <Bot className="size-3.5 text-ink-3" aria-label="System" />}
                {e.actor.name}
              </span>
            </TD>
            <TD>
              <Badge tone={RESULT_TONE[e.result]} size="xs">
                {AUDIT_RESULT_LABEL[e.result].toUpperCase()}
              </Badge>
            </TD>
            <TD className="min-w-64 text-xs text-ink-2">
              {e.detail}
              {e.jobId && (
                <>
                  {" "}
                  <Link href={`/archive-jobs/${e.jobId}`} className="font-mono font-medium text-accent hover:underline">
                    {e.jobId}
                  </Link>
                </>
              )}
            </TD>
          </TR>
        ))}
      </tbody>
    </Table>
  );
}
