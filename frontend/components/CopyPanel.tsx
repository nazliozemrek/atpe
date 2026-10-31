"use client";

import { Sparkles } from "lucide-react";
import { useState } from "react";
import { Card, Check, CopyButton, JobStatus } from "@/components/ui";
import { apiSend } from "@/lib/api";
import type { CopyResult } from "@/lib/types";

/** "phrase, volume" per line → { phrase: volume } */
function parseVolumes(text: string): Record<string, number> | null {
  const out: Record<string, number> = {};
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*(.+?)\s*[,;\t]\s*([\d.,_kKmM]+)\s*$/);
    if (!m) continue;
    let raw = m[2].replace(/[,_]/g, "").toLowerCase();
    let mult = 1;
    if (raw.endsWith("k")) (mult = 1e3), (raw = raw.slice(0, -1));
    if (raw.endsWith("m")) (mult = 1e6), (raw = raw.slice(0, -1));
    const v = Number(raw) * mult;
    if (Number.isFinite(v)) out[m[1]] = v;
  }
  return Object.keys(out).length ? out : null;
}

function Block({ label, text }: { label: string; text: string }) {
  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <span className="label">{label}</span>
        <CopyButton text={text} />
      </div>
      <p className="whitespace-pre-wrap rounded-lg bg-zinc-950 px-3 py-2 text-sm text-zinc-200">{text}</p>
    </div>
  );
}

export function CopyPanel({ auditId }: { auditId: number }) {
  const [niche, setNiche] = useState("");
  const [cta, setCta] = useState("");
  const [volumes, setVolumes] = useState("");
  const [result, setResult] = useState<CopyResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      setResult(
        await apiSend<CopyResult>(`/api/audits/${auditId}/copy`, "POST", {
          niche: niche || null,
          cta: cta || null,
          keyword_volumes: parseVolumes(volumes),
        }),
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Search & share copy">
      <div className="grid gap-3 md:grid-cols-2">
        <div className="space-y-3">
          <input className="input" placeholder="Niche, e.g. sleep health" value={niche} onChange={(e) => setNiche(e.target.value)} />
          <input className="input" placeholder="Call to action (optional)" value={cta} onChange={(e) => setCta(e.target.value)} />
        </div>
        <textarea
          className="input min-h-[92px] font-mono text-xs"
          placeholder={"Optional search volumes, one per line:\nsleep tips, 120k\nmagnesium for sleep, 45000"}
          value={volumes}
          onChange={(e) => setVolumes(e.target.value)}
        />
      </div>
      <button className="btn-primary mt-3" onClick={run} disabled={busy}>
        <Sparkles className="h-4 w-4" />
        Generate captions & triggers
      </button>
      <div className="mt-3">
        <JobStatus job={null} error={error} running={false} />
      </div>

      {result && (
        <div className="mt-4 grid gap-5 lg:grid-cols-2">
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-3">
              <span className="label">Primary keyword</span>
              <span className="rounded-md bg-emerald-500/15 px-2 py-0.5 text-sm text-emerald-300">{result.primary_keyword}</span>
              <Check ok={result.tiktok.keyword_in_first_50}>in first 50 chars</Check>
            </div>
            <Block label={`TikTok caption · ${result.tiktok.length} chars`} text={result.tiktok.caption} />
            <Block label="Instagram caption" text={result.instagram.caption} />
            <Block label="Instagram alt text" text={result.instagram.alt_text} />
            <div className="flex flex-wrap gap-1.5">
              {result.instagram.hashtags.map((h) => (
                <span key={h} className="rounded-md bg-zinc-800 px-2 py-0.5 text-xs text-zinc-300">
                  {h}
                </span>
              ))}
            </div>
          </div>
          <div className="space-y-4">
            <div>
              <div className="label mb-2">On-screen text hooks</div>
              <ul className="space-y-2">
                {result.share_triggers.on_screen_hooks.map((h) => (
                  <li key={h.text} className="rounded-lg border border-zinc-800 px-3 py-2">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-semibold">{h.text}</span>
                      <span className="shrink-0 rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] uppercase text-zinc-400">{h.trigger}</span>
                    </div>
                    <p className="mt-1 text-xs text-zinc-500">{h.why}</p>
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <div className="label mb-2">Pinned comment prompts</div>
              <ul className="space-y-2">
                {result.share_triggers.pinned_comments.map((h) => (
                  <li key={h.text} className="flex items-start justify-between gap-2 rounded-lg border border-zinc-800 px-3 py-2 text-sm">
                    <span>{h.text}</span>
                    <CopyButton text={h.text} />
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <div className="label mb-2">Ranked keywords</div>
              <div className="flex flex-wrap gap-1.5">
                {result.keywords.map((k) => (
                  <span key={k.phrase} className="rounded-md bg-zinc-800 px-2 py-0.5 text-xs text-zinc-300" title={`score ${k.score}`}>
                    {k.phrase}
                    {k.volume ? ` · ${Intl.NumberFormat("en", { notation: "compact" }).format(k.volume)}` : ""}
                  </span>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </Card>
  );
}
