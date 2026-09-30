"use client";

import { FlaskConical, Radio } from "lucide-react";
import { useDataContext } from "@/lib/data/DataProvider";

/** Persistent, non-dismissible notice of what is (and is not) live. */
export function PrototypeBanner() {
  const { source } = useDataContext();
  if (source.mode === "live") {
    return (
      <div role="note" className="flex items-center gap-2 border-b border-ok-line bg-ok-soft px-4 py-1.5 text-xs text-ok-ink lg:px-6">
        <Radio className="size-3.5 shrink-0" aria-hidden />
        <p>
          <strong className="font-semibold">LIVE · READ-ONLY monitoring.</strong> Data comes from the control plane (collected by the
          worker). Archive execution and deletion are disabled here (ALLOW_DELETION=false); policy editing needs authentication, which is
          not implemented yet. No notifications or schedules are active.
        </p>
      </div>
    );
  }
  return (
    <div role="note" className="flex items-center gap-2 border-b border-info-line bg-info-soft px-4 py-1.5 text-xs text-info-ink lg:px-6">
      <FlaskConical className="size-3.5 shrink-0" aria-hidden />
      <p>
        <strong className="font-semibold">Prototype · mock data.</strong> No Supabase project, storage, worker or WhatsApp
        integration is connected. Archive and deletion actions are simulated and cannot modify any database.
      </p>
    </div>
  );
}
