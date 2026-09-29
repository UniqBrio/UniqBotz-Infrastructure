import { ArrowRight, Database, ShieldCheck, UserCheck } from "lucide-react";

/** Explains who decides what: discovery finds tables, the operator sets policy. */
export function RetentionFlowStrip() {
  const steps = [
    { Icon: Database, title: "Supabase discovers tables", body: "Each application's schema is read. New tables default to Review Required." },
    { Icon: UserCheck, title: "Operator decides the policy", body: "Archive, Don't Archive or Review Required — per application, per table." },
    { Icon: ShieldCheck, title: "Only Archive + Enabled enters the engine", body: "Unknown and excluded tables are never touched." },
  ];
  return (
    <ol className="grid gap-2 rounded-lg border border-line bg-surface p-3 md:grid-cols-[1fr_auto_1fr_auto_1fr] md:items-center">
      {steps.map((s, i) => (
        <li key={s.title} className="contents">
          <div className="flex items-start gap-2.5">
            <div className="grid size-7 shrink-0 place-items-center rounded-md bg-surface-2 ring-1 ring-line">
              <s.Icon className="size-3.5 text-ink-2" aria-hidden />
            </div>
            <div>
              <div className="text-[13px] font-semibold">
                <span className="num mr-1 text-ink-3">{i + 1}.</span>
                {s.title}
              </div>
              <div className="text-xs text-ink-3">{s.body}</div>
            </div>
          </div>
          {i < steps.length - 1 && <ArrowRight className="hidden size-4 text-ink-3 md:block" aria-hidden />}
        </li>
      ))}
    </ol>
  );
}
