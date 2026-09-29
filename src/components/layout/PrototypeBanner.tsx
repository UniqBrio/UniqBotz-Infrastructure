import { FlaskConical } from "lucide-react";

/** Persistent, non-dismissible notice: nothing on screen is live. */
export function PrototypeBanner() {
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
