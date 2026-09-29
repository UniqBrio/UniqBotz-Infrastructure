"use client";

import { Check, ChevronsUpDown, Layers } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { useApplicationHealthList } from "@/lib/data/hooks";
import { setAppScope, useAppScope } from "@/lib/data/scope";
import { cn } from "@/lib/cn";
import { SeverityBadge } from "@/components/status/SeverityBadge";

/**
 * Global application scope. Lists "All Applications" plus every registered
 * application from the data source — new applications appear automatically.
 */
export function ApplicationSwitcher() {
  const scope = useAppScope();
  const apps = useApplicationHealthList();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const listId = useId();

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const list = apps.data ?? [];
  const selected = list.find((h) => h.application.id === scope);
  const label = scope === "all" || !selected ? "All Applications" : selected.application.name;

  const choose = (id: string) => {
    setAppScope(id);
    setOpen(false);
  };

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen((o) => !o)}
        className="flex min-w-56 items-center gap-2 rounded-md border border-line-strong bg-surface px-2.5 py-1.5 text-left text-[13px] hover:bg-surface-2"
      >
        <Layers className="size-4 text-ink-3" aria-hidden />
        <span className="flex-1">
          <span className="block text-[10px] font-semibold uppercase leading-none tracking-wider text-ink-3">Scope</span>
          <span className="block font-semibold text-ink">{label}</span>
        </span>
        <ChevronsUpDown className="size-4 text-ink-3" aria-hidden />
      </button>
      {open && (
        <ul
          id={listId}
          role="listbox"
          aria-label="Application scope"
          className="absolute top-full left-0 z-40 mt-1 w-72 overflow-hidden rounded-md border border-line bg-surface py-1 shadow-lg"
        >
          <Option selected={scope === "all" || !selected} onSelect={() => choose("all")}>
            <span className="flex-1 font-medium">All Applications</span>
            <span className="num text-xs text-ink-3">{list.length}</span>
          </Option>
          <li role="separator" className="my-1 border-t border-line" />
          {apps.status === "error" && <li className="px-3 py-2 text-xs text-high-ink">Could not load applications.</li>}
          {apps.data === undefined && apps.status !== "error" && <li className="px-3 py-2 text-xs text-ink-3">Loading…</li>}
          {list.map((h) => (
            <Option key={h.application.id} selected={scope === h.application.id} onSelect={() => choose(h.application.id)}>
              <span className="flex-1 font-medium">{h.application.name}</span>
              <SeverityBadge severity={h.overallSeverity} size="xs" />
            </Option>
          ))}
        </ul>
      )}
    </div>
  );
}

function Option({ selected, onSelect, children }: { selected: boolean; onSelect: () => void; children: React.ReactNode }) {
  return (
    <li role="option" aria-selected={selected}>
      <button
        type="button"
        onClick={onSelect}
        className={cn("flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] hover:bg-surface-2", selected && "bg-accent-soft")}
      >
        <Check className={cn("size-3.5", selected ? "text-accent" : "invisible")} aria-hidden />
        {children}
      </button>
    </li>
  );
}
