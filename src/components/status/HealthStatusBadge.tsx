import { AlertOctagon, AlertTriangle, CheckCircle2, HelpCircle } from "lucide-react";
import type { HealthStatus } from "@/lib/domain/types";
import { Badge, type Tone } from "@/components/ui/Badge";

const MAP: Record<HealthStatus, { label: string; tone: Tone; Icon: typeof CheckCircle2 }> = {
  healthy: { label: "Healthy", tone: "ok", Icon: CheckCircle2 },
  attention: { label: "Needs attention", tone: "med", Icon: AlertTriangle },
  critical: { label: "Critical", tone: "high", Icon: AlertOctagon },
  unknown: { label: "Unknown", tone: "neutral", Icon: HelpCircle },
};

export function HealthStatusBadge({ status, size = "sm" }: { status: HealthStatus; size?: "xs" | "sm" | "md" }) {
  const { label, tone, Icon } = MAP[status];
  return (
    <Badge tone={tone} size={size} icon={<Icon className="size-3" aria-hidden />}>
      {label}
    </Badge>
  );
}
