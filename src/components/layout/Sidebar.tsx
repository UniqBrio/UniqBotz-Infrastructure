"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Server } from "lucide-react";
import { useAlerts, useArchiveJobs, useRetentionPolicies } from "@/lib/data/hooks";
import { useIsLive } from "@/lib/data/DataProvider";
import { useScopedAppId } from "@/lib/data/scope";
import { isActiveJob } from "@/lib/domain/jobs";
import { cn } from "@/lib/cn";
import { NAV_SECTIONS, isActive, type NavItem } from "./navigation";

function useNavBadges(): Record<NonNullable<NavItem["badge"]>, number | undefined> {
  const appId = useScopedAppId();
  const alerts = useAlerts(appId);
  const jobs = useArchiveJobs(appId);
  const policies = useRetentionPolicies(appId);
  return {
    alerts: alerts.data?.filter((a) => a.state === "active").length,
    jobs: jobs.data?.filter(isActiveJob).length,
    review: policies.data?.filter((p) => p.policy === "review_required").length,
  };
}

export function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const live = useIsLive();
  const pathname = usePathname();
  const badges = useNavBadges();

  return (
    <nav aria-label="Primary" className="flex h-full flex-col bg-chrome text-chrome-ink">
      <div className="flex items-center gap-2.5 border-b border-chrome-line px-4 py-4">
        <div className="grid size-8 place-items-center rounded-md bg-chrome-2 ring-1 ring-chrome-line">
          <Server className="size-4 text-white" aria-hidden />
        </div>
        <div className="leading-tight">
          <div className="text-[13px] font-semibold text-white">UniqBotz Infrastructure</div>
          <div className="text-[11px] text-chrome-ink-2">Data Retention &amp; Archive</div>
        </div>
      </div>

      <div className="flex-1 space-y-5 overflow-y-auto px-2.5 py-4">
        {NAV_SECTIONS.map((section) => (
          <div key={section.title}>
            <div className="px-2 pb-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-chrome-ink-2">{section.title}</div>
            <ul className="space-y-0.5">
              {section.items.map((item) => {
                const active = isActive(pathname, item.href);
                const count = item.badge ? badges[item.badge] : undefined;
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      onClick={onNavigate}
                      aria-current={active ? "page" : undefined}
                      className={cn(
                        "group relative flex items-center gap-2.5 rounded-md px-2 py-1.5 text-[13px] transition-colors",
                        active ? "bg-chrome-2 font-medium text-white" : "hover:bg-chrome-2/60 hover:text-white",
                      )}
                    >
                      {active && <span aria-hidden className="absolute top-1.5 bottom-1.5 -left-2.5 w-0.5 rounded-r bg-accent" />}
                      <item.icon className={cn("size-4 shrink-0", active ? "text-white" : "text-chrome-ink-2 group-hover:text-chrome-ink")} aria-hidden />
                      <span className="flex-1 truncate">{item.label}</span>
                      {count !== undefined && count > 0 && (
                        <span
                          className={cn(
                            "num rounded px-1.5 text-[10px] font-semibold",
                            item.badge === "alerts" ? "bg-high/90 text-white" : "bg-chrome-line text-chrome-ink",
                          )}
                          aria-label={`${count} ${item.badge === "alerts" ? "active alerts" : item.badge === "jobs" ? "active jobs" : "tables need review"}`}
                        >
                          {count}
                        </span>
                      )}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>

      <div className="border-t border-chrome-line px-4 py-3 text-[11px] leading-relaxed text-chrome-ink-2">
        Internal control plane · not exposed in RosiFit, UniqBrio or Jalsa.
        <div className="mt-1 font-mono text-[10px]">{live ? "Phase 3B · live read-only" : "Phase 1 · UI prototype"}</div>
      </div>
    </nav>
  );
}
