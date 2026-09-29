import type { Metadata } from "next";
import { DatabaseHealthView } from "@/components/views/DatabaseHealthView";

export const metadata: Metadata = { title: "Database Health" };

export default function Page() {
  return <DatabaseHealthView />;
}
