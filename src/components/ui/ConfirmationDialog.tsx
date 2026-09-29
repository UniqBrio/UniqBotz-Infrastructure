"use client";

import { ShieldAlert } from "lucide-react";
import { useId, useState, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { Button } from "./Button";
import { Dialog } from "./Dialog";
import { TextInput } from "./Form";

/**
 * The only place an irreversible action button exists. The confirm button is
 * disabled until the operator types the exact confirmation phrase.
 */
export function ConfirmationDialog({
  open,
  onClose,
  onConfirm,
  title,
  children,
  confirmLabel,
  confirmPhrase,
  busy = false,
  tone = "danger",
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: ReactNode;
  children: ReactNode;
  confirmLabel: string;
  /** Text the operator must type to enable the confirm button. */
  confirmPhrase?: string;
  busy?: boolean;
  tone?: "danger" | "default";
}) {
  const id = useId();
  const [typed, setTyped] = useState("");
  const ready = !confirmPhrase || typed.trim() === confirmPhrase;
  const close = () => {
    setTyped("");
    onClose();
  };

  return (
    <Dialog
      open={open}
      onClose={close}
      labelledBy={`${id}-title`}
      title={
        <span className="flex items-center gap-2">
          {tone === "danger" && <ShieldAlert className="size-4 text-high" aria-hidden />}
          {title}
        </span>
      }
      footer={
        <>
          <Button onClick={close} disabled={busy}>
            Cancel
          </Button>
          <button
            type="button"
            disabled={!ready || busy}
            onClick={onConfirm}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-[13px] font-semibold disabled:cursor-not-allowed disabled:opacity-40",
              tone === "danger"
                ? "border-high bg-high text-white hover:bg-high-ink"
                : "border-accent bg-accent text-white hover:bg-accent-strong",
            )}
          >
            {busy ? "Working…" : confirmLabel}
          </button>
        </>
      }
    >
      {children}
      {confirmPhrase && (
        <div className="mt-4">
          <label htmlFor={`${id}-phrase`} className="mb-1 block text-xs font-semibold text-ink-2">
            Type <code className="rounded bg-neutral-soft px-1 font-mono text-[12px] text-ink">{confirmPhrase}</code> to enable confirmation
          </label>
          <TextInput
            id={`${id}-phrase`}
            autoComplete="off"
            spellCheck={false}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            className="font-mono"
          />
        </div>
      )}
    </Dialog>
  );
}
