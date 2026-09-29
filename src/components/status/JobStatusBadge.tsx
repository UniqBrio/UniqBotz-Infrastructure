import { AlertOctagon, CheckCircle2, Clock, Eye, Loader2, ShieldCheck, Trash2 } from "lucide-react";
import type { ArchiveJobStatus } from "@/lib/domain/types";
import { JOB_STATUS_LABEL } from "@/lib/domain/labels";
import { Badge, type Tone } from "@/components/ui/Badge";

const MAP: Record<ArchiveJobStatus, { tone: Tone; Icon: typeof Clock }> = {
  preparing: { tone: "info", Icon: Clock },
  selecting: { tone: "info", Icon: Loader2 },
  exporting: { tone: "info", Icon: Loader2 },
  verifying: { tone: "info", Icon: ShieldCheck },
  ready_for_deletion: { tone: "low", Icon: Eye },
  deleting: { tone: "med", Icon: Trash2 },
  completed: { tone: "ok", Icon: CheckCircle2 },
  failed: { tone: "high", Icon: AlertOctagon },
  requires_review: { tone: "med", Icon: Eye },
};

export function JobStatusBadge({ status, size = "sm" }: { status: ArchiveJobStatus; size?: "xs" | "sm" | "md" }) {
  const { tone, Icon } = MAP[status];
  return (
    <Badge tone={tone} size={size} icon={<Icon className="size-3" aria-hidden />}>
      {JOB_STATUS_LABEL[status]}
    </Badge>
  );
}
