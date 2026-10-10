import { PageHeader } from "@/components/layout/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { Store } from "lucide-react";

export default function Page() {
  return (
    <div className="mx-auto max-w-4xl p-8">
      <PageHeader title="Product Builder" description="Prepare Printify products from your designs." />
      <EmptyState
        icon={<Store />}
        title="Product Builder"
        description="This section is being implemented in the current build."
      />
    </div>
  );
}
