"use client";

import { Download, Wand2 } from "lucide-react";
import { useState } from "react";
import { Card, Check, JobStatus, Stat } from "@/components/ui";
import { apiSend, mediaUrl, useJob } from "@/lib/api";
import { fmtBytes, fmtNum } from "@/lib/format";
import type { AuditReport, ExportResult } from "@/lib/types";

/** One-click sanitize + loop-trim + loudness export. */
export function Exporter({ auditId, report }: { auditId: number; report: AuditReport }) {
  const [opts, setOpts] = useState({ trim_dead_air: true, apply_loop_trim: true, normalize_loudness: true, fit: "pad" as "pad" | "crop", force60: false });
  const job = useJob<ExportResult>();
  const [result, setResult] = useState<ExportResult | null>(null);
  const rec = report.loop.recommendation;

  const run = async () => {
    setResult(null);
    const res = await job.run(() =>
      apiSend(`/api/audits/${auditId}/optimize`, "POST", {
        trim_dead_air: opts.trim_dead_air,
        apply_loop_trim: opts.apply_loop_trim,
        normalize_loudness: opts.normalize_loudness,
        fit: opts.fit,
        force_fps: opts.force60 ? 60 : null,
      }),
    );
    if (res) setResult(res);
  };

  const box = (key: "trim_dead_air" | "apply_loop_trim" | "normalize_loudness" | "force60", label: string, hint: string) => (
    <label className="flex items-start gap-2.5 rounded-lg border border-zinc-800 p-3 text-sm">
      <input type="checkbox" className="mt-0.5 accent-emerald-500" checked={opts[key]} onChange={(e) => setOpts({ ...opts, [key]: e.target.checked })} />
      <span>
        <span className="font-medium text-zinc-200">{label}</span>
        <span className="block text-xs text-zinc-500">{hint}</span>
      </span>
    </label>
  );

  const removed = result
    ? Object.keys(result.metadata.input.fingerprint_tags).length +
      result.metadata.input.stream_fingerprint_tags.reduce((n, t) => n + Object.keys(t).length, 0)
    : 0;

  return (
    <Card title="Sanitize & loop-trim export">
      <div className="grid gap-2 sm:grid-cols-2">
        {box("trim_dead_air", "Trim dead air", "Cuts head/tail silence longer than 350 ms")}
        {box("apply_loop_trim", "Apply loop trim", `${rec.trim_start_ms} ms head · ${rec.trim_end_ms} ms tail from the audit`)}
        {box("normalize_loudness", "Normalize to −14 LUFS", "Two-pass EBU R128, −1 dBTP ceiling")}
        {box("force60", "Force 60 fps", "Off keeps the source frame rate (up-conversion only duplicates frames)")}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <select className="input w-auto" value={opts.fit} onChange={(e) => setOpts({ ...opts, fit: e.target.value as "pad" | "crop" })} aria-label="Framing">
          <option value="pad">1080×1920 · letterbox (keep whole frame)</option>
          <option value="crop">1080×1920 · fill (center crop)</option>
        </select>
        <button className="btn-primary" onClick={run} disabled={job.running}>
          <Wand2 className="h-4 w-4" />
          Export algorithm_ready.mp4
        </button>
      </div>
      <div className="mt-3">
        <JobStatus job={job.job} error={job.error} running={job.running} />
      </div>

      {result && (
        <div className="mt-4 space-y-4 rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-4">
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Stat label="Output" value={`${result.encode.width}×${result.encode.height}`} hint={`${fmtNum(result.encode.fps, 2)} fps · ${result.encode.fit}`} />
            <Stat label="Length" value={`${fmtNum(result.encode.duration_s, 2)}s`} hint={`−${result.trim.removed_head_ms} ms head · −${result.trim.removed_tail_ms} ms tail`} />
            <Stat
              label="Loudness"
              value={result.loudness.output_lufs === null ? "—" : `${fmtNum(result.loudness.output_lufs, 1)} LUFS`}
              hint={result.loudness.input_lufs === null ? "no audio" : `from ${fmtNum(result.loudness.input_lufs, 1)} LUFS`}
            />
            <Stat label="File" value={fmtBytes(result.size_bytes)} hint={`${fmtNum(result.encode.bitrate / 1e6, 1)} Mb/s`} />
          </div>
          <div className="flex flex-wrap gap-4">
            <Check ok>Container & stream metadata stripped ({removed} identifying tag{removed === 1 ? "" : "s"} removed)</Check>
            <Check ok>Encoder SEI fingerprint removed</Check>
            {result.metadata.input.extra_streams.length > 0 && <Check ok>{result.metadata.input.extra_streams.length} data/cover stream(s) dropped</Check>}
          </div>
          <a className="btn-primary" href={mediaUrl(`/api/exports/${result.export_id}/download`)}>
            <Download className="h-4 w-4" />
            Download algorithm_ready.mp4
          </a>
        </div>
      )}
    </Card>
  );
}
