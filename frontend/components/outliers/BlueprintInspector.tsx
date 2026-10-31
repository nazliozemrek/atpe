"use client";

import { ExternalLink, Trash2, X } from "lucide-react";
import { Area, AreaChart, CartesianGrid, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Card, Empty, Stat } from "@/components/ui";
import { apiSend, useApi } from "@/lib/api";
import { fmtCompact, fmtMs, fmtNum, fmtSec } from "@/lib/format";
import type { Blueprint, GoldenTargets } from "@/lib/types";

function Cadence({ cuts, duration, firstCutTarget }: { cuts: number[]; duration: number; firstCutTarget: number | null }) {
  const pct = (t: number) => `${Math.min(100, (t / Math.max(duration, 0.001)) * 100)}%`;
  const ticks = Array.from({ length: Math.floor(duration / 5) + 1 }, (_, i) => i * 5);
  return (
    <div>
      <div className="relative h-10 rounded-md bg-zinc-950 ring-1 ring-zinc-800">
        <div className="absolute inset-y-0 left-0 bg-violet-400/10" style={{ width: pct(1.7) }} title="1.7s hook gate" />
        <div className="absolute inset-y-0 left-0 border-r border-dashed border-zinc-500 bg-zinc-100/5" style={{ width: pct(3) }} title="3s hook transcript" />
        {firstCutTarget !== null && (
          <div className="absolute inset-y-0 w-px bg-emerald-400/60" style={{ left: pct(firstCutTarget) }} title={`Niche first-cut target ${firstCutTarget}s`} />
        )}
        {cuts.map((c, i) => (
          <div key={i} className="absolute top-1 h-8 w-0.5 rounded bg-amber-300" style={{ left: pct(c) }} title={`Cut at ${c.toFixed(2)}s`} />
        ))}
      </div>
      <div className="relative mt-1 h-4 text-[10px] text-zinc-500">
        {ticks.map((t) => (
          <span key={t} className="absolute -translate-x-1/2" style={{ left: pct(t) }}>
            {t}s
          </span>
        ))}
      </div>
    </div>
  );
}

export function BlueprintInspector({
  id,
  golden,
  onClose,
  onDeleted,
}: {
  id: number;
  golden: GoldenTargets | null;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const bp = useApi<Blueprint>(`/api/outlier/blueprints/${id}`);
  if (bp.error) return <Empty>{bp.error}</Empty>;
  if (!bp.data) return <Card title="Blueprint">Loading…</Card>;
  const b = bp.data;
  const tel = b.telemetry;
  const duration = b.duration_sec ?? (tel?.rms_energy_curve_100ms.length ?? 0) * 0.1;

  const remove = async () => {
    if (!confirm("Delete this blueprint from the niche benchmark?")) return;
    await apiSend(`/api/outlier/blueprints/${id}`, "DELETE");
    onDeleted();
  };

  return (
    <Card
      className="border-emerald-500/30"
      title={
        <span className="flex items-center gap-2">
          <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 font-mono text-xs text-emerald-300">{b.outlier_score}x</span>
          <span className="line-clamp-1">{b.title || b.video_id}</span>
        </span>
      }
      action={
        <div className="flex items-center gap-1">
          <a className="btn-ghost px-2 py-1 text-xs" href={b.webpage_url} target="_blank" rel="noreferrer">
            <ExternalLink className="h-3.5 w-3.5" /> Open
          </a>
          <button className="btn-ghost px-2 py-1 text-xs" onClick={remove} aria-label="Delete blueprint">
            <Trash2 className="h-3.5 w-3.5" />
          </button>
          <button className="btn-ghost px-2 py-1 text-xs" onClick={onClose} aria-label="Close inspector">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      }
    >
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4 xl:grid-cols-8">
        <Stat label="Views" value={fmtCompact(b.views)} hint={b.views_estimated ? "estimated from likes" : `baseline ${fmtCompact(b.baseline)}`} />
        <Stat label="Engagement velocity" value={fmtNum(b.engagement_velocity, 1)} hint="(L + 3C + 5R) / views × 1000" />
        <Stat label="Cuts / min" value={fmtNum(b.cuts_per_minute, 1)} hint={`${b.total_cuts} cuts`} />
        <Stat label="Avg shot" value={fmtSec(b.avg_shot_length_sec)} hint={`longest ${fmtSec(b.max_static_gap_sec)}`} />
        <Stat label="First cut" value={fmtSec(b.first_cut_timestamp_sec)} />
        <Stat label="Audio onset" value={fmtMs(b.audio_onset_latency_ms)} />
        <Stat label="Hook flow" value={`${fmtNum(b.hook_optical_flow_score, 0)}/100`} />
        <Stat label="WPM" value={fmtNum(b.speaking_wpm, 0)} />
      </div>

      <div className="mt-5">
        <div className="label mb-2">3-second hook</div>
        <blockquote className="rounded-lg border-l-2 border-emerald-400 bg-zinc-950 px-4 py-3 text-base text-zinc-100">
          {b.hook_transcript_3s ? `“${b.hook_transcript_3s}”` : <span className="text-sm text-zinc-500">No speech in the first 3 seconds (or transcription was off).</span>}
        </blockquote>
      </div>

      <div className="mt-5">
        <div className="label mb-2">Cut cadence · {fmtSec(duration, 1)}</div>
        <Cadence cuts={tel?.cut_timestamps_sec ?? []} duration={duration} firstCutTarget={golden?.targets.target_first_cut_before_sec ?? null} />
      </div>

      <div className="mt-4">
        <div className="label mb-2">RMS energy, 100 ms windows</div>
        <div className="h-48">
          <ResponsiveContainer>
            <AreaChart data={tel?.rms_energy_curve_100ms ?? []} margin={{ top: 4, right: 4, bottom: 0, left: -18 }}>
              <defs>
                <linearGradient id="bpRms" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#fbbf24" stopOpacity={0.4} />
                  <stop offset="100%" stopColor="#fbbf24" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke="#27272a" vertical={false} />
              <XAxis dataKey="t" type="number" domain={[0, "dataMax"]} tickFormatter={(v: number) => `${v.toFixed(0)}s`} stroke="#71717a" fontSize={11} />
              <YAxis domain={[-90, 0]} stroke="#71717a" fontSize={11} />
              <Tooltip labelFormatter={(v) => `${Number(v).toFixed(1)}s`} formatter={(v: number) => [`${v.toFixed(1)} dB`, "RMS"]} contentStyle={{ background: "#18181b", border: "1px solid #3f3f46", borderRadius: 8 }} />
              {(tel?.cut_timestamps_sec ?? []).map((c, i) => (
                <ReferenceLine key={i} x={c} stroke="#fbbf24" strokeOpacity={0.25} />
              ))}
              <Area type="monotone" dataKey="db" stroke="#fbbf24" fill="url(#bpRms)" strokeWidth={1.5} isAnimationActive={false} />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </div>

      {tel?.full_transcript && (
        <details className="mt-4">
          <summary className="cursor-pointer text-sm text-zinc-400 hover:text-zinc-200">Full transcript</summary>
          <p className="mt-2 text-sm leading-6 text-zinc-300">{tel.full_transcript}</p>
        </details>
      )}
    </Card>
  );
}
