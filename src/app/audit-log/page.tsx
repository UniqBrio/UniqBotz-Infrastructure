import type { Metadata } from "next";
import { AuditLogView } from "@/components/views/AuditLogView";

export const metadata: Metadata = { title: "Audit Log" };

export default function Page() {
  return <AuditLogView />;
}
