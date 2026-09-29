import type { ReactNode, ThHTMLAttributes, TdHTMLAttributes, HTMLAttributes } from "react";
import { cn } from "@/lib/cn";

/** Dense, readable data table primitives shared by every table in the app. */
export function Table({ children, className, caption }: { children: ReactNode; className?: string; caption?: string }) {
  return (
    <div className="relative overflow-x-auto">
      <table className={cn("w-full border-collapse text-[13px]", className)}>
        {caption && <caption className="sr-only">{caption}</caption>}
        {children}
      </table>
    </div>
  );
}

export function THead({ children }: { children: ReactNode }) {
  return <thead className="bg-surface-2 text-left">{children}</thead>;
}

export function TH({ className, align, ...rest }: ThHTMLAttributes<HTMLTableCellElement> & { align?: "right" | "center" }) {
  return (
    <th
      scope="col"
      className={cn(
        "whitespace-nowrap border-b border-line px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-ink-3",
        align === "right" && "text-right",
        align === "center" && "text-center",
        className,
      )}
      {...rest}
    />
  );
}

export function TR({ className, ...rest }: HTMLAttributes<HTMLTableRowElement>) {
  return <tr className={cn("border-b border-line last:border-b-0", className)} {...rest} />;
}

export function TD({ className, align, ...rest }: TdHTMLAttributes<HTMLTableCellElement> & { align?: "right" | "center" }) {
  return (
    <td
      className={cn("px-3 py-2 align-middle", align === "right" && "num text-right", align === "center" && "text-center", className)}
      {...rest}
    />
  );
}
