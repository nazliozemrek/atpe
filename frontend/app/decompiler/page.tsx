"use client";

import { Link2, Trash2 } from "lucide-react";
import { Suspense, useState } from "react";
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { AuditPicker, useAudits, useSelectedAudit } from "@/components/AuditPicker";
import { Card, Empty, JobStatus, PageHeader, ScoreRing } from "@/components/ui";
import { UploadDrop } from "@/components/UploadDrop";
import { apiSend, apiUpload, useApi, useJob } from "@/lib/api";
import { fmtCompact, fmtDate, fmtNum, fmtSec } from "@/lib/format";
import type { Benchmark, TemplateSummary } from "@/lib/types";

const METRIC_LABELS: Record<string, string> = {
  hook_score: "Hook score",
  loop_score: "Loop score",
  cuts_per_minute: "Cuts / minute",
  avg_shot_length_s: "Avg shot length (s)",
  first_cut_s: "First cut (s)",
  onset_latency_ms: "Audio onset (ms)",
  wpm: "Words / minute",
  duration_s: "Duration (s)",
  stagnation_seconds: "Stagnation (s)",
};

function CadenceStrip({ label, marks, color }: { label: string; marks: number[]; color: string }) {
  return (
    <div>
      <div className="label mb-1">{label}</div>
      <div className="relative h-6 rounded bg-zinc-950 ring-1 ring-zinc-800">
        {marks.map((m, i) => (
          <span key={i} className="absolute top-0 h-full w-0.5" style={{ left: `${Math.min(99.6, m * 100)}%`, background: color }} />
        ))}
      </div>
    </div>
  );
}

function Comparison({ auditId, templateId }: { auditId: number; templateId: number }) {
  const bench = useApi<Benchmark>(`/api/audits/${auditId}/benchmark/${templateId}`);
  if (bench.error) return <Empty>{bench.error}</Empty>;
  if (!bench.data) return <Empty>Comparing…</Empty>;
  const c = bench.data.comparison;
  return (
    <div className="space-y-6">
      <div className="grid gap-4 md:grid-cols-[260px_minmax(0,1fr)]">
        <Card>
          <ScoreRing value={c.template_match_score} label="Template match" sub={`energy r ${fmtNum(c.energy_correlation, 2)} · motion r ${fmtNum(c.motion_correlation, 2)}`} />
        </Card>
        <Card title="What to change">
          {c.actions.length ? (
            <ul className="list-disc space-y-1.5 pl-5 text-sm text-zinc-300">
              {c.actions.map((a) => (
                <li key={a}>{a}</li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-zinc-400">Your draft already tracks this template closely.</p>
          )}
        </Card>
      </div>

      <div className="grid gap-6 xl:grid-cols-2">
        <Card title="Energy & motion arcs (relative runtime)">
          <div className="h-72">
            <ResponsiveContainer>
              <LineChart data={c.overlay} margin={{ top: 8, right: 8, bottom: 0, left: -12 }}>
                <CartesianGrid stroke="#27272a" vertical={false} />
                <XAxis dataKey="x" type="number" domain={[0, 1]} tickFormatter={(v: number) => `${Math.round(v * 100)}%`} stroke="#71717a" fontSize={11} />
                <YAxis yAxisId="db" domain={[-90, 0]} stroke="#71717a" fontSize={11} />
                <YAxis yAxisId="m" orientation="right" domain={[0, 100]} stroke="#71717a" fontSize={11} />
                <Tooltip labelFormatter={(v) => `${Math.round(Number(v) * 100)}% of runtime`} contentStyle={{ background: "#18181b", border: "1px solid #3f3f46", borderRadius: 8 }} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Line yAxisId="db" dataKey="template_energy_db" name="Template dB" stroke="#fbbf24" dot={false} strokeWidth={2} isAnimationActive={false} />
                <Line yAxisId="db" dataKey="draft_energy_db" name="Draft dB" stroke="#38bdf8" dot={false} strokeWidth={2} isAnimationActive={false} />
                <Line yAxisId="m" dataKey="template_motion" name="Template motion" stroke="#fbbf24" strokeDasharray="4 3" dot={false} isAnimationActive={false} />
                <Line yAxisId="m" dataKey="draft_motion" name="Draft motion" stroke="#34d399" strokeDasharray="4 3" dot={false} isAnimationActive={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </Card>
        <Card title="Telemetry side by side">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left">
                <th className="label pb-2">Metric</th>
                <th className="label pb-2 text-right">Draft</th>
                <th className="label pb-2 text-right">Template</th>
                <th className="label pb-2 text-right">Gap</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800">
              {c.metrics.map((m) => (
                <tr key={m.metric}>
                  <td className="py-1.5 text-zinc-300">{METRIC_LABELS[m.metric] ?? m.metric}</td>
                  <td className="mono py-1.5 text-right">{fmtNum(m.draft, 2)}</td>
                  <td className="mono py-1.5 text-right text-zinc-400">{fmtNum(m.template, 2)}</td>
                  <td className="mono py-1.5 text-right text-zinc-500">{m.gap === null ? "—" : `${m.gap > 0 ? "+" : ""}${Math.round(m.gap * 100)}%`}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="mt-4 space-y-3">
            <CadenceStrip label="Template cuts" marks={c.cadence.template_relative} color="#fbbf24" />
            <CadenceStrip label="Draft cuts" marks={c.cadence.draft_relative} color="#34d399" />
          </div>
        </Card>
      </div>
    </div>
  );
}

function Decompiler() {
  const { id: auditId, select } = useSelectedAudit();
  const audits = useAudits();
  const templates = useApi<TemplateSummary[]>("/api/templates");
  const job = useJob<{ template_id: number }>();
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [niche, setNiche] = useState("");
  const [templateId, setTemplateId] = useState<number | null>(null);

  const finish = async (res: { template_id: number } | null) => {
    if (!res) return;
    await templates.reload();
    setTemplateId(res.template_id);
    setUrl("");
    setName("");
  };

  const fromUrl = async () => {
    if (!url.trim()) return;
    await finish(await job.run(() => apiSend("/api/templates/from-url", "POST", { url: url.trim(), name: name || null, niche: niche || null })));
  };

  const fromFile = async (file: File) => {
    const form = new FormData();
    form.append("file", file);
    if (name) form.append("name", name);
    if (niche) form.append("niche", niche);
    await finish(await job.run(() => apiUpload("/api/templates/from-file", form)));
  };

  const remove = async (id: number) => {
    if (!confirm("Delete this template?")) return;
    await apiSend(`/api/templates/${id}`, "DELETE");
    if (templateId === id) setTemplateId(null);
    await templates.reload();
  };

  return (
    <>
      <PageHeader
        title="Competitor Viral Decompiler"
        subtitle="Decompile a viral Reel or TikTok into its cut cadence, energy curve and hook structure, save it as a template, and benchmark your draft against it."
      />
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_380px]">
        <Card title="Decompile a reference">
          <div className="flex flex-col gap-2 sm:flex-row">
            <input className="input" placeholder="https://www.tiktok.com/@creator/video/… or Instagram Reel URL" value={url} onChange={(e) => setUrl(e.target.value)} />
            <button className="btn-primary shrink-0" onClick={fromUrl} disabled={job.running || !url.trim()}>
              <Link2 className="h-4 w-4" />
              Decompile URL
            </button>
          </div>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            <input className="input" placeholder="Template name (optional)" value={name} onChange={(e) => setName(e.target.value)} />
            <input className="input" placeholder="Niche (optional)" value={niche} onChange={(e) => setNiche(e.target.value)} />
          </div>
          <div className="mt-3">
            <UploadDrop onFile={fromFile} disabled={job.running} title="Or drop a reference video file" />
          </div>
          <div className="mt-3">
            <JobStatus job={job.job} error={job.error} running={job.running} />
          </div>
        </Card>

        <Card title={`Viral templates (${templates.data?.length ?? 0})`}>
          {templates.data?.length ? (
            <ul className="max-h-[420px] space-y-2 overflow-y-auto pr-1">
              {templates.data.map((t) => (
                <li key={t.id}>
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={() => setTemplateId(t.id)}
                    onKeyDown={(e) => e.key === "Enter" && setTemplateId(t.id)}
                    className={`cursor-pointer rounded-lg border px-3 py-2 text-sm transition ${templateId === t.id ? "border-amber-400/60 bg-amber-400/5" : "border-zinc-800 hover:border-zinc-600"}`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <span className="line-clamp-2 font-medium">{t.name}</span>
                      <button
                        className="shrink-0 text-zinc-500 hover:text-rose-400"
                        onClick={(e) => {
                          e.stopPropagation();
                          void remove(t.id);
                        }}
                        aria-label={`Delete ${t.name}`}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                    <div className="mt-1 text-xs text-zinc-500">
                      {t.platform} · {fmtNum(t.cuts_per_minute, 0)} cuts/min · {fmtSec(t.avg_shot_length_s)} shots
                      {typeof t.source_stats.view_count === "number" && ` · ${fmtCompact(t.source_stats.view_count as number)} views`}
                      {t.niche && ` · ${t.niche}`} · {fmtDate(t.created_at)}
                    </div>
                    {t.hook_text && <div className="mt-1 line-clamp-2 text-xs italic text-zinc-400">“{t.hook_text}”</div>}
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <Empty>No templates yet.</Empty>
          )}
        </Card>
      </div>

      <div className="mt-8">
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <h2 className="text-base font-semibold">Benchmark your draft</h2>
          <AuditPicker value={auditId} onChange={select} audits={audits.data ?? []} />
          <select className="input min-w-0 flex-1 sm:w-auto sm:min-w-56 sm:flex-none" value={templateId ?? ""} onChange={(e) => setTemplateId(e.target.value ? Number(e.target.value) : null)} aria-label="Template">
            <option value="">Select a template…</option>
            {templates.data?.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </div>
        {auditId && templateId ? <Comparison key={`${auditId}-${templateId}`} auditId={auditId} templateId={templateId} /> : <Empty>Pick a draft and a template to compare them.</Empty>}
      </div>
    </>
  );
}

export default function Page() {
  return (
    <Suspense fallback={null}>
      <Decompiler />
    </Suspense>
  );
}
