import { PageHeader } from "@/components/layout/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { Layers } from "lucide-react";

export default function BatchPage() {
  return (
    <div className="mx-auto max-w-4xl p-8">
      <PageHeader title="Batch Studio" description="Generate many mockups from designs × mockup combinations." />
      <EmptyState
        icon={<Layers />}
        title="Batch Studio"
        description="Bulk mockup generation is being implemented in this build — designs and mockup libraries plus the editor are the inputs it will use."
      />
    </div>
  );
}
