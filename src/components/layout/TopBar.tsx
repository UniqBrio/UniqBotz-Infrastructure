"use client";

import { Activity, Menu, UserRound } from "lucide-react";
import { useApplicationHealthList, useSession } from "@/lib/data/hooks";
import { formatRelative } from "@/lib/domain/format";
import { ApplicationSwitcher } from "./ApplicationSwitcher";

export function TopBar({ onMenu }: { onMenu: () => void }) {
  const apps = useApplicationHealthList();
  const session = useSession().data;
  const who = session?.authenticated ? (session.email ?? session.subject) : "Operator";
  const badge = session?.authenticated ? (session.roles.length ? session.roles.join(" · ") : "NO ROLE") : "AUTH NOT CONFIGURED";
  const latest = apps.data
    ?.map((h) => h.application.lastHealthCheckAt)
    .sort()
    .at(-1);

  return (
    <header className="sticky top-0 z-30 flex items-center gap-3 border-b border-line bg-surface/95 px-4 py-2.5 backdrop-blur lg:px-6">
      <button
        type="button"
        onClick={onMenu}
        className="rounded-md p-1.5 text-ink-2 hover:bg-neutral-soft lg:hidden"
        aria-label="Open navigation"
      >
        <Menu className="size-5" aria-hidden />
      </button>
      <ApplicationSwitcher />
      <div className="ml-auto flex items-center gap-4 text-xs text-ink-3">
        <span className="hidden items-center gap-1.5 md:inline-flex" title="Most recent health check across applications (simulated)">
          <Activity className="size-3.5" aria-hidden />
          Last health check <span className="font-medium text-ink-2">{formatRelative(latest)}</span>
        </span>
        <span className="inline-flex items-center gap-1.5 rounded-md border border-line px-2 py-1" title={session?.notice ?? "Signed in; roles are granted in the control plane."}>
          <UserRound className="size-3.5" aria-hidden />
          <span className="hidden sm:inline">{who}</span>
          <span className="rounded bg-neutral-soft px-1 text-[10px] font-semibold text-ink-3">{badge}</span>
        </span>
      </div>
    </header>
  );
}
