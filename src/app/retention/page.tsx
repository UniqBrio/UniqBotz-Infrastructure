import type { Metadata } from "next";
import { RetentionView } from "@/components/views/RetentionView";

export const metadata: Metadata = { title: "Retention Configuration" };

export default function Page() {
  return <RetentionView />;
}
