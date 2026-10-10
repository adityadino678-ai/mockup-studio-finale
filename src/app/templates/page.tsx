import { PageHeader } from "@/components/layout/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { Boxes } from "lucide-react";

export default function Page() {
  return (
    <div className="mx-auto max-w-4xl p-8">
      <PageHeader title="Templates" description="Your reusable placement, collection and listing templates." />
      <EmptyState
        icon={<Boxes />}
        title="Templates"
        description="This section is being implemented in the current build."
      />
    </div>
  );
}
