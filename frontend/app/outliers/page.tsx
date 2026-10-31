"use client";

import clsx from "clsx";
import { Radar, ScanSearch } from "lucide-react";
import { useEffect, useState } from "react";
import { BlueprintInspector } from "@/components/outliers/BlueprintInspector";
import { GoldenHud } from "@/components/outliers/GoldenHud";
import { OUTLIER_COLOR, OutlierChart, RISING_COLOR, scoreColor } from "@/components/outliers/OutlierChart";
import { Card, Empty, JobStatus, PageHeader, SeverityRow } from "@/components/ui";
import { apiGet, apiSend, useApi, useJob } from "@/lib/api";
import { fmtCompact, fmtDate, fmtNum } from "@/lib/format";
import type { Blueprint, CreatorScan, CreatorScanSummary, GoldenTargets, ScoredPost } from "@/lib/types";

type Platform = "tiktok" | "instagram";
const BROWSERS = ["chrome", "firefox", "safari", "edge", "brave", "chromium", "opera", "vivaldi"];

function platformOf(url: string): Platform | null {
  if (/tiktok\.com/i.test(url)) return "tiktok";
  if (/instagram\.com/i.test(url)) return "instagram";
  return null;
}

function handleOf(url: string): string {
  const m = url.match(/(?:tiktok|instagram)\.com\/@?([A-Za-z0-9._]+)/i);
  return m ? m[1] : "";
}

function ScanForm({ onDone, running, run }: { onDone: (scan: CreatorScan) => void; running: boolean; run: ReturnType<typeof useJob<CreatorScan>>["run"] }) {
  const [profileUrl, setProfileUrl] = useState("");
  const [handle, setHandle] = useState("");
  const [platform, setPlatform] = useState<Platform>("tiktok");
  const [lastN, setLastN] = useState(20);
  const [threshold, setThreshold] = useState(10);
  const [niche, setNiche] = useState("");
  const [cookies, setCookies] = useState("");
  const [asr, setAsr] = useState(true);
  const [postUrls, setPostUrls] = useState("");

  const detected = platformOf(profileUrl);
  const effective = detected ?? platform;
  const urls = postUrls.split(/\s+/).map((u) => u.trim()).filter((u) => /^https?:\/\//.test(u));
  const canRun = !running && (detected !== null || handle.trim().length > 0 || urls.length >= 3);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const body = {
      profile_url: profileUrl.trim() || null,
      creator_handle: handle.trim().replace(/^@/, "") || (profileUrl ? handleOf(profileUrl) || null : null),
      platform: effective,
      post_urls: effective === "instagram" && urls.length ? urls : null,
      last_n: lastN,
      outlier_threshold: threshold,
      niche: niche.trim() || null,
      cookies_from_browser: cookies || null,
      run_asr: asr,
    };
    const res = await run(() => apiSend("/api/outlier/scan-creator", "POST", body));
    if (res) onDone(res);
  };

  return (
    <form onSubmit={submit} className="space-y-3">
      <div className="grid gap-2 md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_auto]">
        <input
          className="input"
          placeholder="Profile URL, e.g. https://www.tiktok.com/@creator"
          value={profileUrl}
          onChange={(e) => setProfileUrl(e.target.value)}
          aria-label="Profile URL"
        />
        <input className="input" placeholder="@handle" value={handle} onChange={(e) => setHandle(e.target.value)} aria-label="Creator handle" />
        <select
          className="input md:w-36"
          value={detected ?? platform}
          onChange={(e) => setPlatform(e.target.value as Platform)}
          disabled={detected !== null}
          aria-label="Platform"
        >
          <option value="tiktok">TikTok</option>
          <option value="instagram">Instagram</option>
        </select>
      </div>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <label className="text-xs text-zinc-400">
          Last N videos
          <input className="input mt-1" type="number" min={3} max={60} value={lastN} onChange={(e) => setLastN(Number(e.target.value) || 20)} />
        </label>
        <label className="text-xs text-zinc-400">
          Outlier multiplier threshold
          <div className="relative mt-1">
            <input className="input pr-7" type="number" min={1.5} max={1000} step={0.5} value={threshold} onChange={(e) => setThreshold(Number(e.target.value) || 10)} />
            <span className="absolute right-3 top-2 text-sm text-zinc-500">x</span>
          </div>
        </label>
        <label className="text-xs text-zinc-400">
          Niche tag
          <input className="input mt-1" placeholder="e.g. sleep health" value={niche} onChange={(e) => setNiche(e.target.value)} />
        </label>
        <label className="text-xs text-zinc-400">
          Browser cookies (Instagram needs a login)
          <select className="input mt-1" value={cookies} onChange={(e) => setCookies(e.target.value)}>
            <option value="">None</option>
            {BROWSERS.map((b) => (
              <option key={b} value={b}>
                {b[0].toUpperCase() + b.slice(1)}
              </option>
            ))}
          </select>
        </label>
      </div>
      {effective === "instagram" && (
        <div>
          <textarea
            className="input min-h-[96px] font-mono text-xs"
            placeholder={"Paste the creator's last 20–30 Reel URLs, one per line:\nhttps://www.instagram.com/reel/…"}
            value={postUrls}
            onChange={(e) => setPostUrls(e.target.value)}
            aria-label="Instagram Reel URLs"
          />
          <p className="mt-1 text-xs text-amber-300/80">
            yt-dlp&apos;s Instagram profile listing is flagged as broken upstream, so pasted Reel URLs are the reliable path ({urls.length} found). Pick
            the browser you&apos;re logged into Instagram with above.
          </p>
        </div>
      )}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <label className="flex items-center gap-2 text-sm text-zinc-400">
          <input type="checkbox" checked={asr} onChange={(e) => setAsr(e.target.checked)} className="accent-emerald-500" />
          Transcribe outliers (hook transcript, WPM)
        </label>
        <button className="btn-primary" type="submit" disabled={!canRun}>
          <ScanSearch className="h-4 w-4" />
          Scan last {lastN} posts
        </button>
      </div>
      <p className="text-xs text-zinc-500">
        Only metadata is fetched for all {lastN} posts. Posts at or above {threshold}x their leave-one-out baseline are downloaded to a temporary folder, decompiled, then deleted.
      </p>
    </form>
  );
}

function PostsTable({ scan, selected, onSelect }: { scan: CreatorScan; selected: string | null; onSelect: (p: ScoredPost) => void }) {
  const rows = [...scan.posts].sort((a, b) => (b.outlier_score ?? -1) - (a.outlier_score ?? -1));
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[760px] text-sm">
        <thead>
          <tr className="text-left">
            <th className="label pb-2">Post</th>
            <th className="label pb-2 text-right">Views</th>
            <th className="label pb-2 text-right">LOO baseline</th>
            <th className="label pb-2 text-right">Score</th>
            <th className="label pb-2 text-right">Eng. velocity</th>
            <th className="label pb-2 pl-4">Decompile</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-800">
          {rows.map((p) => (
            <tr
              key={p.video_id}
              className={clsx("cursor-pointer hover:bg-zinc-800/40", selected === p.video_id && "bg-zinc-800/60")}
              onClick={() => onSelect(p)}
            >
              <td className="max-w-[320px] py-1.5 pr-3">
                <div className="truncate text-zinc-200">{p.title || p.video_id}</div>
                <div className="text-[11px] text-zinc-500">{p.timestamp ? new Date(p.timestamp * 1000).toLocaleDateString() : "—"}</div>
              </td>
              <td className="mono py-1.5 text-right">
                {fmtCompact(p.views)}
                {p.views_estimated && <span className="ml-1 text-amber-400" title="Estimated as likes × 18.5">*</span>}
              </td>
              <td className="mono py-1.5 text-right text-zinc-400">{fmtCompact(p.baseline)}</td>
              <td className="mono py-1.5 text-right font-semibold" style={{ color: scoreColor(p.outlier_score, scan.outlier_threshold) }}>
                {p.outlier_score === null ? "—" : `${fmtNum(p.outlier_score, 2)}x`}
              </td>
              <td className="mono py-1.5 text-right text-zinc-400">{fmtNum(p.engagement_velocity, 1)}</td>
              <td className="py-1.5 pl-4 text-xs">
                {p.blueprint_id ? (
                  <span className="text-emerald-400">Blueprint #{p.blueprint_id}</span>
                ) : p.decompile_error ? (
                  <span className="text-rose-400" title={p.decompile_error}>
                    Failed
                  </span>
                ) : p.is_outlier ? (
                  <span className="text-amber-300">Pending</span>
                ) : (
                  <span className="text-zinc-600">below gate</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function OutlierRadar() {
  const job = useJob<CreatorScan>();
  const scans = useApi<CreatorScanSummary[]>("/api/outlier/scans");
  const niches = useApi<string[]>("/api/outlier/niches");
  const [niche, setNiche] = useState("");
  const golden = useApi<GoldenTargets>(`/api/outlier/niche-benchmark${niche ? `?niche=${encodeURIComponent(niche)}` : ""}`);
  const blueprints = useApi<Blueprint[]>(`/api/outlier/blueprints?min_score=0${niche ? `&niche=${encodeURIComponent(niche)}` : ""}`);
  const [scan, setScan] = useState<CreatorScan | null>(null);
  const [scanId, setScanId] = useState<number | null>(null);
  const [log, setLog] = useState(true);
  const [selectedPost, setSelectedPost] = useState<string | null>(null);
  const [inspect, setInspect] = useState<number | null>(null);

  useEffect(() => {
    if (scanId === null || scan?.scan_id === scanId) return;
    void apiGet<CreatorScan>(`/api/outlier/scans/${scanId}`).then(setScan).catch(() => setScan(null));
  }, [scanId, scan?.scan_id]);

  const refreshAll = async () => {
    await Promise.all([scans.reload(), niches.reload(), golden.reload(), blueprints.reload()]);
  };

  const onScanned = async (res: CreatorScan) => {
    setScan(res);
    setScanId(res.scan_id);
    const first = res.blueprints[0];
    setInspect(first ? first.id : null);
    await refreshAll();
  };

  const selectPost = (p: ScoredPost) => {
    setSelectedPost(p.video_id);
    if (p.blueprint_id) setInspect(p.blueprint_id);
  };

  return (
    <>
      <PageHeader
        title="Outlier Radar & Niche Benchmark"
        subtitle="Find a creator's 10x+ anomalies with a leave-one-out trimmed baseline, decompile only those, and grade your drafts against what they have in common."
      />

      <div className="space-y-6">
        <GoldenHud golden={golden.data} niche={niche} niches={niches.data ?? []} onNiche={setNiche} />

        <Card
          title={
            <span className="flex items-center gap-2">
              <Radar className="h-4 w-4 text-emerald-400" />
              Creator profile scanner
            </span>
          }
          action={
            scans.data?.length ? (
              <select className="input w-auto max-w-full py-1.5 text-xs" value={scanId ?? ""} onChange={(e) => setScanId(e.target.value ? Number(e.target.value) : null)} aria-label="Previous scans">
                <option value="">Previous scans…</option>
                {scans.data.map((s) => (
                  <option key={s.scan_id} value={s.scan_id}>
                    @{s.creator_handle} · {s.outlier_count} outlier{s.outlier_count === 1 ? "" : "s"} / {s.post_count} · {fmtDate(s.created_at)}
                  </option>
                ))}
              </select>
            ) : undefined
          }
        >
          <ScanForm onDone={onScanned} running={job.running} run={job.run} />
          <div className="mt-3">
            <JobStatus job={job.job} error={job.error} running={job.running} />
          </div>
        </Card>

        {scan ? (
          <Card
            title={`@${scan.creator_handle} · last ${scan.posts.length} posts · ${scan.posts.filter((p) => p.is_outlier).length} at ≥${scan.outlier_threshold}x`}
            action={
              <label className="flex items-center gap-2 text-xs text-zinc-400">
                <input type="checkbox" checked={log} onChange={(e) => setLog(e.target.checked)} className="accent-emerald-500" />
                Log scale
              </label>
            }
          >
            {scan.warnings.length > 0 && (
              <ul className="mb-3 space-y-1.5">
                {scan.warnings.map((w) => (
                  <SeverityRow key={w} severity="low">
                    {w}
                  </SeverityRow>
                ))}
              </ul>
            )}
            <OutlierChart posts={scan.posts} baseline={scan.creator_baseline} threshold={scan.outlier_threshold} log={log} selected={selectedPost} onSelect={selectPost} />
            <div className="mb-4 mt-2 flex flex-wrap gap-4 text-[11px] text-zinc-500">
              <span>
                <span className="mr-1 inline-block h-2 w-3 rounded-sm" style={{ background: OUTLIER_COLOR }} />≥ {scan.outlier_threshold}x outlier (decompiled)
              </span>
              <span>
                <span className="mr-1 inline-block h-2 w-3 rounded-sm" style={{ background: RISING_COLOR }} />≥ {scan.outlier_threshold / 2}x rising
              </span>
              <span>Creator trimmed baseline {fmtCompact(scan.creator_baseline)} views</span>
            </div>
            <PostsTable scan={scan} selected={selectedPost} onSelect={selectPost} />
          </Card>
        ) : (
          <Empty>Scan a creator, or pick a previous scan, to see their 20-post outlier map.</Empty>
        )}

        {inspect !== null && (
          <BlueprintInspector
            key={inspect}
            id={inspect}
            golden={golden.data}
            onClose={() => setInspect(null)}
            onDeleted={async () => {
              setInspect(null);
              await refreshAll();
              if (scanId !== null) setScan(await apiGet<CreatorScan>(`/api/outlier/scans/${scanId}`));
            }}
          />
        )}

        <Card title={`Blueprint library (${blueprints.data?.length ?? 0})`}>
          {blueprints.data?.length ? (
            <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
              {blueprints.data.map((b) => (
                <button
                  key={b.id}
                  onClick={() => setInspect(b.id)}
                  className={clsx(
                    "rounded-lg border px-3 py-2 text-left text-sm transition",
                    inspect === b.id ? "border-emerald-400/60 bg-emerald-400/5" : "border-zinc-800 hover:border-zinc-600",
                  )}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate font-medium">@{b.creator_handle}</span>
                    <span className="mono shrink-0 text-emerald-300">{b.outlier_score}x</span>
                  </div>
                  <div className="mt-0.5 truncate text-xs text-zinc-400">{b.hook_transcript_3s ? `“${b.hook_transcript_3s}”` : b.title || b.video_id}</div>
                  <div className="mt-1 text-[11px] text-zinc-500">
                    {fmtCompact(b.views)} views · {fmtNum(b.cuts_per_minute, 0)} cuts/min · first cut {b.first_cut_timestamp_sec === null ? "—" : `${b.first_cut_timestamp_sec.toFixed(1)}s`}
                    {b.niche ? ` · ${b.niche}` : ""}
                  </div>
                </button>
              ))}
            </div>
          ) : (
            <Empty>No blueprints yet. Every 10x+ outlier you scan lands here and feeds the golden benchmark.</Empty>
          )}
        </Card>
      </div>
    </>
  );
}
