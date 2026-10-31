"use client";

import { Crosshair } from "lucide-react";
import { Card } from "@/components/ui";
import { fmtNum } from "@/lib/format";
import type { GoldenKey, GoldenTargets } from "@/lib/types";

const TILES: { key: GoldenKey; label: string; unit: string; prefix: string; digits: number }[] = [
  { key: "target_cuts_per_minute", label: "Cuts / minute", unit: "/min", prefix: "≥", digits: 1 },
  { key: "target_avg_shot_length_sec", label: "Avg shot length", unit: "s", prefix: "≤", digits: 2 },
  { key: "target_first_cut_before_sec", label: "First cut before", unit: "s", prefix: "≤", digits: 2 },
  { key: "target_max_audio_latency_ms", label: "Max audio latency", unit: "ms", prefix: "≤", digits: 0 },
  { key: "target_hook_optical_flow", label: "Hook optical flow", unit: "/100", prefix: "≥", digits: 0 },
  { key: "target_speaking_wpm", label: "Speaking pace", unit: "wpm", prefix: "≈", digits: 0 },
];

/** Golden Target Metrics aggregated over every stored 10x+ blueprint. */
export function GoldenHud({
  golden,
  niche,
  niches,
  onNiche,
}: {
  golden: GoldenTargets | null;
  niche: string;
  niches: string[];
  onNiche: (n: string) => void;
}) {
  return (
    <Card
      className="border-emerald-500/30 bg-gradient-to-br from-emerald-500/[0.07] to-transparent"
      title={
        <span className="flex items-center gap-2">
          <Crosshair className="h-4 w-4 text-emerald-400" />
          Golden niche benchmark
          <span className="font-normal text-zinc-500">
            · {golden?.sample_size ?? 0} decompiled 10x+ outlier{golden?.sample_size === 1 ? "" : "s"}
            {golden?.creators?.length ? ` from ${golden.creators.length} creator${golden.creators.length === 1 ? "" : "s"}` : ""}
          </span>
        </span>
      }
      action={
        <select className="input w-auto py-1.5 text-xs" value={niche} onChange={(e) => onNiche(e.target.value)} aria-label="Niche">
          <option value="">All niches</option>
          {niches.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      }
    >
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        {TILES.map((t) => {
          const v = golden?.targets[t.key] ?? null;
          const s = golden?.spread[t.key];
          return (
            <div key={t.key} className="rounded-lg border border-zinc-800 bg-zinc-950/70 px-3 py-2.5">
              <div className="label">{t.label}</div>
              <div className="mt-1 font-mono text-xl font-semibold text-emerald-300">
                {v === null ? "—" : `${t.prefix} ${fmtNum(v, t.digits)}`}
                <span className="ml-1 text-xs font-normal text-zinc-500">{v === null ? "" : t.unit}</span>
              </div>
              <div className="mt-0.5 text-[11px] text-zinc-500">
                {s && s.n ? `p25–p75 ${fmtNum(s.p25, t.digits)}–${fmtNum(s.p75, t.digits)} · n=${s.n}` : "no data yet"}
              </div>
            </div>
          );
        })}
      </div>
      <p className="mt-3 text-xs text-zinc-500">
        Medians across outliers; the audio-latency ceiling is the 75th percentile. New Pre-Flight audits are graded against these automatically.
      </p>
    </Card>
  );
}
