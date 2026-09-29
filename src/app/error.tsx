"use client";

import { Card } from "@/components/ui/Card";
import { ErrorState } from "@/components/ui/States";

export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <Card>
      <ErrorState error={error} onRetry={reset} />
    </Card>
  );
}
