import { Check, Clock, Minus, VolumeX, X } from "lucide-react";
import type { AlertNotification } from "@/lib/domain/types";
import { NOTIFICATION_LABEL } from "@/lib/domain/labels";
import { Badge, type Tone } from "@/components/ui/Badge";

const MAP: Record<AlertNotification["status"], { tone: Tone; Icon: typeof Check }> = {
  sent: { tone: "ok", Icon: Check },
  failed: { tone: "high", Icon: X },
  suppressed: { tone: "neutral", Icon: VolumeX },
  pending: { tone: "info", Icon: Clock },
  not_configured: { tone: "neutral", Icon: Minus },
};

export function NotificationStatusBadge({ status }: { status: AlertNotification["status"] }) {
  const { tone, Icon } = MAP[status];
  return (
    <Badge tone={tone} icon={<Icon className="size-3" aria-hidden />}>
      {NOTIFICATION_LABEL[status]}
    </Badge>
  );
}
