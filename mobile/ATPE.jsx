/* ATPE Mobile (pro view) — single-file React dashboard (no backend). Built on engine.jsx.
 *
 * Pre-Flight: decodes a camera-roll video in the browser. Frames are sampled through a
 * <canvas> (Rec.709 luma, frame-difference motion, 16-bin luma histograms for cut
 * detection) and the audio track is decoded with the Web Audio API (10 ms RMS dBFS,
 * first-sound and transient onset latency). Scores mirror the desktop engine.
 * Outlier Radar: leave-one-out trimmed baseline calculator over 20 posts, golden niche
 * targets from decompiled 10x+ blueprints, and a blueprint inspector.
 *
 * Globals (UMD): React, ReactDOM, Recharts, LucideReact.
 */
const { useState, useEffect, useMemo, useRef, useCallback } = React;
const {
  ResponsiveContainer, ComposedChart, AreaChart, Area, Bar, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, ReferenceLine, ReferenceArea, Cell,
} = Recharts;
const {
  Upload, Activity, Radar, Smartphone, Gauge, Repeat, Crosshair, Scissors, Eye,
  AlertTriangle, XCircle, Info, CheckCircle2, Plus, RotateCcw, Trash2, X, Film, Sparkles,
} = LucideReact;


// ---------------------------------------------------------------------------------
// Persistence (per-viewer convenience only)
// ---------------------------------------------------------------------------------
const STORE = "atpe.mobile.v1";
const load = () => { try { return JSON.parse(localStorage.getItem(STORE) || "{}"); } catch (_) { return {}; } };
const save = (v) => { try { localStorage.setItem(STORE, JSON.stringify(v)); } catch (_) { /* storage blocked */ } };

// ---------------------------------------------------------------------------------
// UI atoms
// ---------------------------------------------------------------------------------
const tone = (v) => (v === null || v === undefined ? "none" : v >= 70 ? "good" : v >= 45 ? "warn" : "bad");
const TONE = { good: C.emerald, warn: C.amber, bad: C.risk, none: "#4a5567" };

function Ring({ value, label, sub }) {
  const r = 26, c = 2 * Math.PI * r, pct = value === null || value === undefined ? 0 : clip01(value / 100);
  return (
    <div className="panel flex items-center gap-3 p-3">
      <svg width="64" height="64" viewBox="0 0 64 64" className="shrink-0" role="img" aria-label={`${label}: ${value === null ? "no data" : Math.round(value)}`}>
        <circle cx="32" cy="32" r={r} fill="none" stroke="rgb(var(--line))" strokeWidth="6" />
        <circle cx="32" cy="32" r={r} fill="none" stroke={TONE[tone(value)]} strokeWidth="6" strokeLinecap="round" strokeDasharray={`${c * pct} ${c}`} transform="rotate(-90 32 32)" />
        <text x="32" y="37" textAnchor="middle" fill="rgb(var(--fg))" fontSize="16" fontWeight="700" fontFamily="var(--font-data)">{value === null || value === undefined ? "—" : Math.round(value)}</text>
      </svg>
      <div className="min-w-0">
        <div className="text-[13px] font-semibold leading-tight">{label}</div>
        {sub && <div className="mt-0.5 text-[11px] leading-snug text-muted">{sub}</div>}
      </div>
    </div>
  );
}

function Stat({ label, value, color, hint }) {
  return (
    <div className="min-w-0">
      <div className="eyebrow">{label}</div>
      <div className="mt-0.5 truncate font-data text-[17px] font-semibold" style={{ color: color || "rgb(var(--fg))" }}>{value}</div>
      {hint && <div className="truncate text-[11px] text-muted">{hint}</div>}
    </div>
  );
}

const SEV = {
  high: { Icon: XCircle, color: C.risk, bg: "rgba(255,92,122,.09)" },
  medium: { Icon: AlertTriangle, color: C.amber, bg: "rgba(255,180,58,.08)" },
  low: { Icon: Info, color: C.sky, bg: "rgba(92,200,255,.08)" },
};
function Flag({ f }) {
  const { Icon, color, bg } = SEV[f.severity];
  return (
    <li className="flex items-start gap-2 rounded-lg border px-3 py-2 text-[13px] leading-snug" style={{ borderColor: `${color}55`, background: bg }}>
      <Icon size={15} className="mt-0.5 shrink-0" style={{ color }} aria-hidden="true" />
      <span className="min-w-0 flex-1">{f.message}</span>
      {f.at !== null && f.at !== undefined && <span className="shrink-0 font-data text-[11px] text-muted">{f.at.toFixed(2)}s</span>}
    </li>
  );
}

function Section({ title, icon: Icon, action, children, className = "" }) {
  return (
    <section className={`panel p-4 ${className}`}>
      <header className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex min-w-0 items-center gap-2 font-display text-[15px] font-semibold tracking-wide">
          {Icon && <Icon size={16} className="shrink-0 text-emerald" aria-hidden="true" />}
          <span className="min-w-0">{title}</span>
        </h2>
        {action}
      </header>
      {children}
    </section>
  );
}

function Segmented({ value, onChange, options, label }) {
  return (
    <div className="inline-flex rounded-lg border border-line bg-ink p-0.5" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={value === o.value} onClick={() => onChange(o.value)}
          className={`rounded-md px-2.5 py-1 text-[12px] font-semibold transition ${value === o.value ? "bg-emerald text-ink" : "text-muted hover:text-fg"}`}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

const chartTooltip = { contentStyle: { background: C.panel, border: `1px solid ${C.grid}`, borderRadius: 8, fontSize: 12, color: C.fg }, labelStyle: { color: C.muted } };

// ---------------------------------------------------------------------------------
// 9:16 previewer with safe-zone overlay
// ---------------------------------------------------------------------------------
function Previewer({ src, overlay, setOverlay, videoRef, onTime, example }) {
  return (
    <Section title="9:16 preview" icon={Smartphone}
      action={<Segmented label="UI overlay" value={overlay} onChange={setOverlay} options={[{ value: "off", label: "Off" }, { value: "tiktok", label: "TikTok" }, { value: "reels", label: "Reels" }]} />}>
      <div className="relative mx-auto aspect-[9/16] w-full max-w-[300px] overflow-hidden rounded-xl bg-black ring-1 ring-line">
        {src ? (
          <video ref={videoRef} src={src} className="absolute inset-0 h-full w-full object-contain" controls playsInline loop onTimeUpdate={(e) => onTime(e.currentTarget.currentTime)} />
        ) : (
          <div className="absolute inset-0 bg-[radial-gradient(120%_70%_at_30%_20%,#1d2a3d,#07090d)]">
            <div className="absolute left-[34%] top-[44%] whitespace-nowrap font-display text-[26px] font-bold text-white drop-shadow">3 SLEEP SECRETS</div>
            <div className="absolute bottom-[30%] left-0 right-0 text-center font-data text-[11px] text-muted">Example clip</div>
          </div>
        )}
        {overlay !== "off" && (
          <div className="pointer-events-none absolute inset-0">
            {ZONES[overlay].map((z) => (
              <div key={z.label} className="absolute border-2" style={{ left: `${z.x0 * 100}%`, top: `${z.y0 * 100}%`, width: `${(z.x1 - z.x0) * 100}%`, height: `${(z.y1 - z.y0) * 100}%`, borderColor: ZONE_STYLE[z.kind].border, background: ZONE_STYLE[z.kind].fill }}>
                <span className="absolute left-1 top-0.5 max-w-full truncate text-[9px] font-semibold text-white">{z.label}</span>
              </div>
            ))}
            <div className="absolute border-2 border-dashed" style={{ borderColor: C.emerald, left: `${SAFE.x0 * 100}%`, top: `${SAFE.y0 * 100}%`, width: `${(SAFE.x1 - SAFE.x0) * 100}%`, height: `${(SAFE.y1 - SAFE.y0) * 100}%` }}>
              <span className="absolute left-1 top-0.5 text-[9px] font-semibold" style={{ color: C.emerald }}>SAFE ZONE</span>
            </div>
          </div>
        )}
      </div>
      <p className="mt-2 text-center text-[11px] text-muted">
        {example ? "On the example clip, the hook text runs under TikTok's action rail. Toggle the overlay." : "Keep hook text and faces inside the dashed safe zone."}
      </p>
    </Section>
  );
}

// ---------------------------------------------------------------------------------
// Pre-Flight tab
// ---------------------------------------------------------------------------------
function TimelineChart({ r, cursor, onSeek }) {
  return (
    <div className="h-56 w-full">
      <ResponsiveContainer>
        <ComposedChart data={r.bins} margin={{ top: 6, right: 6, bottom: 0, left: -24 }}
          onClick={(e) => e && e.activeLabel !== undefined && onSeek(Number(e.activeLabel))}>
          <defs>
            <linearGradient id="gm" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={C.emerald} stopOpacity={0.35} /><stop offset="100%" stopColor={C.emerald} stopOpacity={0} /></linearGradient>
            <linearGradient id="ge" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={C.sky} stopOpacity={0.25} /><stop offset="100%" stopColor={C.sky} stopOpacity={0} /></linearGradient>
          </defs>
          <CartesianGrid stroke={C.grid} vertical={false} />
          <XAxis dataKey="t" type="number" domain={[0, r.duration]} tickFormatter={(v) => `${Math.round(v)}s`} stroke={C.axis} fontSize={10} />
          <YAxis domain={[0, 100]} stroke={C.axis} fontSize={10} />
          <Tooltip {...chartTooltip} labelFormatter={(v) => `${Number(v).toFixed(2)}s`} formatter={(v, n) => [Math.round(v), n]} />
          <ReferenceArea x1={0} x2={Math.min(HOOK, r.duration)} fill={C.violet} fillOpacity={0.1} />
          {r.zones.map((z, i) => <ReferenceArea key={i} x1={z.start} x2={z.end} fill={C.risk} fillOpacity={0.14} />)}
          {r.pacing.cuts.map((c, i) => <ReferenceLine key={i} x={c} stroke={C.fg} strokeOpacity={0.3} strokeDasharray="3 3" />)}
          {cursor !== null && <ReferenceLine x={cursor} stroke={C.emerald} strokeWidth={2} />}
          <Area type="monotone" dataKey="motion" name="Motion" stroke={C.emerald} fill="url(#gm)" strokeWidth={2} isAnimationActive={false} />
          <Area type="monotone" dataKey="energy" name="Audio energy" stroke={C.sky} fill="url(#ge)" strokeWidth={1.5} isAnimationActive={false} />
          <Line type="monotone" dataKey="risk" name="Swipe risk" stroke={C.risk} strokeWidth={2} dot={false} isAnimationActive={false} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

function PreFlight({ report, setReport, golden: g, onAddBlueprint }) {
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState({ p: 0, stage: "" });
  const [error, setError] = useState(null);
  const [src, setSrc] = useState(null);
  const [overlay, setOverlay] = useState("tiktok");
  const [cursor, setCursor] = useState(null);
  const [added, setAdded] = useState(false);
  const videoRef = useRef(null);
  const abortRef = useRef(null);

  useEffect(() => () => { if (src) URL.revokeObjectURL(src); }, [src]);

  const run = async (file) => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setError(null); setBusy(true); setAdded(false); setCursor(null);
    const url = URL.createObjectURL(file);
    setSrc((old) => { if (old) URL.revokeObjectURL(old); return url; });
    try {
      setProgress({ p: 0.02, stage: "Opening video" });
      const frames = await extractFrames(url, (p, stage) => setProgress({ p, stage }), ctrl.signal);
      setProgress({ p: 0.8, stage: "Decoding audio" });
      const audio = await extractAudio(file);
      setProgress({ p: 0.95, stage: "Scoring" });
      setReport(analyze(frames, audio, file.name));
      setProgress({ p: 1, stage: "Done" });
    } catch (e) {
      if (e.name !== "AbortError") setError(e.message || String(e));
    } finally {
      if (abortRef.current === ctrl) setBusy(false);
    }
  };

  const seekTo = (t) => {
    if (videoRef.current) { videoRef.current.currentTime = t; videoRef.current.play().catch(() => {}); }
    setCursor(t);
  };

  const r = report;
  const delta = nicheDelta(r.telemetry, g);
  const lat = r.hook.latencyMs;

  return (
    <div className="grid gap-4">
      <Section title="Analyze a draft" icon={Upload}
        action={r.example && <span className="chip" style={{ color: C.amber, borderColor: `${C.amber}66` }}>Example report</span>}>
        <label htmlFor="video-file" className={`flex cursor-pointer flex-col items-center gap-1.5 rounded-xl border-2 border-dashed px-4 py-6 text-center transition ${busy ? "pointer-events-none opacity-60" : "border-line hover:border-emerald"}`}>
          <Film size={26} className="text-emerald" aria-hidden="true" />
          <span className="font-display text-[15px] font-semibold">Choose a video from your camera roll</span>
          <span className="text-[12px] text-muted">Analyzed on this device. Nothing is uploaded.</span>
        </label>
        <input id="video-file" type="file" accept="video/*" className="sr-only" disabled={busy}
          onChange={(e) => { const f = e.target.files?.[0]; if (f) void run(f); e.target.value = ""; }} />
        {busy && (
          <div className="mt-3">
            <div className="mb-1 flex justify-between text-[12px] text-muted"><span>{progress.stage}</span><span className="font-data">{Math.round(progress.p * 100)}%</span></div>
            <div className="h-1.5 overflow-hidden rounded-full bg-line"><div className="h-full rounded-full bg-emerald transition-[width] duration-300" style={{ width: `${progress.p * 100}%` }} /></div>
          </div>
        )}
        {error && <p className="mt-3 rounded-lg border px-3 py-2 text-[13px]" style={{ borderColor: `${C.risk}66`, color: C.risk }}>{error} Try an MP4 or MOV exported from your camera or editor.</p>}
        {!busy && !error && (
          <p className="mt-3 truncate text-[12px] text-muted">
            {r.example ? "Showing an example analysis until you pick a clip." : `${r.name} · ${r.width}×${r.height} · ${r.duration.toFixed(1)}s`}
          </p>
        )}
      </Section>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Ring value={r.hook.score} label="1.7s hook" sub={`visual ${Math.round(r.hook.visual)} · audio ${Math.round(r.hook.audio)}`} />
        <Ring value={r.loop.score} label="Seamless loop" sub={`${Math.round(r.loop.projected)} after trim`} />
        <Ring value={r.retention} label="Retention" sub={`${r.zones.length} swipe-risk zone${r.zones.length === 1 ? "" : "s"}`} />
        <Ring value={delta ? delta.score : null} label="vs 10x outliers" sub={delta ? `${delta.n} blueprints` : "add blueprints"} />
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
        <Section title="Timeline" icon={Activity}>
          <TimelineChart r={r} cursor={cursor} onSeek={seekTo} />
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted">
            <span><i className="legend" style={{ background: C.emerald }} />Motion</span>
            <span><i className="legend" style={{ background: C.sky }} />Audio energy</span>
            <span><i className="legend" style={{ background: C.risk }} />Swipe risk</span>
            <span><i className="legend" style={{ background: "rgba(255,92,122,.35)" }} />Risk zone</span>
            <span><i className="legend" style={{ background: "rgba(180,155,255,.4)" }} />1.7s gate</span>
            {!r.example && <span>Tap the chart to seek</span>}
          </div>
        </Section>
        <Previewer src={r.example ? null : src} overlay={overlay} setOverlay={setOverlay} videoRef={videoRef} onTime={setCursor} example={r.example} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Section title="Flags & fixes" icon={AlertTriangle}>
          {r.recs.length ? <ul className="grid gap-2">{r.recs.map((f, i) => <Flag key={i} f={f} />)}</ul> : <p className="text-[13px] text-muted">No issues found.</p>}
        </Section>
        <div className="grid content-start gap-4">
          <Section title="Hook gate · 0–1.7s" icon={Gauge}>
            <div className="grid grid-cols-3 gap-3">
              <Stat label="Onset" value={lat === null ? "—" : `${Math.round(lat)} ms`} color={lat === null ? C.risk : lat <= 150 ? C.emerald : lat <= 400 ? C.amber : C.risk} />
              <Stat label="Dead air" value={r.hook.deadAirMs === null ? "—" : `${Math.round(r.hook.deadAirMs)} ms`} />
              <Stat label="Frame 1 luma" value={Math.round(r.hook.firstLuma)} color={r.hook.firstLuma < 40 ? C.risk : C.emerald} />
              <Stat label="Hook motion" value={`${Math.round(r.telemetry.hook_motion)}/100`} />
              <Stat label="Cuts in hook" value={r.hook.hookCuts.length} />
              <Stat label="Hook vs body" value={r.hook.hookVsBody === null ? "—" : `${r.hook.hookVsBody.toFixed(1)} dB`} />
            </div>
          </Section>
          <Section title="Pacing" icon={Scissors}>
            <div className="grid grid-cols-3 gap-3">
              <Stat label="Cuts / min" value={fmt(r.pacing.cpm, 1)} />
              <Stat label="Avg shot" value={`${fmt(r.pacing.avgShot, 2)}s`} />
              <Stat label="First cut" value={r.pacing.firstCut === null ? "—" : `${r.pacing.firstCut.toFixed(2)}s`} />
              <Stat label="Longest shot" value={`${fmt(r.pacing.longestShot, 2)}s`} color={r.pacing.longestShot > 2.5 ? C.amber : C.emerald} />
              <Stat label="Stagnation" value={`${fmt(r.pacing.stagnationSeconds, 1)}s`} color={r.pacing.stagnationSeconds > 0 ? C.risk : C.emerald} />
              <Stat label="Cuts" value={r.pacing.cutCount} />
            </div>
          </Section>
          <Section title="Loop trim" icon={Repeat}>
            <div className="grid grid-cols-3 gap-3">
              <Stat label="Trim start" value={`${r.loop.trimStartMs} ms`} />
              <Stat label="Trim end" value={`${r.loop.trimEndMs} ms`} />
              <Stat label="New length" value={`${r.loop.newDuration.toFixed(2)}s`} />
            </div>
            <p className="mt-2 text-[12px] text-muted">{r.loop.reason}</p>
          </Section>
        </div>
      </div>

      <Section title="Delta vs 10x niche outliers" icon={Crosshair}
        action={!r.example && (
          <button type="button" className="btn-ghost" disabled={added} onClick={() => { onAddBlueprint(r); setAdded(true); }}>
            <Plus size={14} aria-hidden="true" />{added ? "Added to benchmark" : "Add as outlier blueprint"}
          </button>
        )}>
        {delta ? (
          <ul className="grid gap-2">
            {delta.rows.map((row) => {
              const digits = row.unit === "ms" || row.unit === "/100" ? 0 : 1;
              const show = (v) => (v === null ? "—" : `${fmt(v, digits)}${row.unit === "s" || row.unit === "ms" ? ` ${row.unit}` : row.unit === "/100" ? "/100" : "/min"}`);
              return (
                <li key={row.label} className="rounded-lg border border-line bg-ink/60 px-3 py-2">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                    <span className="text-[13px] font-semibold">{row.label}</span>
                    <span className="font-data text-[12px]">
                      <span style={{ color: row.ok ? C.emerald : C.amber }}>{show(row.draft)}</span>
                      <span className="text-muted"> · target {row.dir} {show(row.target)}</span>
                    </span>
                  </div>
                  <p className="mt-1 text-[12.5px] leading-snug" style={{ color: row.ok ? C.emerald : C.fg }}>{row.message}</p>
                </li>
              );
            })}
          </ul>
        ) : <p className="text-[13px] text-muted">No blueprints in the benchmark yet.</p>}
        <p className="mt-2 text-[11px] text-muted">
          {r.example ? "Pick a clip to grade it against the benchmark." : "Got a viral clip saved? Analyze it, then add it as a blueprint to grow your benchmark."} Speech pace needs the desktop engine (Whisper), so it isn't graded here.
        </p>
      </Section>
    </div>
  );
}

// ---------------------------------------------------------------------------------
// Outlier Radar tab
// ---------------------------------------------------------------------------------
function GoldenHud({ g }) {
  return (
    <Section title={`Golden niche benchmark · ${g.n} blueprint${g.n === 1 ? "" : "s"}`} icon={Crosshair} className="hud">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6">
        {TARGETS.map((t) => {
          const v = g.targets[t.key], s = g.spread[t.key];
          return (
            <div key={t.key} className="rounded-lg border border-line bg-ink/70 px-3 py-2">
              <div className="eyebrow">{t.label}</div>
              <div className="mt-0.5 font-data text-[19px] font-semibold text-emerald">{v === null ? "—" : `${t.prefix} ${fmt(v, t.digits)}`}<span className="ml-1 text-[11px] font-normal text-muted">{v === null ? "" : t.unit}</span></div>
              <div className="text-[10.5px] text-muted">{s.n ? `p25–p75 ${fmt(s.p25, t.digits)}–${fmt(s.p75, t.digits)} · n=${s.n}` : "no data"}</div>
            </div>
          );
        })}
      </div>
      <p className="mt-2 text-[11px] text-muted">Medians across decompiled 10x+ outliers from {g.creators.length} creator{g.creators.length === 1 ? "" : "s"}; the latency ceiling is the 75th percentile.</p>
    </Section>
  );
}

const barColor = (score, threshold) => (score === null ? "#2b3442" : score >= threshold ? C.emerald : score >= threshold / 2 ? C.amber : C.bar);

function OutlierChart({ scored, baseline, threshold, log, selected, onSelect }) {
  const data = [...scored].sort((a, b) => a.ts - b.ts).map((p) => ({ ...p, plot: Math.max(1, p.views || 0), label: new Date(p.ts * 1000).toLocaleDateString("en", { month: "short", day: "numeric" }) }));
  const top = Math.max(...data.map((d) => d.plot), baseline * threshold, 10) * 1.3;
  return (
    <div className="h-64 w-full">
      <ResponsiveContainer>
        <ComposedChart data={data} margin={{ top: 8, right: 6, bottom: 0, left: -8 }}>
          <CartesianGrid stroke={C.grid} vertical={false} />
          <XAxis dataKey="label" stroke={C.axis} fontSize={10} interval="preserveStartEnd" />
          <YAxis scale={log ? "log" : "linear"} domain={log ? [100, top] : [0, top]} allowDataOverflow tickFormatter={compact} stroke={C.axis} fontSize={10} width={44} />
          <Tooltip cursor={{ fill: "rgba(255,255,255,.04)" }} content={({ active, payload }) => {
            const p = active && payload && payload[0] ? payload[0].payload : null;
            if (!p) return null;
            return (
              <div className="rounded-lg border border-line bg-panel px-3 py-2 text-[12px]">
                <div className="mb-0.5 font-semibold">{p.title}</div>
                <div>{compact(p.views)} views{p.estimated ? " (est.)" : ""} · baseline {compact(p.baseline)}</div>
                <div className="font-data font-semibold" style={{ color: barColor(p.score, threshold) }}>{p.score === null ? "unscored" : `${p.score}x`}</div>
              </div>
            );
          }} />
          <ReferenceLine y={Math.max(1, baseline)} stroke={C.muted} strokeDasharray="6 4" label={{ value: `baseline ${compact(baseline)}`, fill: C.muted, fontSize: 10, position: "insideTopLeft" }} />
          <ReferenceLine y={baseline * threshold} stroke={C.emerald} strokeOpacity={0.6} strokeDasharray="2 4" label={{ value: `${threshold}x gate`, fill: C.emerald, fontSize: 10, position: "insideTopLeft" }} />
          <Bar dataKey="plot" radius={[3, 3, 0, 0]} isAnimationActive={false} onClick={(d) => onSelect(d)} cursor="pointer">
            {data.map((p) => (
              <Cell key={p.id} fill={barColor(p.score, threshold)} stroke={selected === p.id ? C.fg : "none"} strokeWidth={2}
                style={p.outlier ? { filter: `drop-shadow(0 0 5px ${C.emerald})` } : undefined} />
            ))}
          </Bar>
          <Line dataKey="baseline" stroke={C.fg} strokeOpacity={0.35} strokeDasharray="3 3" dot={false} isAnimationActive={false} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

function Inspector({ bp, g, onClose }) {
  const dur = bp.t.duration;
  const pct = (t) => `${Math.min(100, (t / dur) * 100)}%`;
  return (
    <Section title={<span className="flex items-center gap-2"><span className="chip font-data" style={{ color: C.emerald, borderColor: `${C.emerald}66` }}>{bp.score}x</span><span className="truncate">{bp.title}</span></span>}
      action={<button type="button" className="btn-ghost" onClick={onClose} aria-label="Close blueprint"><X size={14} aria-hidden="true" /></button>} className="hud">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Views" value={compact(bp.views)} hint={`@${bp.creator} · baseline ${compact(bp.baseline)}`} />
        <Stat label="Eng. velocity" value={fmt(bp.velocity, 1)} hint="(L+3C+5R)/views×1000" />
        <Stat label="Cuts / min" value={fmt(bp.t.cpm, 1)} hint={`avg shot ${fmt(bp.t.avg_shot, 2)}s`} />
        <Stat label="First cut" value={bp.t.first_cut === null ? "—" : `${bp.t.first_cut.toFixed(2)}s`} />
        <Stat label="Audio onset" value={bp.t.latency_ms === null ? "—" : `${Math.round(bp.t.latency_ms)} ms`} />
        <Stat label="Hook motion" value={`${Math.round(bp.t.hook_motion)}/100`} />
        <Stat label="Pace" value={bp.t.wpm ? `${Math.round(bp.t.wpm)} wpm` : "—"} />
        <Stat label="Length" value={`${dur.toFixed(1)}s`} />
      </div>
      <div className="mt-4">
        <div className="eyebrow mb-1.5">3-second hook</div>
        <blockquote className="rounded-lg border-l-2 bg-ink px-3 py-2 text-[15px]" style={{ borderColor: C.emerald }}>
          {bp.hook ? `“${bp.hook}”` : <span className="text-[13px] text-muted">No transcript (analyzed on device; speech needs the desktop engine).</span>}
        </blockquote>
      </div>
      <div className="mt-4">
        <div className="eyebrow mb-1.5">Cut cadence</div>
        <div className="relative h-9 rounded-md bg-ink ring-1 ring-line">
          <div className="absolute inset-y-0 left-0" style={{ width: pct(HOOK), background: "rgba(180,155,255,.12)" }} />
          {g.targets.first_cut !== null && <div className="absolute inset-y-0 w-px" style={{ left: pct(g.targets.first_cut), background: C.emerald }} title="Benchmark first cut" />}
          {bp.cuts.map((c, i) => <div key={i} className="absolute top-1 h-7 w-0.5 rounded" style={{ left: pct(c), background: C.amber }} />)}
        </div>
        <div className="mt-1 flex justify-between font-data text-[10px] text-muted"><span>0s</span><span>{(dur / 2).toFixed(0)}s</span><span>{dur.toFixed(0)}s</span></div>
      </div>
      <div className="mt-3">
        <div className="eyebrow mb-1.5">RMS energy · 100 ms windows</div>
        <div className="h-36">
          <ResponsiveContainer>
            <AreaChart data={bp.rms} margin={{ top: 4, right: 4, bottom: 0, left: -24 }}>
              <defs><linearGradient id="gr" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={C.amber} stopOpacity={0.45} /><stop offset="100%" stopColor={C.amber} stopOpacity={0} /></linearGradient></defs>
              <CartesianGrid stroke={C.grid} vertical={false} />
              <XAxis dataKey="t" type="number" domain={[0, "dataMax"]} tickFormatter={(v) => `${Math.round(v)}s`} stroke={C.axis} fontSize={10} />
              <YAxis domain={[-90, 0]} stroke={C.axis} fontSize={10} />
              <Tooltip {...chartTooltip} labelFormatter={(v) => `${Number(v).toFixed(1)}s`} formatter={(v) => [`${v} dB`, "RMS"]} />
              {bp.cuts.map((c, i) => <ReferenceLine key={i} x={c} stroke={C.amber} strokeOpacity={0.25} />)}
              <Area type="monotone" dataKey="db" stroke={C.amber} fill="url(#gr)" strokeWidth={1.5} isAnimationActive={false} />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </div>
      {bp.example && <p className="mt-2 text-[11px] text-muted">Example blueprint with sample telemetry.</p>}
    </Section>
  );
}

function OutlierRadar({ posts, setPosts, threshold, setThreshold, platform, setPlatform, blueprints, g, onRemoveBlueprint }) {
  const [log, setLog] = useState(true);
  const [selected, setSelected] = useState("p8");
  const [inspect, setInspect] = useState("sd-hit-1");
  const [paste, setPaste] = useState("");
  const [confirmReset, setConfirmReset] = useState(false);
  const { scored, creatorBaseline } = useMemo(() => scorePosts(posts, threshold, platform), [posts, threshold, platform]);
  const outliers = scored.filter((p) => p.outlier);
  const all = useMemo(() => Object.fromEntries(blueprints.map((b) => [b.id, b])), [blueprints]);
  const inspected = inspect ? all[inspect] : null;

  const pick = (p) => { setSelected(p.id); if (p.telemetry && all[p.telemetry]) setInspect(p.telemetry); };
  const edit = (id, field, value) => setPosts(posts.map((p) => (p.id === id ? { ...p, [field]: value === "" ? "" : Math.max(0, Number(value)) } : p)));
  const applyPaste = () => {
    const nums = paste.split(/[\s,;]+/).map((s) => s.replace(/[^\d.kKmM]/g, "")).filter(Boolean).map((s) => {
      const m = s.toLowerCase(); const n = parseFloat(m);
      return Math.round(m.endsWith("m") ? n * 1e6 : m.endsWith("k") ? n * 1e3 : n);
    }).filter((n) => Number.isFinite(n));
    if (!nums.length) return;
    // Pasted numbers are a new creator: fresh rows, no sample titles, likes or blueprints.
    const stamp = Date.now();
    const next = nums.slice(0, 60).map((views, i) => ({
      id: `u${stamp}-${i}`, title: `Post ${i + 1}`, ts: Math.floor(stamp / 1000) - (nums.length - 1 - i) * 2 * 86400,
      views, likes: "", comments: "", reposts: "", telemetry: null,
    }));
    setPosts(next);
    setSelected(null);
    setInspect(null);
    setPaste("");
  };

  return (
    <div className="grid gap-4">
      <GoldenHud g={g} />

      <Section title="Leave-one-out outlier calculator" icon={Radar}
        action={<Segmented label="Platform" value={platform} onChange={setPlatform} options={[{ value: "tiktok", label: "TikTok" }, { value: "instagram", label: "Instagram" }]} />}>
        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
          <label htmlFor="threshold" className="grid gap-1 text-[12px] text-muted">
            <span>Outlier multiplier threshold · <b className="font-data text-fg">{threshold}x</b></span>
            <input id="threshold" type="range" min="2" max="50" step="0.5" value={threshold} onChange={(e) => setThreshold(Number(e.target.value))} className="accent-emerald" />
          </label>
          <div className="flex items-center gap-2">
            <button type="button" className={`btn-ghost ${log ? "!border-emerald !text-emerald" : ""}`} aria-pressed={log} onClick={() => setLog(!log)}>Log scale</button>
            {confirmReset ? (
              <>
                <button type="button" className="btn-ghost !text-risk" onClick={() => { setPosts(samplePosts()); setConfirmReset(false); }}>Reset</button>
                <button type="button" className="btn-ghost" onClick={() => setConfirmReset(false)}>Keep</button>
              </>
            ) : (
              <button type="button" className="btn-ghost" onClick={() => setConfirmReset(true)}><RotateCcw size={14} aria-hidden="true" />Sample</button>
            )}
          </div>
        </div>

        <div className="mt-3 rounded-lg border border-line bg-ink/60 px-3 py-2 font-data text-[11.5px] leading-relaxed text-muted">
          baseline<sub>i</sub> = max(trimmed_mean, median, 1) of every other post · score = views / baseline · velocity = (L + 3C + 5R) / views × 1000
        </div>

        <div className="mt-3">
          <OutlierChart scored={scored} baseline={creatorBaseline} threshold={threshold} log={log} selected={selected} onSelect={pick} />
        </div>
        <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted">
          <span><i className="legend" style={{ background: C.emerald }} />≥ {threshold}x outlier</span>
          <span><i className="legend" style={{ background: C.amber }} />≥ {threshold / 2}x rising</span>
          <span>Trimmed baseline {compact(creatorBaseline)} · {outliers.length} of {scored.length} posts clear the gate</span>
        </div>

        <div className="mt-4 grid gap-2">
          <label htmlFor="paste" className="text-[12px] text-muted">Paste your own view counts (oldest first; 1.2k and 3m work)</label>
          <div className="flex gap-2">
            <textarea id="paste" rows={2} className="input min-w-0 flex-1 font-data text-[12px]" placeholder="2100, 1850, 2400, 96k, 2300…" value={paste} onChange={(e) => setPaste(e.target.value)} />
            <button type="button" className="btn-primary self-start" onClick={applyPaste} disabled={!paste.trim()}>Use</button>
          </div>
        </div>

        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[600px] text-[12.5px]">
            <thead>
              <tr className="text-left">
                <th className="eyebrow pb-2">Post</th>
                <th className="eyebrow pb-2 text-right">{platform === "instagram" ? "Views (0 = hidden)" : "Views"}</th>
                <th className="eyebrow pb-2 text-right">Likes</th>
                <th className="eyebrow pb-2 text-right">LOO baseline</th>
                <th className="eyebrow pb-2 text-right">Score</th>
                <th className="eyebrow pb-2 text-right">Velocity</th>
              </tr>
            </thead>
            <tbody>
              {[...scored].sort((a, b) => (b.score ?? -1) - (a.score ?? -1)).map((p) => (
                <tr key={p.id} onClick={() => pick(p)} className={`cursor-pointer border-t border-line ${selected === p.id ? "bg-white/[.04]" : ""}`}>
                  <td className="max-w-[180px] py-1.5 pr-2">
                    <div className="truncate">{p.title}</div>
                    <div className="text-[10.5px]" style={{ color: p.telemetry ? C.emerald : C.muted }}>{p.telemetry ? "decompiled · tap to inspect" : p.outlier ? "needs the clip to decompile" : new Date(p.ts * 1000).toLocaleDateString("en", { month: "short", day: "numeric" })}</div>
                  </td>
                  <td className="py-1.5 text-right">
                    <input aria-label={`Views for ${p.title}`} inputMode="numeric" className="input w-24 py-1 text-right font-data text-[12px]" value={posts.find((q) => q.id === p.id).views}
                      onClick={(e) => e.stopPropagation()} onChange={(e) => edit(p.id, "views", e.target.value)} />
                    {p.estimated && <div className="text-[10px]" style={{ color: C.amber }}>est. {compact(p.views)}</div>}
                  </td>
                  <td className="py-1.5 text-right font-data text-muted">{compact(Number(p.likes) || null)}</td>
                  <td className="py-1.5 text-right font-data text-muted">{compact(p.baseline)}</td>
                  <td className="py-1.5 text-right font-data font-semibold" style={{ color: barColor(p.score, threshold) }}>{p.score === null ? "—" : `${fmt(p.score, 2)}x`}</td>
                  <td className="py-1.5 text-right font-data text-muted">{fmt(p.velocity, 1)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-[11px] text-muted">
          Example creator @sleepdoc with sample numbers. Several hits in one sweep raise each other's baselines: only the single highest post is trimmed, so a strong second hit can fall under the gate.
          {platform === "instagram" && " Instagram hides some view counts; a 0 with likes is estimated as likes × 18.5."}
        </p>
      </Section>

      {inspected && <Inspector key={inspected.id} bp={inspected} g={g} onClose={() => setInspect(null)} />}

      <Section title={`Blueprint library · ${blueprints.length}`} icon={Sparkles}>
        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {blueprints.map((b) => (
            <div key={b.id} className={`relative rounded-lg border px-3 py-2 text-left transition ${inspect === b.id ? "border-emerald bg-emerald/5" : "border-line"}`}>
              <button type="button" className="block w-full text-left" onClick={() => setInspect(b.id)}>
                <div className="flex items-center justify-between gap-2 pr-6">
                  <span className="truncate text-[13px] font-semibold">@{b.creator}</span>
                  <span className="shrink-0 font-data text-[12px] text-emerald">{b.score}x</span>
                </div>
                <div className="truncate text-[12px] text-muted">{b.hook ? `“${b.hook}”` : b.title}</div>
                <div className="mt-0.5 font-data text-[10.5px] text-muted">{compact(b.views)} views · {fmt(b.t.cpm, 0)} cuts/min · first cut {b.t.first_cut === null ? "—" : `${b.t.first_cut.toFixed(1)}s`}{b.example ? " · example" : " · yours"}</div>
              </button>
              {!b.example && (
                <button type="button" className="absolute right-2 top-2 text-muted hover:text-risk" onClick={() => onRemoveBlueprint(b.id)} aria-label={`Remove ${b.title}`}><Trash2 size={14} aria-hidden="true" /></button>
              )}
            </div>
          ))}
        </div>
      </Section>
    </div>
  );
}

// ---------------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------------
function App() {
  const saved = useMemo(load, []);
  const [tab, setTab] = useState(() => (location.hash === "#radar" ? "radar" : "preflight"));
  const [report, setReport] = useState(exampleAnalysis);
  const [posts, setPosts] = useState(() => (Array.isArray(saved.posts) && saved.posts.length ? saved.posts : samplePosts()));
  const [threshold, setThreshold] = useState(saved.threshold || 10);
  const [platform, setPlatform] = useState(saved.platform || "tiktok");
  const [mine, setMine] = useState(Array.isArray(saved.mine) ? saved.mine : []);

  useEffect(() => save({ posts, threshold, platform, mine }), [posts, threshold, platform, mine]);
  useEffect(() => {
    const onHash = () => setTab(location.hash === "#radar" ? "radar" : "preflight");
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  const go = (t) => { setTab(t); try { history.replaceState(null, "", t === "radar" ? "#radar" : "#preflight"); } catch (_) { /* sandboxed */ } };

  // Blueprints = examples + this creator's decompiled hits that clear the gate + your own.
  const { scored } = useMemo(() => scorePosts(posts, threshold, platform), [posts, threshold, platform]);
  const blueprints = useMemo(() => {
    const scanHits = scored.filter((p) => p.outlier && p.telemetry && SAMPLE_TELEMETRY[p.telemetry])
      .map((p) => ({ ...SAMPLE_TELEMETRY[p.telemetry], views: p.views, baseline: p.baseline, score: p.score, velocity: p.velocity }));
    return [...mine, ...scanHits, ...LIBRARY];
  }, [scored, mine]);
  const g = useMemo(() => golden(blueprints), [blueprints]);

  const addBlueprint = (r) => {
    const id = `mine-${Date.now()}`;
    setMine([{ id, creator: "you", title: r.name, views: null, baseline: null, score: threshold, velocity: null, example: false, hook: "",
      cuts: r.pacing.cuts, rms: r.audio.curve.length ? r.audio.curve : rmsCurve(1, r.duration), t: r.telemetry }, ...mine]);
  };

  return (
    <div className="mx-auto max-w-[1180px]">
      <header className="appbar">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="font-display text-[19px] font-bold leading-none tracking-wider">ATPE<span className="text-emerald">/</span>MOBILE</div>
            <div className="mt-1 truncate text-[11px] text-muted">Telemetry & pre-flight, on device</div>
          </div>
          <nav className="flex shrink-0 rounded-xl border border-line bg-ink p-1" aria-label="Sections">
            {[{ id: "preflight", label: "Pre-Flight", Icon: Eye }, { id: "radar", label: "Outliers", Icon: Radar }].map(({ id, label, Icon }) => (
              <button key={id} type="button" onClick={() => go(id)} aria-current={tab === id ? "page" : undefined}
                className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[13px] font-semibold transition ${tab === id ? "bg-emerald text-ink" : "text-muted hover:text-fg"}`}>
                <Icon size={15} aria-hidden="true" />{label}
              </button>
            ))}
          </nav>
        </div>
      </header>
      <main className="pb-10 pt-4">
        {tab === "preflight" ? (
          <PreFlight report={report} setReport={setReport} golden={g} onAddBlueprint={addBlueprint} />
        ) : (
          <OutlierRadar posts={posts} setPosts={setPosts} threshold={threshold} setThreshold={setThreshold} platform={platform} setPlatform={setPlatform}
            blueprints={blueprints} g={g} onRemoveBlueprint={(id) => setMine(mine.filter((b) => b.id !== id))} />
        )}
        <footer className="mt-6 flex items-start gap-2 text-[11px] leading-relaxed text-muted">
          <CheckCircle2 size={13} className="mt-0.5 shrink-0 text-emerald" aria-hidden="true" />
          <span>Videos are decoded in this browser and never leave your phone. Motion here is frame-difference energy, so scores track but don't exactly equal the desktop engine's optical flow. Safe-zone boxes are measured approximations of the current apps.</span>
        </footer>
      </main>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
