"use client";

import {
  Area,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { TimelineBin, Zone } from "@/lib/types";

/** Motion velocity, audio energy and swipe risk on one synchronized time axis, with
 *  swipe-risk zones shaded, cuts as dashed lines and the 1.7 s hook gate marked. */
export function TimelineChart({
  bins,
  zones,
  cuts,
  pauses,
  hookWindow = 1.7,
  cursor,
  onSeek,
  height = 300,
}: {
  bins: TimelineBin[];
  zones: Zone[];
  cuts: number[];
  pauses: Zone[];
  hookWindow?: number;
  cursor?: number | null;
  onSeek?: (t: number) => void;
  height?: number;
}) {
  const end = bins.length ? bins[bins.length - 1].t + (bins[1] ? bins[1].t - bins[0].t : 0.25) : 0;
  return (
    <div style={{ height }} className="w-full">
      <ResponsiveContainer>
        <ComposedChart
          data={bins}
          margin={{ top: 8, right: 8, bottom: 0, left: -18 }}
          onClick={(e) => {
            const t = (e as { activeLabel?: number | string } | null)?.activeLabel;
            if (onSeek && t !== undefined) onSeek(Number(t));
          }}
        >
          <defs>
            <linearGradient id="motionFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#34d399" stopOpacity={0.35} />
              <stop offset="100%" stopColor="#34d399" stopOpacity={0} />
            </linearGradient>
            <linearGradient id="audioFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#38bdf8" stopOpacity={0.25} />
              <stop offset="100%" stopColor="#38bdf8" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke="#27272a" vertical={false} />
          <XAxis
            dataKey="t"
            type="number"
            domain={[0, end]}
            tickFormatter={(v: number) => `${v.toFixed(0)}s`}
            stroke="#71717a"
            fontSize={11}
            allowDataOverflow
          />
          <YAxis domain={[0, 100]} stroke="#71717a" fontSize={11} />
          <Tooltip
            labelFormatter={(v) => `${Number(v).toFixed(2)}s`}
            formatter={(value: number, name: string) => [value.toFixed(0), name]}
            contentStyle={{ background: "#18181b", border: "1px solid #3f3f46", borderRadius: 8 }}
          />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          <ReferenceArea x1={0} x2={hookWindow} fill="#a78bfa" fillOpacity={0.08} label={{ value: "1.7s gate", fill: "#a78bfa", fontSize: 10, position: "insideTopLeft" }} />
          {zones.map((z, i) => (
            <ReferenceArea key={`z${i}`} x1={z.start_s} x2={z.end_s} fill="#f43f5e" fillOpacity={0.14} stroke="#f43f5e" strokeOpacity={0.35} />
          ))}
          {pauses.map((p, i) => (
            <ReferenceArea key={`p${i}`} x1={p.start_s} x2={p.end_s} y1={0} y2={8} fill="#fbbf24" fillOpacity={0.6} />
          ))}
          {cuts.map((c, i) => (
            <ReferenceLine key={`c${i}`} x={c} stroke="#e4e4e7" strokeOpacity={0.35} strokeDasharray="3 3" />
          ))}
          {cursor !== null && cursor !== undefined && <ReferenceLine x={cursor} stroke="#34d399" strokeWidth={2} />}
          <Area type="monotone" dataKey="motion_velocity" name="Visual motion" stroke="#34d399" fill="url(#motionFill)" strokeWidth={2} isAnimationActive={false} />
          <Area type="monotone" dataKey="audio_energy" name="Audio energy" stroke="#38bdf8" fill="url(#audioFill)" strokeWidth={1.5} isAnimationActive={false} />
          <Line type="monotone" dataKey="risk" name="Swipe risk" stroke="#f43f5e" strokeWidth={2} dot={false} isAnimationActive={false} />
        </ComposedChart>
      </ResponsiveContainer>
      <div className="mt-1 flex flex-wrap gap-4 text-[11px] text-zinc-500">
        <span><span className="mr-1 inline-block h-2 w-3 bg-rose-500/40" />Swipe-risk zone</span>
        <span><span className="mr-1 inline-block h-2 w-3 bg-amber-400/60" />Vocal pause &gt; 0.4s</span>
        <span><span className="mr-1 inline-block h-2 w-3 border-l border-dashed border-zinc-300" />Cut</span>
        {onSeek && <span>Click the chart to seek the video</span>}
      </div>
    </div>
  );
}
