"use client";

import { Search } from "lucide-react";
import { useId, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes } from "react";
import { cn } from "@/lib/cn";

const control =
  "w-full rounded-md border border-line-strong bg-surface px-2.5 py-1.5 text-[13px] text-ink placeholder:text-ink-3 disabled:bg-surface-2 disabled:text-ink-3 aria-[invalid=true]:border-high";

export function Field({
  label,
  hint,
  error,
  children,
  htmlFor,
  className,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: string;
  children: ReactNode;
  htmlFor?: string;
  className?: string;
}) {
  return (
    <div className={className}>
      <label htmlFor={htmlFor} className="mb-1 block text-xs font-semibold text-ink-2">
        {label}
      </label>
      {children}
      {error ? (
        <p className="mt-1 text-xs font-medium text-high-ink" role="alert">
          {error}
        </p>
      ) : (
        hint && <p className="mt-1 text-xs text-ink-3">{hint}</p>
      )}
    </div>
  );
}

export function TextInput({ className, invalid, ...rest }: InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }) {
  return <input className={cn(control, className)} aria-invalid={invalid || undefined} {...rest} />;
}

export function NumberInput({
  value,
  onValueChange,
  invalid,
  className,
  suffix,
  ...rest
}: Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "type"> & {
  value: number | null;
  onValueChange: (v: number | null) => void;
  invalid?: boolean;
  suffix?: string;
}) {
  return (
    <div className="relative">
      <input
        type="number"
        inputMode="numeric"
        className={cn(control, "num", suffix && "pr-16", className)}
        aria-invalid={invalid || undefined}
        value={value ?? ""}
        onChange={(e) => onValueChange(e.target.value === "" ? null : Number(e.target.value))}
        {...rest}
      />
      {suffix && (
        <span className="pointer-events-none absolute inset-y-0 right-2.5 flex items-center text-xs text-ink-3">{suffix}</span>
      )}
    </div>
  );
}

export function Select({ className, invalid, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement> & { invalid?: boolean }) {
  return (
    <select className={cn(control, "pr-8", className)} aria-invalid={invalid || undefined} {...rest}>
      {children}
    </select>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
  disabled,
  description,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  disabled?: boolean;
  description?: ReactNode;
}) {
  const id = useId();
  return (
    <div className="flex items-start gap-3">
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn(
          "relative mt-0.5 inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors disabled:cursor-not-allowed disabled:opacity-60",
          checked ? "border-accent bg-accent" : "border-line-strong bg-neutral-soft",
        )}
      >
        <span
          aria-hidden
          className={cn("inline-block size-3.5 rounded-full bg-white shadow transition-transform", checked ? "translate-x-4.5" : "translate-x-0.5")}
        />
      </button>
      <div>
        <label htmlFor={id} className="text-[13px] font-medium text-ink">
          {label} <span className="font-normal text-ink-3">· {checked ? "On" : "Off"}</span>
        </label>
        {description && <p className="text-xs text-ink-3">{description}</p>}
      </div>
    </div>
  );
}

export function SegmentedControl<T extends string>({
  value,
  onChange,
  options,
  label,
  size = "md",
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: ReactNode; count?: number }[];
  label: string;
  size?: "sm" | "md";
}) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex flex-wrap rounded-md border border-line-strong bg-surface-2 p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            "inline-flex items-center gap-1.5 rounded px-2.5 font-medium transition-colors",
            size === "sm" ? "py-0.5 text-xs" : "py-1 text-[13px]",
            value === o.value ? "bg-surface text-ink shadow-sm ring-1 ring-line" : "text-ink-3 hover:text-ink",
          )}
        >
          {o.label}
          {o.count !== undefined && <span className="num text-[11px] text-ink-3">{o.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function SearchInput({
  value,
  onChange,
  placeholder = "Search…",
  label = "Search",
  className,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  label?: string;
  className?: string;
}) {
  return (
    <div className={cn("relative", className)}>
      <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-ink-3" aria-hidden />
      <input
        type="search"
        aria-label={label}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className={cn(control, "pl-8")}
      />
    </div>
  );
}
