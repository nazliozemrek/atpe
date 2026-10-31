"use client";

import clsx from "clsx";
import Link from "next/link";
import { Card } from "@/components/ui";
import { fmtNum } from "@/lib/format";
import type { NicheDelta } from "@/lib/types";

/** Draft vs the golden targets measured on 10x+ outliers in the database. */
export function NicheDeltaCard({ delta }: { delta: NicheDelta }) {
  if (!delta.available) {
    return (
      <Card title="Delta vs 10x niche outliers">
        <p className="text-sm text-zinc-400">
          No 10x+ blueprints in the database yet.{" "}
          <Link href="/outliers" className="text-emerald-400 hover:underline">
            Scan a few creators in Outlier Radar
          </Link>{" "}
          and new audits will be graded against them.
        </p>
      </Card>
    );
  }
  return (
    <Card title={`Delta vs 10x niche outliers · ${delta.sample_size} blueprint${delta.sample_size === 1 ? "" : "s"}`}>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[560px] text-sm">
          <thead>
            <tr className="text-left">
              <th className="label pb-2">Metric</th>
              <th className="label pb-2 text-right">Your draft</th>
              <th className="label pb-2 text-right">10x target</th>
              <th className="label pb-2 pl-4">Verdict</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-800">
            {delta.metrics.map((m) => (
              <tr key={m.metric}>
                <td className="py-2 text-zinc-300">{m.label}</td>
                <td className="mono py-2 text-right text-zinc-200">
                  {fmtNum(m.draft, m.unit === "ms" || m.unit === "wpm" ? 0 : 2)} {m.unit}
                </td>
                <td className="mono py-2 text-right text-zinc-400">
                  {m.direction === "lower" ? "≤ " : m.direction === "higher" ? "≥ " : "≈ "}
                  {fmtNum(m.target, m.unit === "ms" || m.unit === "wpm" ? 0 : 2)} {m.unit}
                </td>
                <td className={clsx("py-2 pl-4 text-xs", m.pass === null ? "text-zinc-500" : m.pass ? "text-emerald-400" : "text-amber-300")}>
                  {m.message}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
