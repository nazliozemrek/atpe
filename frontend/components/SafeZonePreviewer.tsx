"use client";

import clsx from "clsx";
import { Pause, Play, ScanText } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Card, JobStatus } from "@/components/ui";
import { apiSend, mediaUrl, useApi, useJob } from "@/lib/api";
import type { Box, SafeZones } from "@/lib/types";

const KIND_COLOR: Record<string, string> = {
  header: "border-sky-400/80 bg-sky-400/15",
  ui: "border-rose-400/80 bg-rose-400/15",
  caption: "border-amber-400/80 bg-amber-400/15",
  ticker: "border-fuchsia-400/80 bg-fuchsia-400/15",
};

type Platform = "tiktok" | "reels";
type Fit = "pad" | "crop";

interface ObstructionResult {
  obstructed_times: number[];
  clean: boolean;
  samples: { t: number; obstructed: { text: string; obstructed_by: { zone: string }[] }[] }[];
}

function Overlay({ boxes, safe, show }: { boxes: Box[]; safe: Box; show: boolean }) {
  if (!show) return null;
  return (
    <div className="pointer-events-none absolute inset-0">
      {boxes.map((b) => (
        <div
          key={b.label}
          className={clsx("absolute border-2", KIND_COLOR[b.kind] ?? "border-white/60")}
          style={{ left: `${b.x0 * 100}%`, top: `${b.y0 * 100}%`, width: `${(b.x1 - b.x0) * 100}%`, height: `${(b.y1 - b.y0) * 100}%` }}
        >
          <span className="absolute left-1 top-0.5 max-w-full truncate text-[9px] font-semibold text-white drop-shadow">{b.label}</span>
        </div>
      ))}
      <div
        className="absolute border-2 border-dashed border-emerald-400/90"
        style={{ left: `${safe.x0 * 100}%`, top: `${safe.y0 * 100}%`, width: `${(safe.x1 - safe.x0) * 100}%`, height: `${(safe.y1 - safe.y0) * 100}%` }}
      >
        <span className="absolute left-1 top-0.5 text-[9px] font-semibold text-emerald-300">SAFE ZONE</span>
      </div>
    </div>
  );
}

/** Two synchronized 9:16 players with the TikTok and Reels UI drawn on top. */
export function SafeZonePreviewer({ auditId }: { auditId: number }) {
  const zones = useApi<SafeZones>("/api/safe-zones");
  const refs = { tiktok: useRef<HTMLVideoElement>(null), reels: useRef<HTMLVideoElement>(null) };
  const [playing, setPlaying] = useState(false);
  const [fit, setFit] = useState<Fit>("pad");
  const [show, setShow] = useState(true);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [frameFor, setFrameFor] = useState<{ platform: Platform; t: number } | null>(null);
  const scan = useJob<ObstructionResult>();
  const [scanPlatform, setScanPlatform] = useState<Platform>("tiktok");
  const [scanResult, setScanResult] = useState<ObstructionResult | null>(null);
  const src = mediaUrl(`/api/audits/${auditId}/video`);

  // Keep the Reels player locked to the TikTok player.
  useEffect(() => {
    const lead = refs.tiktok.current;
    const follow = refs.reels.current;
    if (!lead || !follow) return;
    const sync = () => {
      if (Math.abs(follow.currentTime - lead.currentTime) > 0.08) follow.currentTime = lead.currentTime;
      setTime(lead.currentTime);
    };
    lead.addEventListener("timeupdate", sync);
    lead.addEventListener("seeked", sync);
    return () => {
      lead.removeEventListener("timeupdate", sync);
      lead.removeEventListener("seeked", sync);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auditId]);

  const toggle = async () => {
    const vids = [refs.tiktok.current, refs.reels.current].filter(Boolean) as HTMLVideoElement[];
    if (playing) {
      vids.forEach((v) => v.pause());
      setPlaying(false);
    } else {
      await Promise.all(vids.map((v) => v.play().catch(() => undefined)));
      setPlaying(true);
    }
  };

  const seekTo = (t: number) => {
    [refs.tiktok.current, refs.reels.current].forEach((v) => v && (v.currentTime = t));
  };

  const runScan = async () => {
    setScanResult(null);
    const res = await scan.run(() => apiSend(`/api/audits/${auditId}/obstruction-scan?platform=${scanPlatform}&interval_s=1&fit=${fit}`, "POST"));
    if (res) setScanResult(res);
  };

  if (!zones.data) return <Card title="Safe-zone preview">{zones.error ?? "Loading UI geometry…"}</Card>;

  return (
    <Card
      title="9:16 safe-zone preview"
      action={
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <button className="btn-ghost px-2.5 py-1.5" onClick={toggle}>
            {playing ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
            {playing ? "Pause" : "Play both"}
          </button>
          <select className="input w-auto py-1.5 text-xs" value={fit} onChange={(e) => setFit(e.target.value as Fit)} aria-label="Framing">
            <option value="pad">Fit (letterbox)</option>
            <option value="crop">Fill (crop)</option>
          </select>
          <label className="flex items-center gap-1.5 text-zinc-400">
            <input type="checkbox" checked={show} onChange={(e) => setShow(e.target.checked)} className="accent-emerald-500" />
            UI overlay
          </label>
        </div>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        {(["tiktok", "reels"] as Platform[]).map((p) => (
          <div key={p}>
            <div className="mb-1.5 flex items-center justify-between">
              <span className="label">{p === "tiktok" ? "TikTok" : "Instagram Reels"}</span>
              <button className="text-xs text-emerald-400 hover:underline" onClick={() => setFrameFor({ platform: p, t: time })}>
                OCR this frame
              </button>
            </div>
            <div className="relative mx-auto aspect-[9/16] w-full max-w-[340px] overflow-hidden rounded-xl bg-black ring-1 ring-zinc-800">
              <video
                ref={refs[p]}
                src={src}
                muted={p === "reels"}
                loop
                playsInline
                className={clsx("absolute inset-0 h-full w-full", fit === "pad" ? "object-contain" : "object-cover")}
                onPause={() => p === "tiktok" && setPlaying(false)}
                onLoadedMetadata={(e) => p === "tiktok" && setDuration(e.currentTarget.duration || 0)}
              />
              <Overlay boxes={zones.data!.platforms[p]} safe={zones.data!.audit_safe_zone} show={show} />
            </div>
          </div>
        ))}
      </div>
      <input
        type="range"
        min={0}
        max={duration}
        step={0.01}
        value={time}
        onChange={(e) => seekTo(Number(e.target.value))}
        className="mt-4 w-full accent-emerald-500"
        aria-label="Scrub both players"
      />
      <div className="mono mt-1 text-zinc-500">{time.toFixed(2)}s</div>

      {frameFor && (
        <div className="mt-4 rounded-lg border border-zinc-800 p-3">
          <div className="mb-2 flex items-center justify-between text-sm">
            <span>
              {frameFor.platform === "tiktok" ? "TikTok" : "Reels"} frame at {frameFor.t.toFixed(2)}s, text boxes in red are covered by UI
            </span>
            <button className="text-xs text-zinc-400 hover:text-zinc-100" onClick={() => setFrameFor(null)}>
              Close
            </button>
          </div>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={mediaUrl(`/api/audits/${auditId}/safe-zone-frame?platform=${frameFor.platform}&t=${frameFor.t.toFixed(2)}&fit=${fit}`)}
            alt="Annotated frame with platform UI and detected text"
            className="mx-auto max-h-[560px] rounded-lg"
          />
        </div>
      )}

      <div className="mt-5 border-t border-zinc-800 pt-4">
        <div className="flex flex-wrap items-center gap-2">
          <select className="input w-auto py-1.5 text-sm" value={scanPlatform} onChange={(e) => setScanPlatform(e.target.value as Platform)} aria-label="Platform to check">
            <option value="tiktok">TikTok UI</option>
            <option value="reels">Reels UI</option>
          </select>
          <button className="btn-ghost" onClick={runScan} disabled={scan.running}>
            <ScanText className="h-4 w-4" />
            Check every second for covered text
          </button>
        </div>
        <div className="mt-3">
          <JobStatus job={scan.job} error={scan.error} running={scan.running} />
        </div>
        {scanResult &&
          (scanResult.clean ? (
            <p className="mt-2 text-sm text-emerald-400">No on-screen text is covered by the {scanPlatform === "tiktok" ? "TikTok" : "Reels"} UI.</p>
          ) : (
            <ul className="mt-2 space-y-1 text-sm">
              {scanResult.samples
                .filter((s) => s.obstructed.length)
                .map((s) => (
                  <li key={s.t}>
                    <button className="mono mr-2 text-emerald-400 hover:underline" onClick={() => seekTo(s.t)}>
                      {s.t.toFixed(1)}s
                    </button>
                    {s.obstructed.map((o) => `“${o.text}” under ${o.obstructed_by.map((z) => z.zone).join(", ")}`).join("; ")}
                  </li>
                ))}
            </ul>
          ))}
      </div>
    </Card>
  );
}
