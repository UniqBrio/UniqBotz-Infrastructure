import { PlugZap, Unplug } from "lucide-react";
import type { ConnectionStatus } from "@/lib/domain/types";
import { CONNECTION_LABEL } from "@/lib/domain/labels";
import { Badge, DemoTag, type Tone } from "@/components/ui/Badge";

const TONE: Record<ConnectionStatus, Tone> = { connected: "ok", degraded: "med", disconnected: "high", not_configured: "neutral" };

/**
 * Supabase connection status. In Phase 1 every status is simulated, so the
 * badge always carries a DEMO marker — no real connection is implied.
 */
export function ConnectionBadge({ status, mock = true }: { status: ConnectionStatus; mock?: boolean }) {
  const Icon = status === "connected" || status === "degraded" ? PlugZap : Unplug;
  return (
    <span className="inline-flex items-center gap-1">
      <Badge tone={TONE[status]} icon={<Icon className="size-3" aria-hidden />}>
        {CONNECTION_LABEL[status]}
      </Badge>
      {mock && <DemoTag label="SIMULATED" />}
    </span>
  );
}
