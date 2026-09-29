"use client";

import { useEffect, useState, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { PrototypeBanner } from "./PrototypeBanner";
import { Sidebar } from "./Sidebar";
import { TopBar } from "./TopBar";

export function AppShell({ children }: { children: ReactNode }) {
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setMenuOpen(false);
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [menuOpen]);

  return (
    <div className="min-h-dvh lg:pl-64">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded focus:bg-surface focus:px-3 focus:py-2">
        Skip to content
      </a>

      <aside className="fixed inset-y-0 left-0 z-40 hidden w-64 lg:block">
        <Sidebar />
      </aside>

      {/* Tablet / small-laptop navigation drawer */}
      <div className={cn("fixed inset-0 z-50 lg:hidden", !menuOpen && "pointer-events-none")} aria-hidden={!menuOpen}>
        <div
          className={cn("absolute inset-0 bg-chrome/60 transition-opacity", menuOpen ? "opacity-100" : "opacity-0")}
          onClick={() => setMenuOpen(false)}
        />
        <aside
          className={cn("absolute inset-y-0 left-0 w-64 transition-transform", menuOpen ? "translate-x-0" : "-translate-x-full")}
          inert={!menuOpen}
        >
          <Sidebar onNavigate={() => setMenuOpen(false)} />
        </aside>
      </div>

      <div className="flex min-h-dvh min-w-0 flex-col">
        <TopBar onMenu={() => setMenuOpen(true)} />
        <PrototypeBanner />
        <main id="main" className="mx-auto w-full max-w-[1480px] flex-1 px-4 py-6 lg:px-6">
          {children}
        </main>
      </div>
    </div>
  );
}
