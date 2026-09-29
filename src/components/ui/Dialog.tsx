"use client";

import { X } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";
import { cn } from "@/lib/cn";

/**
 * Accessible modal / side-panel built on the native <dialog> element
 * (focus containment, Esc to close and inert background come for free).
 */
export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  variant = "modal",
  labelledBy,
  className,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  variant?: "modal" | "panel";
  labelledBy?: string;
  className?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-labelledby={labelledBy}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
      className={cn(
        "m-0 max-h-none max-w-none bg-transparent p-0 text-ink backdrop:backdrop-blur-[1px]",
        variant === "modal" && "fixed inset-0 m-auto h-fit w-[min(560px,calc(100vw-32px))]",
        variant === "panel" && "fixed top-0 right-0 left-auto h-dvh w-[min(560px,100vw)]",
      )}
    >
      {open && (
        <div
          className={cn(
            "flex flex-col border border-line bg-surface shadow-2xl",
            variant === "modal" ? "max-h-[calc(100dvh-48px)] rounded-lg" : "h-full",
            className,
          )}
        >
          <header className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
            <div>
              <h2 id={labelledBy} className="text-base font-semibold tracking-tight">
                {title}
              </h2>
              {description && <div className="mt-0.5 text-xs text-ink-3">{description}</div>}
            </div>
            <button type="button" onClick={onClose} className="rounded p-1 text-ink-3 hover:bg-neutral-soft hover:text-ink" aria-label="Close">
              <X className="size-4" aria-hidden />
            </button>
          </header>
          <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>
          {footer && <footer className="flex flex-wrap justify-end gap-2 border-t border-line bg-surface-2 px-5 py-3">{footer}</footer>}
        </div>
      )}
    </dialog>
  );
}
