"use client";

import { Suspense } from "react";
import { AuditPicker, useAudits, useSelectedAudit } from "@/components/AuditPicker";
import { CopyPanel } from "@/components/CopyPanel";
import { Exporter } from "@/components/Exporter";
import { SafeZonePreviewer } from "@/components/SafeZonePreviewer";
import { Empty, PageHeader } from "@/components/ui";
import { useApi } from "@/lib/api";
import type { Audit } from "@/lib/types";

function Studio() {
  const { id, select } = useSelectedAudit();
  const audits = useAudits();
  const audit = useApi<Audit>(id ? `/api/audits/${id}` : null);

  return (
    <>
      <PageHeader
        title="Safe Zones & Export"
        subtitle="Check that nothing important sits under the TikTok or Reels UI, export a trimmed, loudness-normalized 1080×1920 master, and generate captions."
      >
        <div className="flex w-full sm:w-auto">
          <AuditPicker value={id} onChange={select} audits={audits.data ?? []} />
        </div>
      </PageHeader>
      {!id && <Empty>Pick an audited draft to preview and export it.</Empty>}
      {audit.error && <Empty>{audit.error}</Empty>}
      {audit.data && audit.data.id === id && (
        <div className="space-y-6">
          <SafeZonePreviewer key={id} auditId={id} />
          <Exporter auditId={id} report={audit.data.report} />
          <CopyPanel auditId={id} />
        </div>
      )}
    </>
  );
}

export default function Page() {
  return (
    <Suspense fallback={null}>
      <Studio />
    </Suspense>
  );
}
