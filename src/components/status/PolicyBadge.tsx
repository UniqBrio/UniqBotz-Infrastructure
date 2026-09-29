import { Archive, Ban, HelpCircle } from "lucide-react";
import type { RetentionPolicyKind } from "@/lib/domain/types";
import { POLICY_DESCRIPTION, POLICY_LABEL } from "@/lib/domain/labels";
import { Badge, type Tone } from "@/components/ui/Badge";

const MAP: Record<RetentionPolicyKind, { tone: Tone; Icon: typeof Archive }> = {
  review_required: { tone: "low", Icon: HelpCircle },
  dont_archive: { tone: "neutral", Icon: Ban },
  archive: { tone: "info", Icon: Archive },
};

export function PolicyBadge({ policy, size = "sm" }: { policy: RetentionPolicyKind; size?: "xs" | "sm" | "md" }) {
  const { tone, Icon } = MAP[policy];
  return (
    <Badge tone={tone} size={size} title={POLICY_DESCRIPTION[policy]} icon={<Icon className="size-3" aria-hidden />}>
      {POLICY_LABEL[policy]}
    </Badge>
  );
}
