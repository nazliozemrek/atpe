/* Viral Check — the everyday version of ATPE Mobile. Same engine (engine.jsx), same
 * measurements and formulas as the pro view; plain language, one overall score, the top
 * fixes first and the raw numbers behind "See the numbers".
 *
 * Globals (UMD): React, ReactDOM, Recharts, LucideReact.
 */
const { useState, useEffect, useMemo, useRef } = React;
const { ResponsiveContainer, ComposedChart, Bar, XAxis, YAxis, Tooltip, ReferenceLine, Cell } = Recharts;
const {
  Film, Sparkles, CheckCircle2, ChevronDown, Flame, Smartphone, Zap, Sun, Volume2,
  Scissors, Repeat, Clock, MoveVertical, Info, RotateCcw, Plus, TrendingUp,
} = LucideReact;

// ---------------------------------------------------------------------------------
// Plain-language layer over the engine
// ---------------------------------------------------------------------------------

/** Overall readiness: hook 40 %, keeps attention 25 %, rewatch flow 15 %, vs viral 20 %
 *  (without benchmark data its weight is shared out over the other three). */
function overall(r, delta) {
  const parts = [[r.hook.score, 40], [r.retention, 25], [r.loop.score, 15]];
  if (delta) parts.push([delta.score, 20]);
  const w = parts.reduce((s, [, k]) => s + k, 0);
  return parts.reduce((s, [v, k]) => s + v * k, 0) / w;
}

const verdict = (s) =>
  s >= 75 ? { label: "Ready to post", color: C.emerald, line: "Strong start, steady pacing. Post it." }
    : s >= 50 ? { label: "Almost there", color: C.amber, line: "A couple of quick edits will help it hold viewers." }
      : { label: "Needs work", color: C.risk, line: "Fix the first few tips below before you post." };

const grade = (s) => (s >= 70 ? { word: "Good", color: C.emerald } : s >= 45 ? { word: "OK", color: C.amber } : { word: "Weak", color: C.risk });

const secs = (ms) => `${(ms / 1000).toFixed(1)}s`;

/** Turns engine flags and benchmark gaps into short, do-this-next tips. */
function tipsFor(r, delta) {
  const tips = [];
  const add = (key, Icon, title, why, weight) => { if (!tips.some((t) => t.key === key)) tips.push({ key, Icon, title, why, weight }); };
  const codes = new Set(r.recs.map((f) => f.code));
  const h = r.hook;

  if (codes.has("static") || codes.has("lowmotion"))
    add("motion", Zap, "Start with movement", "Open on motion, a zoom or a quick cut. A still first frame is the easiest one to swipe past.", 10);
  if (codes.has("deadair"))
    add("silence", Volume2, `Cut the silent start (${secs(h.deadAirMs)})`, "Nothing is heard for the first moment. Start talking or play sound right away.", 9);
  else if (codes.has("late") || codes.has("nohit"))
    add("sound", Volume2, "Make the first sound hit sooner", h.latencyMs === null ? "No clear sound was found. Add a voice, a beat or a sound effect at the very start." : `The first strong sound comes at ${secs(h.latencyMs)}. Aim for under 0.2s.`, 8);
  if (codes.has("noaudio")) add("noaudio", Volume2, "Add sound", "Videos with a voice or music hold attention longer. Add audio before posting.", 9);
  if (codes.has("dark")) add("dark", Sun, "Brighten the first frame", "The opening looks dark. Light it better or open on a brighter shot.", 7);
  if (codes.has("flat")) add("flat", Sun, "Show something clear in frame 1", "The first frame is plain. Open on a face, an object or bold text.", 5);
  if (codes.has("quiet")) add("quiet", Volume2, "Make the start as loud as the rest", "The opening is noticeably quieter than the rest of the video.", 5);
  r.pacing.stagnation.slice(0, 2).forEach((z, i) =>
    add(`still${i}`, Scissors, `Add a cut around ${z.start.toFixed(1)}s`, `From ${z.start.toFixed(1)}s to ${z.end.toFixed(1)}s nothing changes on screen. Change the shot about every 2–3 seconds.`, 7 - i));
  if (r.loop.trimStartMs || r.loop.trimEndMs) {
    const parts = [r.loop.trimStartMs && `${secs(r.loop.trimStartMs)} from the start`, r.loop.trimEndMs && `${secs(r.loop.trimEndMs)} from the end`].filter(Boolean);
    add("loop", Repeat, `Trim ${parts.join(" and ")}`, "The end will flow straight back into the start, so more people watch it twice.", 4);
  }
  if (codes.has("aspect")) add("aspect", MoveVertical, "Make it vertical (9:16)", "Your video isn't vertical, so the app will add bars or crop it.", 6);
  (delta?.rows || []).filter((row) => row.ok === false).forEach((row) => {
    if (row.label === "First cut" && row.draft !== null) add("firstcut", Scissors, `Make your first cut sooner (by ${row.target.toFixed(1)}s)`, `Yours is at ${row.draft.toFixed(1)}s. Viral videos in this niche cut by ${row.target.toFixed(1)}s.`, 6);
    if (row.label === "Cuts per minute") add("pace", Clock, "Cut a little faster", `You change shots about ${Math.round(row.draft)} times a minute; viral videos here do it ${Math.round(row.target)} times.`, 3);
  });
  return tips.sort((a, b) => b.weight - a.weight);
}

/** "Where people might scroll away": one colour per stretch of the timeline. */
function attentionStrip(r) {
  const segs = [];
  r.bins.forEach((b) => {
    const level = b.risk >= 60 ? "high" : b.risk >= 40 ? "mid" : "low";
    const last = segs[segs.length - 1];
    if (last && last.level === level) last.end = b.t + 0.25;
    else segs.push({ level, start: b.t, end: b.t + 0.25 });
  });
  return segs.map((s) => ({ ...s, end: Math.min(s.end, r.duration) }));
}
const LEVEL = { low: C.emerald, mid: C.amber, high: C.risk };

// ---------------------------------------------------------------------------------
// Persistence (per-viewer convenience only)
// ---------------------------------------------------------------------------------
const KEY = "atpe.simple.v1";
const loadState = () => { try { return JSON.parse(localStorage.getItem(KEY) || "{}"); } catch (_) { return {}; } };
const saveState = (v) => { try { localStorage.setItem(KEY, JSON.stringify(v)); } catch (_) { /* storage blocked */ } };

// ---------------------------------------------------------------------------------
// UI pieces
// ---------------------------------------------------------------------------------
function BigScore({ value, sub }) {
  const v = verdict(value);
  const r = 46, c = 2 * Math.PI * r;
  return (
    <div className="flex items-center gap-4">
      <svg width="112" height="112" viewBox="0 0 112 112" className="shrink-0" role="img" aria-label={`Overall score ${Math.round(value)} out of 100: ${v.label}`}>
        <circle cx="56" cy="56" r={r} fill="none" stroke="rgb(var(--line))" strokeWidth="10" />
        <circle cx="56" cy="56" r={r} fill="none" stroke={v.color} strokeWidth="10" strokeLinecap="round" strokeDasharray={`${c * clip01(value / 100)} ${c}`} transform="rotate(-90 56 56)" />
        <text x="56" y="63" textAnchor="middle" fill="rgb(var(--fg))" fontSize="30" fontWeight="700" fontFamily="var(--font-display)">{Math.round(value)}</text>
      </svg>
      <div className="min-w-0">
        <div className="font-display text-[24px] font-bold leading-tight" style={{ color: v.color }}>{v.label}</div>
        <p className="mt-1 text-[14px] leading-snug text-fg/90">{v.line}</p>
        {sub && <p className="mt-1 text-[12px] text-muted">{sub}</p>}
      </div>
    </div>
  );
}

function ReportTile({ Icon, title, score, line }) {
  const g = grade(score);
  return (
    <div className="panel flex items-start gap-3 p-3">
      <Icon size={20} className="mt-0.5 shrink-0" style={{ color: g.color }} aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-[14px] font-semibold">{title}</span>
          <span className="chip" style={{ color: g.color, borderColor: `${g.color}66` }}>{g.word} · {Math.round(score)}</span>
        </div>
        <p className="mt-0.5 text-[12.5px] leading-snug text-muted">{line}</p>
      </div>
    </div>
  );
}

function Disclosure({ id, title, children, defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="panel">
      <button type="button" id={`${id}-btn`} aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left text-[14px] font-semibold">
        {title}
        <ChevronDown size={18} className={`shrink-0 text-muted transition-transform ${open ? "rotate-180" : ""}`} aria-hidden="true" />
      </button>
      {open && <div id={id} className="border-t border-line px-4 pb-4 pt-3">{children}</div>}
    </section>
  );
}

function Row({ label, value, note }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-line py-2 last:border-0">
      <span className="text-[13px]">{label}{note && <span className="block text-[11.5px] text-muted">{note}</span>}</span>
      <span className="min-w-0 text-right font-data text-[13px]">{value}</span>
    </div>
  );
}

function Toggle({ value, onChange, options, label }) {
  return (
    <div className="inline-flex rounded-full border border-line bg-ink p-0.5" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={value === o.value} onClick={() => onChange(o.value)}
          className={`rounded-full px-3 py-1 text-[12.5px] font-semibold transition ${value === o.value ? "bg-emerald text-ink" : "text-muted"}`}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------------
// Tab 1: Check my video
// ---------------------------------------------------------------------------------
function PhonePreview({ r, src, videoRef, overlay, setOverlay, cursor, onSeek, onTime }) {
  const segs = attentionStrip(r);
  return (
    <section className="panel p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 font-display text-[16px] font-semibold"><Smartphone size={17} className="text-emerald" aria-hidden="true" />How it looks in the app</h2>
        <Toggle label="Show app buttons" value={overlay} onChange={setOverlay} options={[{ value: "off", label: "Plain" }, { value: "tiktok", label: "TikTok" }, { value: "reels", label: "Reels" }]} />
      </div>
      <div className="relative mx-auto aspect-[9/16] w-full max-w-[280px] overflow-hidden rounded-2xl bg-black ring-1 ring-line">
        {src ? (
          <video ref={videoRef} src={src} className="absolute inset-0 h-full w-full object-contain" controls playsInline loop onTimeUpdate={(e) => onTime(e.currentTarget.currentTime)} />
        ) : (
          <div className="absolute inset-0 bg-[radial-gradient(120%_70%_at_30%_20%,#1d2a3d,#07090d)]">
            <div className="absolute left-[34%] top-[44%] whitespace-nowrap font-display text-[24px] font-bold text-white drop-shadow">3 SLEEP SECRETS</div>
          </div>
        )}
        {overlay !== "off" && (
          <div className="pointer-events-none absolute inset-0">
            {ZONES[overlay].map((z) => (
              <div key={z.label} className="absolute border-2" style={{ left: `${z.x0 * 100}%`, top: `${z.y0 * 100}%`, width: `${(z.x1 - z.x0) * 100}%`, height: `${(z.y1 - z.y0) * 100}%`, borderColor: ZONE_STYLE[z.kind].border, background: ZONE_STYLE[z.kind].fill }} />
            ))}
            <div className="absolute border-2 border-dashed" style={{ borderColor: C.emerald, left: `${SAFE.x0 * 100}%`, top: `${SAFE.y0 * 100}%`, width: `${(SAFE.x1 - SAFE.x0) * 100}%`, height: `${(SAFE.y1 - SAFE.y0) * 100}%` }} />
          </div>
        )}
      </div>
      <p className="mt-2 text-center text-[12px] text-muted">
        {overlay === "off" ? "Turn on TikTok or Reels to see where the app's buttons and caption cover your video." : "Keep text and faces inside the dashed box. Shaded areas sit under the app's buttons and caption."}
      </p>

      <div className="mt-4">
        <div className="mb-1.5 text-[13px] font-semibold">Where people might scroll away</div>
        <div className="relative flex h-5 w-full overflow-hidden rounded-full ring-1 ring-line" role="group" aria-label="Attention along the video">
          {segs.map((s, i) => (
            <button key={i} type="button" onClick={() => onSeek(s.start)} aria-label={`${s.start.toFixed(1)} to ${s.end.toFixed(1)} seconds: ${s.level === "high" ? "likely to lose viewers" : s.level === "mid" ? "some risk" : "holding attention"}`}
              style={{ width: `${((s.end - s.start) / r.duration) * 100}%`, background: LEVEL[s.level] }} className="h-full opacity-80 hover:opacity-100" />
          ))}
          {cursor !== null && <span className="pointer-events-none absolute inset-y-0 w-0.5 bg-white" style={{ left: `${(cursor / r.duration) * 100}%` }} />}
        </div>
        <div className="mt-1.5 flex justify-between text-[11.5px] text-muted">
          <span>0s</span>
          <span className="flex gap-3">
            <span><i className="legend" style={{ background: C.emerald }} />Holding</span>
            <span><i className="legend" style={{ background: C.amber }} />Some risk</span>
            <span><i className="legend" style={{ background: C.risk }} />Likely to lose viewers</span>
          </span>
          <span>{r.duration.toFixed(0)}s</span>
        </div>
        {src && <p className="mt-1 text-[11.5px] text-muted">Tap a colour to jump there in the video.</p>}
      </div>
    </section>
  );
}

function CheckVideo({ report, setReport, g, onAddExample }) {
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState({ p: 0, label: "" });
  const [error, setError] = useState(null);
  const [src, setSrc] = useState(null);
  const [overlay, setOverlay] = useState("tiktok");
  const [cursor, setCursor] = useState(null);
  const [showAll, setShowAll] = useState(false);
  const [added, setAdded] = useState(false);
  const videoRef = useRef(null);
  const abortRef = useRef(null);
  useEffect(() => () => { if (src) URL.revokeObjectURL(src); }, [src]);

  const run = async (file) => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setError(null); setBusy(true); setShowAll(false); setAdded(false); setCursor(null);
    const url = URL.createObjectURL(file);
    setSrc((old) => { if (old) URL.revokeObjectURL(old); return url; });
    try {
      setStep({ p: 0.02, label: "Opening your video…" });
      const frames = await extractFrames(url, (p) => setStep({ p, label: "Watching your video…" }), ctrl.signal);
      setStep({ p: 0.8, label: "Listening to the sound…" });
      const audio = await extractAudio(file);
      setStep({ p: 0.95, label: "Putting your score together…" });
      setReport(analyze(frames, audio, file.name));
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
  const score = overall(r, delta);
  const tips = tipsFor(r, delta);
  const shown = showAll ? tips : tips.slice(0, 3);
  const h = r.hook;
  const hookLine = h.latencyMs !== null && h.latencyMs <= 200 && h.visual >= 50 ? "Grabs attention right away." : h.visual < 40 ? "The opening looks too still." : "The first sound comes a little late.";
  const keepLine = r.zones.length ? `${r.zones.length} spot${r.zones.length === 1 ? "" : "s"} where viewers might leave.` : "No slow spots found.";
  const loopLine = r.loop.trimStartMs || r.loop.trimEndMs ? "A small trim makes it loop smoothly." : "Already flows back to the start.";

  return (
    <div className="grid gap-4">
      <section className="panel p-4">
        <label htmlFor="video-file" className={`flex cursor-pointer flex-col items-center gap-2 rounded-2xl border-2 border-dashed px-4 py-7 text-center transition ${busy ? "pointer-events-none opacity-60" : "border-line hover:border-emerald"}`}>
          <Film size={30} className="text-emerald" aria-hidden="true" />
          <span className="font-display text-[18px] font-semibold">{r.example ? "Pick a video to check" : "Check another video"}</span>
          <span className="max-w-[34ch] text-[13px] text-muted">We look at the first 2 seconds, the sound, the pacing and how it loops. Your video stays on your phone.</span>
        </label>
        <input id="video-file" type="file" accept="video/*" className="sr-only" disabled={busy}
          onChange={(e) => { const f = e.target.files?.[0]; if (f) void run(f); e.target.value = ""; }} />
        {busy && (
          <div className="mt-3" aria-live="polite">
            <div className="mb-1 flex justify-between text-[13px]"><span>{step.label}</span><span className="font-data text-muted">{Math.round(step.p * 100)}%</span></div>
            <div className="h-2 overflow-hidden rounded-full bg-line"><div className="h-full rounded-full bg-emerald transition-[width] duration-300" style={{ width: `${step.p * 100}%` }} /></div>
            <p className="mt-1 text-[11.5px] text-muted">Longer videos take a little longer. Keep this screen open.</p>
          </div>
        )}
        {error && <p className="mt-3 rounded-lg border px-3 py-2 text-[13px]" style={{ borderColor: `${C.risk}66`, color: C.risk }}>{error} Try a video saved from your camera or editing app.</p>}
      </section>

      <section className="panel hud p-4">
        <div className="mb-3 flex items-center justify-between gap-2">
          <h2 className="font-display text-[16px] font-semibold">Your score</h2>
          {r.example && <span className="chip" style={{ color: C.amber, borderColor: `${C.amber}66` }}>Example result</span>}
        </div>
        <BigScore value={score} sub={r.example ? "This is a sample video. Pick yours above to get your own score." : `${r.name} · ${r.duration.toFixed(0)}s`} />
      </section>

      <section className="panel p-4">
        <h2 className="mb-3 flex items-center gap-2 font-display text-[16px] font-semibold"><CheckCircle2 size={17} className="text-emerald" aria-hidden="true" />{tips.length ? "Fix these first" : "Nothing to fix"}</h2>
        {tips.length ? (
          <ol className="grid gap-2.5">
            {shown.map((t, i) => (
              <li key={t.key} className="flex gap-3 rounded-xl border border-line bg-ink/60 p-3">
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-emerald/15 font-display text-[14px] font-bold text-emerald">{i + 1}</span>
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5 text-[14.5px] font-semibold"><t.Icon size={15} className="shrink-0 text-amber" aria-hidden="true" />{t.title}</div>
                  <p className="mt-0.5 text-[13px] leading-snug text-muted">{t.why}</p>
                </div>
              </li>
            ))}
          </ol>
        ) : <p className="text-[14px] text-muted">Your video passed every check.</p>}
        {tips.length > 3 && (
          <button type="button" className="mt-3 text-[13px] font-semibold text-emerald" onClick={() => setShowAll(!showAll)}>
            {showAll ? "Show fewer tips" : `Show all ${tips.length} tips`}
          </button>
        )}
      </section>

      <div className="grid gap-3 sm:grid-cols-3">
        <ReportTile Icon={Zap} title="First 2 seconds" score={h.score} line={hookLine} />
        <ReportTile Icon={TrendingUp} title="Keeps attention" score={r.retention} line={keepLine} />
        <ReportTile Icon={Repeat} title="Rewatch flow" score={r.loop.score} line={loopLine} />
      </div>

      <PhonePreview r={r} src={r.example ? null : src} videoRef={videoRef} overlay={overlay} setOverlay={setOverlay} cursor={cursor} onSeek={seekTo} onTime={setCursor} />

      <Disclosure id="numbers" title="See the numbers">
        <Row label="First sound" value={h.latencyMs === null ? "none found" : `${Math.round(h.latencyMs)} ms`} note="Aim for under 150 ms" />
        <Row label="Silence at the start" value={h.deadAirMs === null ? "—" : `${Math.round(h.deadAirMs)} ms`} />
        <Row label="Movement in the first 1.7s" value={`${Math.round(r.telemetry.hook_motion)} / 100`} />
        <Row label="First frame brightness" value={`${Math.round(h.firstLuma)} / 255`} note="Below 40 looks dark" />
        <Row label="Shot changes per minute" value={fmt(r.pacing.cpm, 1)} />
        <Row label="Average shot length" value={`${fmt(r.pacing.avgShot, 1)}s`} />
        <Row label="First cut" value={r.pacing.firstCut === null ? "no cuts" : `${r.pacing.firstCut.toFixed(1)}s`} />
        <Row label="Seconds with nothing changing" value={`${fmt(r.pacing.stagnationSeconds, 1)}s`} />
        <Row label="Loop trim" value={`${r.loop.trimStartMs} ms start · ${r.loop.trimEndMs} ms end`} />
        <Row label="Score breakdown" value={`hook ${Math.round(h.score)} · attention ${Math.round(r.retention)} · loop ${Math.round(r.loop.score)}${delta ? ` · vs viral ${Math.round(delta.score)}` : ""}`} />
        <p className="mt-2 text-[11.5px] leading-relaxed text-muted">Overall = first 2 seconds 40% + keeps attention 25% + rewatch flow 15% + matches viral videos 20%. Speech pace and on-screen text aren't checked on the phone.</p>
        {!r.example && (
          <button type="button" className="btn-ghost mt-3 whitespace-normal text-left" disabled={added} onClick={() => { onAddExample(r); setAdded(true); }}>
            <Plus size={14} aria-hidden="true" />{added ? "Saved as a viral example" : "This one went viral: use it as an example"}
          </button>
        )}
      </Disclosure>
    </div>
  );
}

// ---------------------------------------------------------------------------------
// Tab 2: Find my viral posts
// ---------------------------------------------------------------------------------
const parseViews = (text) => text.split(/[\s,;]+/).map((s) => s.trim().toLowerCase()).filter(Boolean).map((s) => {
  const n = parseFloat(s.replace(/[^\d.]/g, ""));
  return Math.round(s.endsWith("m") ? n * 1e6 : s.endsWith("k") ? n * 1e3 : n);
}).filter((n) => Number.isFinite(n) && n >= 0);

const viewsText = (posts) => posts.map((p) => (p.views >= 10000 && p.views % 1000 === 0 ? `${p.views / 1000}k` : String(p.views))).join(", ");

function FindViral({ posts, setPosts, threshold, setThreshold, platform, setPlatform, isSample, setIsSample, blueprints, g }) {
  const [text, setText] = useState(() => viewsText(posts));
  const [open, setOpen] = useState(null);
  useEffect(() => setText(viewsText(posts)), [posts]);
  const { scored } = useMemo(() => scorePosts(posts, threshold, platform), [posts, threshold, platform]);
  const viral = scored.filter((p) => p.outlier).sort((a, b) => b.score - a.score);
  // "Your usual" for people is the typical post (median of all views); each post's own
  // score still uses the leave-one-out trimmed baseline from the engine.
  const usual = Math.max(1, median(scored.map((p) => p.views).filter((v) => v !== null && Number.isFinite(v))));
  const byId = useMemo(() => Object.fromEntries(blueprints.map((b) => [b.id, b])), [blueprints]);
  const data = scored.map((p, i) => ({ ...p, n: i + 1, plot: Math.max(1, p.views || 0) }));
  const top = Math.max(...data.map((d) => d.plot), usual * threshold) * 1.3;
  const changed = parseViews(text).join(",") !== posts.map((p) => p.views).join(",");

  const apply = () => {
    const nums = parseViews(text).slice(0, 60);
    if (nums.length < 3) return;
    const stamp = Date.now();
    setPosts(nums.map((views, i) => ({ id: `v${stamp}-${i}`, title: `Post ${i + 1}`, ts: Math.floor(stamp / 1000) - (nums.length - 1 - i) * 172800, views, likes: "", comments: "", reposts: "", telemetry: null })));
    setIsSample(false);
    setOpen(null);
  };
  const T = g.targets;

  return (
    <div className="grid gap-4">
      <section className="panel p-4">
        <h2 className="font-display text-[18px] font-semibold">Which of your posts went viral?</h2>
        <p className="mt-1 text-[13.5px] text-muted">Type the view counts of your last 20 posts, oldest first. We find the ones that did far better than your usual.</p>
        <label htmlFor="views" className="sr-only">View counts</label>
        <textarea id="views" rows={3} className="input mt-3 w-full font-data text-[14px]" value={text} onChange={(e) => setText(e.target.value)} placeholder="2100, 1850, 2400, 96k, 2300…" />
        <div className="mt-1 text-[11.5px] text-muted">Separate with commas or spaces. 1.2k and 3m work. {parseViews(text).length} posts.</div>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <button type="button" className="btn-primary" disabled={!changed || parseViews(text).length < 3} onClick={apply}>Find viral posts</button>
          {!isSample && (
            <button type="button" className="btn-ghost" onClick={() => { setPosts(samplePosts()); setIsSample(true); }}><RotateCcw size={14} aria-hidden="true" />Example numbers</button>
          )}
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <div>
            <div className="mb-1.5 text-[13px] font-semibold">Counts as viral at</div>
            <Toggle label="Viral threshold" value={threshold} onChange={setThreshold} options={[{ value: 5, label: "5× usual" }, { value: 10, label: "10× usual" }, { value: 20, label: "20× usual" }]} />
          </div>
          <label htmlFor="ig" className="flex items-start gap-2 text-[13px]">
            <input id="ig" type="checkbox" className="mt-0.5 h-4 w-4 accent-emerald" checked={platform === "instagram"} onChange={(e) => setPlatform(e.target.checked ? "instagram" : "tiktok")} />
            <span>These are Instagram posts<span className="block text-[11.5px] text-muted">Instagram hides some view counts; type 0 for those.</span></span>
          </label>
        </div>
      </section>

      <section className="panel hud p-4">
        <div className="mb-2 flex items-center justify-between gap-2">
          <h2 className="flex items-center gap-2 font-display text-[16px] font-semibold"><Flame size={17} className="text-emerald" aria-hidden="true" />Your results</h2>
          {isSample && <span className="chip" style={{ color: C.amber, borderColor: `${C.amber}66` }}>Example numbers</span>}
        </div>
        <p className="text-[15px] leading-snug">
          Your usual post gets about <b className="font-data">{compact(usual)}</b> views.{" "}
          {viral.length ? <>{viral.length === 1 ? "1 post" : `${viral.length} posts`} went viral ({threshold}× or more).</> : <>No post reached {threshold}× your usual yet.</>}
        </p>
        <div className="mt-3 h-44 w-full">
          <ResponsiveContainer>
            <ComposedChart data={data} margin={{ top: 6, right: 4, bottom: 0, left: -10 }}>
              <XAxis dataKey="n" stroke={C.axis} fontSize={10} tickLine={false} interval="preserveStartEnd" />
              <YAxis scale="log" domain={[100, top]} allowDataOverflow tickFormatter={compact} stroke={C.axis} fontSize={10} width={40} />
              <Tooltip cursor={{ fill: "rgba(255,255,255,.04)" }} content={({ active, payload }) => {
                const p = active && payload && payload[0] ? payload[0].payload : null;
                return p ? <div className="rounded-lg border border-line bg-panel px-3 py-2 text-[12px]">{p.title}: {compact(p.views)} views · {p.score}× usual</div> : null;
              }} />
              <ReferenceLine y={usual} stroke={C.muted} strokeDasharray="5 4" label={{ value: "your usual", fill: C.muted, fontSize: 10, position: "insideTopLeft" }} />
              <Bar dataKey="plot" radius={[3, 3, 0, 0]} isAnimationActive={false}>
                {data.map((p) => <Cell key={p.id} fill={p.outlier ? C.emerald : p.score >= threshold / 2 ? C.amber : C.bar} />)}
              </Bar>
            </ComposedChart>
          </ResponsiveContainer>
        </div>
        <div className="mt-1 flex flex-wrap gap-x-4 text-[11.5px] text-muted">
          <span><i className="legend" style={{ background: C.emerald }} />Viral</span>
          <span><i className="legend" style={{ background: C.amber }} />Doing well</span>
          <span><i className="legend" style={{ background: C.bar }} />Usual</span>
          <span>Bars show posts 1 to {data.length}, oldest first</span>
        </div>

        {viral.length > 0 && (
          <ul className="mt-4 grid gap-2">
            {viral.map((p) => {
              const bp = p.telemetry && byId[p.telemetry];
              const isOpen = open === p.id;
              return (
                <li key={p.id} className="rounded-xl border border-line bg-ink/60">
                  <button type="button" className="flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : p.id)}>
                    <span className="min-w-0">
                      <span className="block truncate text-[14px] font-semibold">{p.title}</span>
                      <span className="text-[12px] text-muted">{compact(p.views)} views{p.estimated ? " (estimated)" : ""}</span>
                    </span>
                    <span className="shrink-0 text-right">
                      <span className="block font-display text-[20px] font-bold text-emerald">{Math.round(p.score)}×</span>
                      <span className="text-[11px] text-muted">your usual</span>
                    </span>
                  </button>
                  {isOpen && (
                    <div className="border-t border-line px-3 pb-3 pt-2 text-[13px]">
                      {bp ? (
                        <>
                          <div className="text-[12px] font-semibold text-muted">What it did</div>
                          <p className="mt-1 italic">“{bp.hook}”</p>
                          <ul className="mt-2 grid gap-1 text-[13px]">
                            <li>First cut at <b className="font-data">{bp.t.first_cut.toFixed(1)}s</b>, then a new shot every <b className="font-data">{bp.t.avg_shot.toFixed(1)}s</b></li>
                            <li>First sound at <b className="font-data">{Math.round(bp.t.latency_ms)} ms</b>, talking at <b className="font-data">{Math.round(bp.t.wpm)}</b> words a minute</li>
                          </ul>
                        </>
                      ) : (
                        <p className="text-muted">To see what made it work, save the video and check it on the first tab.</p>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="panel p-4">
        <h2 className="flex items-center gap-2 font-display text-[16px] font-semibold"><Sparkles size={17} className="text-emerald" aria-hidden="true" />What viral videos in this niche do</h2>
        <p className="mt-1 text-[12.5px] text-muted">From {g.n} viral video{g.n === 1 ? "" : "s"}{g.creators.length ? ` by ${g.creators.length} creator${g.creators.length === 1 ? "" : "s"}` : ""}. Your video is checked against these on the first tab.</p>
        <ul className="mt-3 grid gap-2 sm:grid-cols-2">
          {[
            T.first_cut !== null && { Icon: Scissors, text: <>First cut by <b className="font-data">{T.first_cut.toFixed(1)}s</b></> },
            T.avg_shot && { Icon: Clock, text: <>A new shot about every <b className="font-data">{T.avg_shot.toFixed(1)}s</b></> },
            T.latency_ms !== null && { Icon: Volume2, text: <>First sound within <b className="font-data">{T.latency_ms < 1000 ? `${Math.round(T.latency_ms)} ms` : `${(T.latency_ms / 1000).toFixed(1)}s`}</b></> },
            T.wpm && { Icon: Zap, text: <>Talking at about <b className="font-data">{Math.round(T.wpm)}</b> words a minute</> },
          ].filter(Boolean).map((tip, i) => (
            <li key={i} className="flex items-center gap-2.5 rounded-xl border border-line bg-ink/60 px-3 py-2.5 text-[14px]"><tip.Icon size={16} className="shrink-0 text-emerald" aria-hidden="true" /><span>{tip.text}</span></li>
          ))}
        </ul>
      </section>

      <Disclosure id="how" title="How is this calculated?">
        <p className="text-[13px] leading-relaxed">
          "Your usual" at the top is your typical post (the middle value). To score each post fairly, we compare it with all your <i>other</i> posts: drop the single highest and lowest, then take the bigger of their average and middle value. A post's score is its views divided by that number, so a big hit can't raise its own bar.
        </p>
        <p className="mt-2 font-data text-[11.5px] text-muted">score = views ÷ max(trimmed mean, median, 1) of the other posts</p>
        <p className="mt-2 text-[12px] text-muted">If several posts went viral at once they lift each other's usual, so a second hit can score lower than you'd expect. Instagram views that are hidden are estimated as likes × 18.5.</p>
      </Disclosure>
    </div>
  );
}

// ---------------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------------
function App() {
  const saved = useMemo(loadState, []);
  const [tab, setTab] = useState(() => (location.hash === "#viral" ? "viral" : "check"));
  const [report, setReport] = useState(exampleAnalysis);
  const [posts, setPosts] = useState(() => (Array.isArray(saved.posts) && saved.posts.length >= 3 ? saved.posts : samplePosts()));
  const [isSample, setIsSample] = useState(saved.isSample !== false);
  const [threshold, setThreshold] = useState([5, 10, 20].includes(saved.threshold) ? saved.threshold : 10);
  const [platform, setPlatform] = useState(saved.platform === "instagram" ? "instagram" : "tiktok");
  const [mine, setMine] = useState(Array.isArray(saved.mine) ? saved.mine : []);

  useEffect(() => saveState({ posts, isSample, threshold, platform, mine }), [posts, isSample, threshold, platform, mine]);
  useEffect(() => {
    const onHash = () => setTab(location.hash === "#viral" ? "viral" : "check");
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  const go = (t) => { setTab(t); try { history.replaceState(null, "", t === "viral" ? "#viral" : "#check"); } catch (_) { /* sandboxed */ } };

  const { scored } = useMemo(() => scorePosts(posts, threshold, platform), [posts, threshold, platform]);
  const blueprints = useMemo(() => {
    const hits = scored.filter((p) => p.outlier && p.telemetry && SAMPLE_TELEMETRY[p.telemetry]).map((p) => ({ ...SAMPLE_TELEMETRY[p.telemetry], views: p.views, score: p.score }));
    return [...mine, ...hits, ...LIBRARY];
  }, [scored, mine]);
  const g = useMemo(() => golden(blueprints), [blueprints]);
  const addExample = (r) => setMine([{ id: `mine-${Date.now()}`, creator: "you", title: r.name, views: null, baseline: null, score: 10, velocity: null, example: false, hook: "", cuts: r.pacing.cuts, rms: r.audio.curve, t: r.telemetry }, ...mine]);

  return (
    <div className="mx-auto max-w-[760px]">
      <header className="appbar">
        <div className="flex items-center justify-between gap-3">
          <div className="font-display text-[20px] font-bold leading-none">Viral<span className="text-emerald">Check</span></div>
          <nav className="flex shrink-0 rounded-full border border-line bg-ink p-1" aria-label="Sections">
            {[{ id: "check", label: "My video" }, { id: "viral", label: "Viral posts" }].map(({ id, label }) => (
              <button key={id} type="button" onClick={() => go(id)} aria-current={tab === id ? "page" : undefined}
                className={`rounded-full px-3.5 py-1.5 text-[13px] font-semibold transition ${tab === id ? "bg-emerald text-ink" : "text-muted"}`}>{label}</button>
            ))}
          </nav>
        </div>
      </header>
      <main className="pb-10 pt-4">
        {tab === "check"
          ? <CheckVideo report={report} setReport={setReport} g={g} onAddExample={addExample} />
          : <FindViral posts={posts} setPosts={setPosts} threshold={threshold} setThreshold={setThreshold} platform={platform} setPlatform={setPlatform} isSample={isSample} setIsSample={setIsSample} blueprints={blueprints} g={g} />}
        <footer className="mt-6 flex items-start gap-2 text-[11.5px] leading-relaxed text-muted">
          <Info size={13} className="mt-0.5 shrink-0" aria-hidden="true" />
          <span>Your videos never leave your phone. Scores are a guide to what holds viewers, not a promise of views.</span>
        </footer>
      </main>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
