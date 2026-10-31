"use client";

import clsx from "clsx";
import { Activity, Clapperboard, Dna, Radar, Smartphone } from "lucide-react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { Suspense } from "react";

const LINKS = [
  { href: "/", label: "Pre-Flight", icon: Activity },
  { href: "/studio", label: "Safe Zones & Export", icon: Smartphone },
  { href: "/decompiler", label: "Decompiler", icon: Dna },
  { href: "/outliers", label: "Outlier Radar", icon: Radar },
];

function NavLinks() {
  const pathname = usePathname();
  const params = useSearchParams();
  // Carry the selected audit between pages.
  const audit = params.get("audit");
  return (
    <nav className="flex gap-1 overflow-x-auto md:flex-col">
      {LINKS.map(({ href, label, icon: Icon }) => {
        const active = href === "/" ? pathname === "/" : pathname.startsWith(href);
        return (
          <Link
            key={href}
            href={audit && href !== "/outliers" ? `${href}?audit=${audit}` : href}
            className={clsx(
              "flex shrink-0 items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition",
              active ? "bg-emerald-500/10 text-emerald-300" : "text-zinc-400 hover:bg-zinc-800/70 hover:text-zinc-100",
            )}
          >
            <Icon className="h-4 w-4" />
            {label}
          </Link>
        );
      })}
    </nav>
  );
}

export function Nav() {
  return (
    <aside className="border-b border-zinc-800 bg-zinc-950 px-4 py-3 md:sticky md:top-0 md:h-screen md:w-60 md:shrink-0 md:border-b-0 md:border-r md:py-6">
      <div className="mb-3 flex items-center gap-2 md:mb-8">
        <Clapperboard className="h-5 w-5 text-emerald-400" />
        <div>
          <div className="text-sm font-bold tracking-wide">ATPE</div>
          <div className="hidden text-[11px] text-zinc-500 md:block">Telemetry & Pre-Flight Engine</div>
        </div>
      </div>
      <Suspense fallback={null}>
        <NavLinks />
      </Suspense>
    </aside>
  );
}
