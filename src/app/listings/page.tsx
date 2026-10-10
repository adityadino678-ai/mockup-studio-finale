import { PageHeader } from "@/components/layout/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { ClipboardList } from "lucide-react";

export default function Page() {
  return (
    <div className="mx-auto max-w-4xl p-8">
      <PageHeader title="Listings" description="Etsy listing drafts with validation." />
      <EmptyState
        icon={<ClipboardList />}
        title="Listings"
        description="This section is being implemented in the current build."
      />
    </div>
  );
}
