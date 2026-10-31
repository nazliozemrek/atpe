"use client";

import { Trash2 } from "lucide-react";
import { Suspense, useRef, useState } from "react";
import { AuditPicker, useAudits, useSelectedAudit } from "@/components/AuditPicker";
import { NicheDeltaCard } from "@/components/NicheDeltaCard";
import { TimelineChart } from "@/components/TimelineChart";
import { Card, Empty, JobStatus, PageHeader, ScoreRing, SeverityRow, Stat } from "@/components/ui";
import { UploadDrop } from "@/components/UploadDrop";
import { apiSend, apiUpload, mediaUrl, useApi, useJob } from "@/lib/api";
import { fmtMs, fmtNum, fmtSec, scoreTone } from "@/lib/format";
import type { Audit, AuditReport } from "@/lib/types";

function PreFlight() {
  const { id, select } = useSelectedAudit();
  const audits = useAudits();
  const audit = useApi<Audit>(id ? `/api/audits/${id}` : null);
  const job = useJob<{ audit_id: number }>();
  const [runOcr, setRunOcr] = useState(true);
  const [runAsr, setRunAsr] = useState(true);
  const [niche, setNiche] = useState("");
  const niches = useApi<string[]>("/api/outlier/niches");

  const start = async (file: File) => {
    const form = new FormData();
    form.append("file", file);
    form.append("run_ocr", String(runOcr));
    form.append("run_asr", String(runAsr));
    if (niche) form.append("niche", niche);
    const result = await job.run(() => apiUpload("/api/audits", form));
    if (result) {
      await audits.reload();
      select(result.audit_id);
    }
  };

  const remove = async () => {
    if (!id || !confirm("Delete this audit and its uploaded file?")) return;
    await apiSend(`/api/audits/${id}`, "DELETE");
    select(null);
    await audits.reload();
  };

  return (
    <>
      <PageHeader
        title="Pre-Flight Video Analyzer"
        subtitle="Upload a draft to score the 1.7s hook, find swipe-risk zones and measure how cleanly it loops, before you post."
      >
        <div className="flex w-full items-center gap-2 sm:w-auto">
          <AuditPicker value={id} onChange={select} audits={audits.data ?? []} />
          {id && (
            <button className="btn-ghost" onClick={remove} aria-label="Delete audit">
              <Trash2 className="h-4 w-4" />
            </button>
          )}
        </div>
      </PageHeader>

      <Card className="mb-6">
        <UploadDrop onFile={start} disabled={job.running} />
        <div className="mt-3 flex flex-wrap items-center gap-5 text-sm text-zinc-400">
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={runAsr} onChange={(e) => setRunAsr(e.target.checked)} className="accent-emerald-500" />
            Transcribe speech (WPM, pauses)
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={runOcr} onChange={(e) => setRunOcr(e.target.checked)} className="accent-emerald-500" />
            Read on-screen text hook
          </label>
          <label className="flex items-center gap-2">
            Grade against
            <select className="input w-auto py-1 text-sm" value={niche} onChange={(e) => setNiche(e.target.value)} aria-label="Niche benchmark">
              <option value="">all 10x outliers</option>
              {(niches.data ?? []).map((n) => (
                <option key={n} value={n}>
                  {n} outliers
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="mt-3">
          <JobStatus job={job.job} error={job.error} running={job.running} />
        </div>
      </Card>

      {audit.error && <Empty>{audit.error}</Empty>}
      {!id && !job.running && <Empty>Upload a draft or pick a previous audit to see its report.</Empty>}
      {audit.data && audit.data.id === id && <Report audit={audit.data} />}
    </>
  );
}

function Report({ audit }: { audit: Audit }) {
  const r: AuditReport = audit.report;
  const video = useRef<HTMLVideoElement>(null);
  const [cursor, setCursor] = useState<number | null>(null);
  const seek = (t: number) => {
    if (video.current) {
      video.current.currentTime = t;
      void video.current.play().catch(() => undefined);
    }
  };
  const rec = r.loop.recommendation;
  const speech = r.pacing.speech;

  return (
    <div className="space-y-6">
      {r.analysis?.warnings?.map((w) => (
        <SeverityRow key={w.code} severity="medium">
          {w.message}
        </SeverityRow>
      ))}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Card>
          <ScoreRing value={r.hook.score} label="1.7s Hook Survival" sub={`visual ${fmtNum(r.hook.components.visual, 0)} · audio ${fmtNum(r.hook.components.audio, 0)} · text ${fmtNum(r.hook.components.text, 0)}`} />
        </Card>
        <Card>
          <ScoreRing value={r.loop.score} label="Seamless Loop" sub={`projected ${fmtNum(rec.projected_score, 0)} after trim`} />
        </Card>
        <Card>
          <ScoreRing
            value={Math.max(0, 100 - r.swipe_risk_zones.reduce((s, z) => s + z.duration_s, 0) / Math.max(r.media.analyzed_duration_s, 1) * 100)}
            label="Retention coverage"
            sub={`${r.swipe_risk_zones.length} swipe-risk zone${r.swipe_risk_zones.length === 1 ? "" : "s"}`}
          />
        </Card>
        <Card>
          <ScoreRing
            value={r.niche_delta?.available ? r.niche_delta.score : null}
            label="vs 10x Niche Outliers"
            sub={r.niche_delta?.available ? `${r.niche_delta.sample_size} blueprints` : "Scan creators in Outlier Radar"}
          />
        </Card>
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_300px]">
        <Card title="Timeline: motion, audio energy, swipe risk">
          <TimelineChart
            bins={r.timeline}
            zones={r.swipe_risk_zones}
            cuts={r.pacing.cuts}
            pauses={speech.pauses}
            cursor={cursor}
            onSeek={seek}
            height={440}
          />
        </Card>
        <Card title="Draft">
          <div className="mx-auto aspect-[9/16] max-h-[520px] overflow-hidden rounded-lg bg-black">
            <video
              ref={video}
              src={mediaUrl(`/api/audits/${audit.id}/video`)}
              className="h-full w-full object-contain"
              controls
              loop
              playsInline
              onTimeUpdate={(e) => setCursor(e.currentTarget.currentTime)}
            />
          </div>
          <div className="mt-2 truncate text-xs text-zinc-500">
            {audit.filename} · {r.media.width}×{r.media.height} · {fmtNum(r.media.fps, 2)} fps · {fmtSec(r.media.analyzed_duration_s, 1)}
          </div>
        </Card>
      </div>

      {r.niche_delta && <NicheDeltaCard delta={r.niche_delta} />}

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Flags & fixes">
          {r.recommendations.length ? (
            <ul className="space-y-2">
              {r.recommendations.map((x, i) => (
                <SeverityRow key={i} severity={x.severity} at={x.at_s}>
                  <span className="mr-1.5 text-[11px] font-semibold uppercase opacity-70">{x.area}</span>
                  {x.message}
                </SeverityRow>
              ))}
            </ul>
          ) : (
            <Empty>No issues found.</Empty>
          )}
        </Card>

        <div className="space-y-6">
          <Card title="Hook gate (0–1.7s)">
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
              <Stat label="Onset latency" value={fmtMs(r.hook.audio.onset_latency_ms)} tone={r.hook.audio.onset_latency_ms === null ? "bad" : r.hook.audio.onset_latency_ms <= 150 ? "good" : r.hook.audio.onset_latency_ms <= 400 ? "warn" : "bad"} />
              <Stat label="Dead air" value={fmtMs(r.hook.audio.dead_air_ms)} />
              <Stat label="Hook motion" value={`${fmtNum(r.hook.visual.mean_flow_px_s, 1)} px/s`} tone={scoreTone((r.hook.components.visual ?? 0))} />
              <Stat label="Frame 1 luma" value={fmtNum(r.hook.visual.first_frame_luma, 0)} tone={r.hook.visual.first_frame_luma < 40 ? "bad" : "good"} />
              <Stat label="Cuts in hook" value={r.hook.visual.cuts_in_hook.length} />
              <Stat label="Text hook" value={r.hook.text.ran ? (r.hook.text.frames.some((f) => f.best) ? "Found" : "None") : "Skipped"} tone={!r.hook.text.ran ? "none" : r.hook.text.frames.some((f) => f.best?.in_safe_zone) ? "good" : "bad"} />
            </div>
            {r.hook.text.frames.filter((f) => f.best).map((f) => (
              <div key={f.t} className="mt-3 rounded-lg bg-zinc-950 px-3 py-2 text-xs text-zinc-400">
                <span className="mono mr-2 text-zinc-500">{f.t}s</span>“{f.best!.text}” · contrast {fmtNum(f.best!.contrast, 1)}:1 ·{" "}
                {f.best!.in_safe_zone ? <span className="text-emerald-400">in safe zone</span> : <span className="text-rose-400">under UI</span>}
              </div>
            ))}
          </Card>

          <Card title="Pacing">
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
              <Stat label="Cuts / min" value={fmtNum(r.pacing.cuts_per_minute, 1)} />
              <Stat label="Avg shot" value={fmtSec(r.pacing.avg_shot_length_s)} />
              <Stat label="Longest shot" value={fmtSec(r.pacing.longest_shot_s)} tone={r.pacing.longest_shot_s > 2.5 ? "warn" : "good"} />
              <Stat label="Stagnation" value={fmtSec(r.pacing.stagnation_seconds, 1)} tone={r.pacing.stagnation_seconds > 0 ? "bad" : "good"} />
              <Stat label="WPM" value={fmtNum(speech.wpm, 0)} hint={speech.articulation_wpm ? `${fmtNum(speech.articulation_wpm, 0)} articulation` : undefined} />
              <Stat label="Pauses > 0.4s" value={speech.pauses.length} tone={speech.pauses.length ? "warn" : "good"} />
            </div>
          </Card>

          <Card title="Loop trim">
            <div className="grid grid-cols-3 gap-4">
              <Stat label="Trim start" value={`${rec.trim_start_ms} ms`} />
              <Stat label="Trim end" value={`${rec.trim_end_ms} ms`} />
              <Stat label="New length" value={fmtSec(rec.new_duration_s)} />
            </div>
            <p className="mt-3 text-sm text-zinc-400">{rec.reason}</p>
            {r.loop.ending.last_sentence && (
              <p className="mt-2 text-xs text-zinc-500">
                Ends on “{r.loop.ending.last_sentence}” → loops into “{r.loop.ending.first_sentence}”
              </p>
            )}
          </Card>
        </div>
      </div>

      {r.transcript.words.length > 0 && (
        <Card title="Transcript">
          <p className="text-sm leading-7 text-zinc-300">
            {r.transcript.words.map((w, i) => {
              const next = r.transcript.words[i + 1];
              const gap = next ? next.start - w.end : 0;
              return (
                <span key={i}>
                  <button type="button" className="rounded px-0.5 hover:bg-zinc-800" onClick={() => seek(w.start)} title={`${w.start.toFixed(2)}s`}>
                    {w.word}
                  </button>
                  {gap > 0.4 && <span className="mx-1 rounded bg-amber-400/20 px-1 text-[10px] text-amber-300">{gap.toFixed(1)}s</span>}{" "}
                </span>
              );
            })}
          </p>
        </Card>
      )}
    </div>
  );
}

export default function Page() {
  return (
    <Suspense fallback={null}>
      <PreFlight />
    </Suspense>
  );
}
