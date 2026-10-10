import { PageHeader } from "@/components/layout/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { Search } from "lucide-react";

export default function Page() {
  return (
    <div className="mx-auto max-w-4xl p-8">
      <PageHeader title="AI SEO Studio" description="Keyword research and listing content drafts." />
      <EmptyState
        icon={<Search />}
        title="AI SEO Studio"
        description="This section is being implemented in the current build."
      />
    </div>
  );
}
