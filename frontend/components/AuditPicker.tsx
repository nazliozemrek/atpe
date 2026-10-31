"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useCallback } from "react";
import { useApi } from "@/lib/api";
import { fmtDate } from "@/lib/format";
import type { AuditSummary } from "@/lib/types";

/** The audit selected via ?audit=<id>, shared by every page. */
export function useSelectedAudit() {
  const params = useSearchParams();
  const router = useRouter();
  const raw = params.get("audit");
  const id = raw && /^\d+$/.test(raw) ? Number(raw) : null;
  const select = useCallback(
    (next: number | null) => {
      const q = new URLSearchParams(params.toString());
      if (next === null) q.delete("audit");
      else q.set("audit", String(next));
      router.replace(`?${q.toString()}`, { scroll: false });
    },
    [params, router],
  );
  return { id, select };
}

export function AuditPicker({ value, onChange, audits }: { value: number | null; onChange: (id: number | null) => void; audits: AuditSummary[] }) {
  return (
    <select
      className="input min-w-0 flex-1 sm:w-auto sm:min-w-64 sm:flex-none"
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}
      aria-label="Select an audited draft"
    >
      <option value="">Select an audited draft…</option>
      {audits.map((a) => (
        <option key={a.id} value={a.id}>
          #{a.id} · {a.filename} · hook {Math.round(a.hook_score)} · {fmtDate(a.created_at)}
        </option>
      ))}
    </select>
  );
}

export function useAudits() {
  return useApi<AuditSummary[]>("/api/audits?limit=200");
}
