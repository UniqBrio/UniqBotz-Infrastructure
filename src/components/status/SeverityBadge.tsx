import { AlertOctagon, AlertTriangle, CheckCircle2, CircleAlert } from "lucide-react";
import type { AlertLevel, Severity } from "@/lib/domain/types";
import { Badge, type Tone } from "@/components/ui/Badge";

export const SEVERITY_TONE: Record<Severity, Tone> = { NONE: "ok", LOW: "low", MEDIUM: "med", HIGH: "high" };

const ICON = { NONE: CheckCircle2, LOW: CircleAlert, MEDIUM: AlertTriangle, HIGH: AlertOctagon } as const;

/** Severity is always shown as icon + text — never colour alone. */
export function SeverityBadge({
  severity,
  size = "sm",
  noneLabel = "OK",
}: {
  severity: Severity | AlertLevel;
  size?: "xs" | "sm" | "md";
  /** Label used when below the LOW threshold. */
  noneLabel?: string;
}) {
  const Icon = ICON[severity];
  return (
    <Badge
      tone={SEVERITY_TONE[severity]}
      size={size}
      icon={<Icon className={size === "md" ? "size-3.5" : "size-3"} aria-hidden />}
      title={severity === "NONE" ? "Below the LOW threshold" : `${severity} severity`}
    >
      {severity === "NONE" ? noneLabel : severity}
    </Badge>
  );
}

export function ResolvedBadge({ size = "sm" }: { size?: "xs" | "sm" | "md" }) {
  return (
    <Badge tone="neutral" size={size} icon={<CheckCircle2 className="size-3" aria-hidden />}>
      RESOLVED
    </Badge>
  );
}
