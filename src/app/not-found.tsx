import { LinkButton } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/States";

export default function NotFound() {
  return (
    <Card>
      <EmptyState title="Page not found" description="This page does not exist in UniqBotz Infrastructure." action={<LinkButton href="/">Go to overview</LinkButton>} />
    </Card>
  );
}
