"use client";

import { Bar, CartesianGrid, Cell, ComposedChart, Line, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { fmtCompact } from "@/lib/format";
import type { ScoredPost } from "@/lib/types";

export const OUTLIER_COLOR = "#34d399"; // emerald: >= threshold
export const RISING_COLOR = "#fbbf24"; // amber: >= half the threshold
const BASE_COLOR = "#52525b";

export function scoreColor(score: number | null, threshold: number) {
  if (score === null) return "#3f3f46";
  if (score >= threshold) return OUTLIER_COLOR;
  if (score >= threshold / 2) return RISING_COLOR;
  return BASE_COLOR;
}

interface Row extends ScoredPost {
  idx: number;
  label: string;
  plotViews: number;
}

/** Every scanned post's views (oldest → newest) against the creator's trimmed baseline;
 *  the dashed line is each post's own leave-one-out baseline. */
export function OutlierChart({
  posts,
  baseline,
  threshold,
  log,
  selected,
  onSelect,
}: {
  posts: ScoredPost[];
  baseline: number;
  threshold: number;
  log: boolean;
  selected: string | null;
  onSelect: (post: ScoredPost) => void;
}) {
  const ordered = [...posts].sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
  const data: Row[] = ordered.map((p, i) => ({
    ...p,
    idx: i + 1,
    label: p.timestamp ? new Date(p.timestamp * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : `#${i + 1}`,
    plotViews: Math.max(1, p.views ?? 0),
  }));
  // Keep the 10x gate line on screen even when no post reaches it.
  const top = Math.max(...data.map((d) => d.plotViews), baseline * threshold, 1) * 1.25;
  return (
    <div className="h-80 w-full">
      <ResponsiveContainer>
        <ComposedChart data={data} margin={{ top: 12, right: 12, bottom: 0, left: 4 }}>
          <CartesianGrid stroke="#27272a" vertical={false} />
          <XAxis dataKey="label" stroke="#71717a" fontSize={11} interval="preserveStartEnd" />
          <YAxis
            scale={log ? "log" : "linear"}
            domain={log ? [1, top] : [0, top]}
            allowDataOverflow
            tickFormatter={(v: number) => fmtCompact(v)}
            stroke="#71717a"
            fontSize={11}
            width={48}
          />
          <Tooltip
            cursor={{ fill: "#27272a55" }}
            contentStyle={{ background: "#18181b", border: "1px solid #3f3f46", borderRadius: 8, fontSize: 12 }}
            content={({ active, payload }) => {
              const p = active && payload?.[0]?.payload ? (payload[0].payload as Row) : null;
              if (!p) return null;
              return (
                <div className="max-w-64 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-xs">
                  <div className="mb-1 line-clamp-2 font-medium text-zinc-200">{p.title || p.video_id}</div>
                  <div>
                    {fmtCompact(p.views)} views{p.views_estimated ? " (est.)" : ""} · baseline {fmtCompact(p.baseline)}
                  </div>
                  <div style={{ color: scoreColor(p.outlier_score, threshold) }} className="font-semibold">
                    {p.outlier_score === null ? "unscored" : `${p.outlier_score}x outlier score`}
                  </div>
                  <div className="text-zinc-400">engagement velocity {p.engagement_velocity ?? "—"}</div>
                  {p.blueprint_id && <div className="mt-1 text-emerald-400">Decompiled · click to inspect</div>}
                </div>
              );
            }}
          />
          <ReferenceLine
            y={Math.max(1, baseline)}
            stroke="#a1a1aa"
            strokeDasharray="6 4"
            label={{ value: `Trimmed baseline ${fmtCompact(baseline)}`, fill: "#a1a1aa", fontSize: 11, position: "insideTopLeft" }}
          />
          <ReferenceLine
            y={Math.max(1, baseline * threshold)}
            stroke={OUTLIER_COLOR}
            strokeOpacity={0.5}
            strokeDasharray="2 4"
            label={{ value: `${threshold}x gate`, fill: OUTLIER_COLOR, fontSize: 11, position: "insideTopLeft" }}
          />
          <Bar dataKey="plotViews" name="Views" radius={[3, 3, 0, 0]} onClick={(d: unknown) => onSelect(d as ScoredPost)} cursor="pointer" isAnimationActive={false}>
            {data.map((p) => (
              <Cell
                key={p.video_id}
                fill={scoreColor(p.outlier_score, threshold)}
                stroke={selected === p.video_id ? "#f4f4f5" : undefined}
                strokeWidth={selected === p.video_id ? 2 : 0}
                style={p.outlier_score !== null && p.outlier_score >= threshold ? { filter: `drop-shadow(0 0 6px ${OUTLIER_COLOR})` } : undefined}
              />
            ))}
          </Bar>
          <Line dataKey="baseline" name="Leave-one-out baseline" stroke="#e4e4e7" strokeOpacity={0.45} strokeDasharray="3 3" dot={false} isAnimationActive={false} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
