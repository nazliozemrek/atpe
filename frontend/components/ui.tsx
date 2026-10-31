"use client";

import clsx from "clsx";
import { AlertTriangle, CheckCircle2, Info, Loader2, XCircle } from "lucide-react";
import type { ReactNode } from "react";
import { scoreTone } from "@/lib/format";
import type { Job, Severity } from "@/lib/types";

const TONE_TEXT = { good: "text-emerald-400", warn: "text-amber-400", bad: "text-rose-400", none: "text-zinc-500" };
const TONE_STROKE = { good: "#34d399", warn: "#fbbf24", bad: "#fb7185", none: "#52525b" };

export function Card({ title, action, children, className }: { title?: ReactNode; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={clsx("card", className)}>
      {(title || action) && (
        <header className="mb-3 flex flex-wrap items-center justify-between gap-3">
          {title && <h2 className="min-w-0 text-sm font-semibold text-zinc-200">{title}</h2>}
          {action}
        </header>
      )}
      {children}
    </section>
  );
}

export function PageHeader({ title, subtitle, children }: { title: string; subtitle?: string; children?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-xl font-bold tracking-tight">{title}</h1>
        {subtitle && <p className="mt-1 max-w-2xl text-sm text-zinc-400">{subtitle}</p>}
      </div>
      {children}
    </div>
  );
}

/** Circular 0–100 gauge. */
export function ScoreRing({ value, label, sub }: { value: number | null | undefined; label: string; sub?: string }) {
  const tone = scoreTone(value);
  const r = 34;
  const c = 2 * Math.PI * r;
  const pct = value === null || value === undefined ? 0 : Math.max(0, Math.min(100, value)) / 100;
  return (
    <div className="flex items-center gap-4">
      <svg width="84" height="84" viewBox="0 0 84 84" className="shrink-0" role="img" aria-label={`${label} ${value ?? "n/a"}`}>
        <circle cx="42" cy="42" r={r} fill="none" stroke="#27272a" strokeWidth="8" />
        <circle
          cx="42"
          cy="42"
          r={r}
          fill="none"
          stroke={TONE_STROKE[tone]}
          strokeWidth="8"
          strokeLinecap="round"
          strokeDasharray={`${c * pct} ${c}`}
          transform="rotate(-90 42 42)"
        />
        <text x="42" y="47" textAnchor="middle" className="fill-zinc-100 text-[18px] font-bold">
          {value === null || value === undefined ? "—" : Math.round(value)}
        </text>
      </svg>
      <div>
        <div className="text-sm font-semibold">{label}</div>
        {sub && <div className="mt-0.5 text-xs text-zinc-500">{sub}</div>}
      </div>
    </div>
  );
}

export function Stat({ label, value, tone, hint }: { label: string; value: ReactNode; tone?: "good" | "warn" | "bad" | "none"; hint?: string }) {
  return (
    <div className="min-w-0">
      <div className="label">{label}</div>
      <div className={clsx("mt-1 truncate text-lg font-semibold", tone ? TONE_TEXT[tone] : "text-zinc-100")}>{value}</div>
      {hint && <div className="mt-0.5 truncate text-xs text-zinc-500">{hint}</div>}
    </div>
  );
}

const SEV_STYLE: Record<Severity, string> = {
  high: "border-rose-500/30 bg-rose-500/10 text-rose-300",
  medium: "border-amber-500/30 bg-amber-500/10 text-amber-200",
  low: "border-sky-500/30 bg-sky-500/10 text-sky-200",
};
const SEV_ICON = { high: XCircle, medium: AlertTriangle, low: Info };

export function SeverityRow({ severity, children, at }: { severity: Severity; children: ReactNode; at?: number | null }) {
  const Icon = SEV_ICON[severity];
  return (
    <li className={clsx("flex items-start gap-2.5 rounded-lg border px-3 py-2 text-sm", SEV_STYLE[severity])}>
      <Icon className="mt-0.5 h-4 w-4 shrink-0" />
      <span className="min-w-0 flex-1">{children}</span>
      {at !== null && at !== undefined && <span className="mono shrink-0 opacity-70">{at.toFixed(2)}s</span>}
    </li>
  );
}

export function JobStatus({ job, error, running }: { job: Job<unknown> | null; error: string | null; running: boolean }) {
  if (error)
    return (
      <div className="flex items-start gap-2 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-300">
        <XCircle className="mt-0.5 h-4 w-4 shrink-0" />
        <span className="break-words">{error}</span>
      </div>
    );
  if (!running) return null;
  const pct = Math.round((job?.progress ?? 0) * 100);
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-xs text-zinc-400">
        <span className="flex items-center gap-1.5">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          {job?.stage || (job?.status === "queued" ? "Queued" : "Starting")}
        </span>
        <span className="mono">{pct}%</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-zinc-800">
        <div className="h-full rounded-full bg-emerald-400 transition-[width] duration-500" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="rounded-lg border border-dashed border-zinc-800 px-4 py-8 text-center text-sm text-zinc-500">{children}</div>;
}

export function Check({ ok, children }: { ok: boolean; children: ReactNode }) {
  return (
    <span className={clsx("inline-flex items-center gap-1.5 text-sm", ok ? "text-emerald-300" : "text-rose-300")}>
      {ok ? <CheckCircle2 className="h-4 w-4" /> : <XCircle className="h-4 w-4" />}
      {children}
    </span>
  );
}

export function CopyButton({ text }: { text: string }) {
  return (
    <button
      type="button"
      className="btn-ghost px-2 py-1 text-xs"
      onClick={() => {
        void navigator.clipboard?.writeText(text);
      }}
    >
      Copy
    </button>
  );
}
