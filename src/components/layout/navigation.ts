import {
  Archive,
  Bell,
  Boxes,
  Database,
  History,
  LayoutDashboard,
  ListChecks,
  ScrollText,
  Settings,
  SlidersHorizontal,
  type LucideIcon,
} from "lucide-react";

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  badge?: "alerts" | "jobs" | "review";
}

export const NAV_SECTIONS: { title: string; items: NavItem[] }[] = [
  {
    title: "Monitor",
    items: [
      { href: "/", label: "Overview", icon: LayoutDashboard },
      { href: "/applications", label: "Applications", icon: Boxes },
      { href: "/database-health", label: "Database Health", icon: Database },
      { href: "/alerts", label: "Alerts", icon: Bell, badge: "alerts" },
    ],
  },
  {
    title: "Retention",
    items: [
      { href: "/retention", label: "Retention Configuration", icon: SlidersHorizontal, badge: "review" },
      { href: "/archive-candidates", label: "Archive Candidates", icon: ListChecks },
      { href: "/archive-jobs", label: "Archive Jobs", icon: Archive, badge: "jobs" },
      { href: "/archive-history", label: "Archive History", icon: History },
    ],
  },
  {
    title: "Governance",
    items: [
      { href: "/audit-log", label: "Audit Log", icon: ScrollText },
      { href: "/settings", label: "Settings", icon: Settings },
    ],
  },
];

export function isActive(pathname: string, href: string): boolean {
  return href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);
}
