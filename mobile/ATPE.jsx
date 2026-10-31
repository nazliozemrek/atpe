/* ATPE Mobile — single-file React dashboard (no backend).
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
// Palette (chart marks need literal values; they match the CSS tokens)
// ---------------------------------------------------------------------------------
const C = {
  emerald: "#34f5a6", amber: "#ffb43a", risk: "#ff5c7a", sky: "#5cc8ff", violet: "#b49bff",
  grid: "#1f2733", axis: "#6f7c8f", muted: "#8b97a9", bar: "#3a4556", fg: "#e7ecf3", panel: "#121821",
};

// ---------------------------------------------------------------------------------
// Platform UI geometry (fractions of a 9:16 frame). Measured approximations of the
// current players; they shift with device and caption length.
// ---------------------------------------------------------------------------------
const ZONES = {
  tiktok: [
    { label: "Top tabs", x0: 0, y0: 0, x1: 1, y1: 0.085, kind: "header" },
    { label: "Action rail", x0: 0.855, y0: 0.355, x1: 1, y1: 0.865, kind: "ui" },
    { label: "Caption", x0: 0, y0: 0.765, x1: 0.8, y1: 0.915, kind: "caption" },
    { label: "Sound + nav", x0: 0, y0: 0.915, x1: 1, y1: 1, kind: "ticker" },
  ],
  reels: [
    { label: "Header", x0: 0, y0: 0, x1: 1, y1: 0.075, kind: "header" },
    { label: "Action rail", x0: 0.85, y0: 0.5, x1: 1, y1: 0.885, kind: "ui" },
    { label: "Caption", x0: 0, y0: 0.79, x1: 0.82, y1: 0.915, kind: "caption" },
    { label: "Audio + nav", x0: 0, y0: 0.915, x1: 1, y1: 1, kind: "ticker" },
  ],
};
const SAFE = { x0: 0, y0: 0.085, x1: 0.85, y1: 0.75 };
const ZONE_STYLE = {
  header: { border: C.sky, fill: "rgba(92,200,255,.16)" },
  ui: { border: C.risk, fill: "rgba(255,92,122,.18)" },
  caption: { border: C.amber, fill: "rgba(255,180,58,.16)" },
  ticker: { border: C.violet, fill: "rgba(180,155,255,.16)" },
};

// ---------------------------------------------------------------------------------
// Small numeric helpers
// ---------------------------------------------------------------------------------
const clip01 = (x) => Math.min(1, Math.max(0, x));
const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);
const median = (a) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const percentile = (a, p) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  const i = (s.length - 1) * p;
  const lo = Math.floor(i), hi = Math.ceil(i);
  return s[lo] + (s[hi] - s[lo]) * (i - lo);
};
const round = (x, n = 2) => (x === null || x === undefined || Number.isNaN(x) ? null : Math.round(x * 10 ** n) / 10 ** n);
const fmt = (x, n = 1) => (x === null || x === undefined || Number.isNaN(x) ? "—" : Number(x).toFixed(n));
const compact = (x) => (x === null || x === undefined ? "—" : new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(x));
const runs = (mask) => {
  const out = [];
  let start = -1;
  mask.forEach((m, i) => {
    if (m && start < 0) start = i;
    if (!m && start >= 0) { out.push([start, i]); start = -1; }
  });
  if (start >= 0) out.push([start, mask.length]);
  return out;
};
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function pearson(a, b) {
  const n = Math.min(a.length, b.length);
  if (n < 3) return null;
  const ma = mean(a.slice(0, n)), mb = mean(b.slice(0, n));
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) { const x = a[i] - ma, y = b[i] - mb; num += x * y; da += x * x; db += y * y; }
  return da < 1e-9 || db < 1e-9 ? null : num / Math.sqrt(da * db);
}

// ---------------------------------------------------------------------------------
// In-browser extraction: frames
// ---------------------------------------------------------------------------------
const AW = 72, AH = 128; // analysis raster (9:16)

function once(el, ok, ms = 8000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { cleanup(); reject(new Error(`Timed out waiting for ${ok}`)); }, ms);
    const onOk = () => { cleanup(); resolve(); };
    const onErr = () => { cleanup(); reject(new Error("This video can't be decoded by your browser.")); };
    function cleanup() { clearTimeout(t); el.removeEventListener(ok, onOk); el.removeEventListener("error", onErr); }
    el.addEventListener(ok, onOk);
    el.addEventListener("error", onErr);
  });
}

function seek(v, t) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; v.removeEventListener("seeked", finish); resolve(); } };
    v.addEventListener("seeked", finish);
    setTimeout(finish, 2500); // some mobile decoders drop a seeked event
    v.currentTime = t;
  });
}

function lumaOf(ctx) {
  const { data } = ctx.getImageData(0, 0, AW, AH);
  const L = new Float32Array(AW * AH);
  const hist = new Float32Array(16);
  let sum = 0;
  for (let i = 0, p = 0; i < L.length; i++, p += 4) {
    const y = 0.2126 * data[p] + 0.7152 * data[p + 1] + 0.0722 * data[p + 2];
    L[i] = y; sum += y; hist[Math.min(15, y >> 4)]++;
  }
  const m = sum / L.length;
  let v = 0;
  for (let i = 0; i < L.length; i++) v += (L[i] - m) ** 2;
  for (let i = 0; i < 16; i++) hist[i] /= L.length;
  return { L, hist, luma: m, std: Math.sqrt(v / L.length) };
}

const histDistance = (a, b) => { let d = 0; for (let i = 0; i < 16; i++) d += Math.abs(a[i] - b[i]); return d / 2; };
function frameSimilarity(a, b) {
  const ma = mean(a), mb = mean(b);
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < a.length; i++) { const x = a[i] - ma, y = b[i] - mb; num += x * y; da += x * x; db += y * y; }
  if (da < 1e-6 || db < 1e-6) return 1 - Math.min(1, Math.abs(ma - mb) / 64);
  return Math.max(0, num / Math.sqrt(da * db));
}

async function extractFrames(url, onProgress, signal) {
  const v = document.createElement("video");
  v.muted = true; v.playsInline = true; v.preload = "auto"; v.crossOrigin = "anonymous";
  v.setAttribute("playsinline", ""); v.setAttribute("muted", "");
  v.src = url;
  await once(v, "loadedmetadata");
  try { await v.play(); v.pause(); } catch (_) { /* decoding starts on seek instead */ }
  if (v.readyState < 2) { try { await once(v, "loadeddata", 4000); } catch (_) { /* continue */ } }
  const duration = v.duration;
  if (!Number.isFinite(duration) || duration <= 0) throw new Error("Couldn't read the video's length.");

  const canvas = document.createElement("canvas");
  canvas.width = AW; canvas.height = AH;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const vw = v.videoWidth || AW, vh = v.videoHeight || AH;
  // Same framing as the 9:16 player: letterbox into the analysis raster.
  const s = Math.min(AW / vw, AH / vh), dw = vw * s, dh = vh * s, dx = (AW - dw) / 2, dy = (AH - dh) / 2;

  const times = [];
  const headEnd = Math.min(1.7, duration);
  for (let t = 0.001; t < headEnd; t += 1 / 30) times.push(t);
  const step = Math.max(0.1, (duration - headEnd) / 360);
  for (let t = headEnd; t < duration - 0.02; t += step) times.push(t);
  if (times[times.length - 1] < duration - 0.06) times.push(duration - 0.04);

  const samples = [];
  let prev = null;
  for (let i = 0; i < times.length; i++) {
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    await seek(v, times[i]);
    ctx.fillStyle = "#000"; ctx.fillRect(0, 0, AW, AH);
    ctx.drawImage(v, dx, dy, dw, dh);
    const f = lumaOf(ctx);
    let diff = 0, hd = 0, dt = 1 / 30;
    if (prev) {
      for (let k = 0; k < f.L.length; k++) diff += Math.abs(f.L[k] - prev.L[k]);
      diff = diff / f.L.length / 255;
      hd = histDistance(f.hist, prev.hist);
      dt = Math.max(1 / 60, times[i] - prev.t);
    }
    // Motion as luma change per 1/30 s, so dense hook sampling and sparse body sampling compare.
    const motion = prev ? Math.min(1, diff / (dt * 30)) : 0;
    const sample = { t: times[i], luma: f.luma, std: f.std, diff, motion, hd, hist: f.hist, L: null };
    if (times[i] < 1.75 || times[i] > duration - 2.1) sample.L = f.L; // kept for hook + loop search
    samples.push(sample);
    prev = { L: f.L, hist: f.hist, t: times[i] };
    if (i % 4 === 0) onProgress(0.05 + 0.7 * (i / times.length), "Reading frames");
  }
  v.removeAttribute("src"); v.load();
  return { duration, width: vw, height: vh, samples };
}

// ---------------------------------------------------------------------------------
// In-browser extraction: audio
// ---------------------------------------------------------------------------------
async function extractAudio(file) {
  const buf = await file.arrayBuffer();
  const Ctx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (!Ctx) return { hasAudio: false, error: "Web Audio isn't available in this browser." };
  const ctx = new Ctx(1, 2, 22050);
  let audio;
  try {
    audio = await new Promise((resolve, reject) => {
      const p = ctx.decodeAudioData(buf, resolve, reject);
      if (p && p.then) p.then(resolve, reject);
    });
  } catch (_) {
    return { hasAudio: false, error: "No audio track could be decoded (silent clip, or a codec this browser can't read)." };
  }
  const sr = audio.sampleRate;
  const n = audio.length;
  const mono = new Float32Array(n);
  for (let c = 0; c < audio.numberOfChannels; c++) {
    const ch = audio.getChannelData(c);
    for (let i = 0; i < n; i++) mono[i] += ch[i] / audio.numberOfChannels;
  }
  const hop = Math.round(sr * 0.01), win = Math.round(sr * 0.03);
  const db = [];
  for (let start = 0; start + hop <= n; start += hop) {
    // Integer bounds: at 22.05 kHz, (win - hop) / 2 is 220.5 and fractional indexes read undefined.
    const a = Math.max(0, start - Math.floor((win - hop) / 2)), b = Math.min(n, a + win);
    let s = 0;
    for (let i = a; i < b; i++) s += mono[i] * mono[i];
    const rms = Math.sqrt(s / Math.max(1, b - a));
    db.push(Math.max(-90, 20 * Math.log10(Math.max(rms, 1e-10)) + 3.0103));
  }
  return { hasAudio: true, db, hop: 0.01, duration: n / sr };
}

function audioEvents(a) {
  if (!a.hasAudio || !a.db.length) return { firstSound: null, lastSound: null, onset: null, thr: -45 };
  const { db } = a;
  const peak = percentile(db, 0.995);
  const thr = Math.max(-45, peak - 35);
  const run = 3; // 30 ms sustained
  let firstSound = null, lastSound = null;
  for (let i = 0; i + run <= db.length; i++) if (db.slice(i, i + run).every((x) => x > thr)) { firstSound = i * a.hop; break; }
  for (let i = db.length - run; i >= 0; i--) if (db.slice(i, i + run).every((x) => x > thr)) { lastSound = (i + run) * a.hop; break; }
  // Transient: level clears the threshold and jumps >= 9 dB over the previous 50 ms.
  let onset = null;
  for (let i = 5; i < db.length; i++) {
    const before = Math.min(...db.slice(i - 5, i));
    if (db[i] > thr && db[i] - before >= 9) { onset = (i - 1) * a.hop; break; }
  }
  // A sound already loud at the very start has no "jump" to detect; it is a 0 ms hit.
  if (firstSound !== null && Math.max(...db.slice(Math.round(firstSound / a.hop), Math.round(firstSound / a.hop) + 6)) >= peak - 12) {
    onset = onset === null ? firstSound : Math.min(onset, firstSound);
  }
  return { firstSound, lastSound, onset, thr, peak };
}

// ---------------------------------------------------------------------------------
// Scoring (mirrors the desktop engine's weights and thresholds)
// ---------------------------------------------------------------------------------
const HOOK = 1.7;
const flag = (code, severity, message, at = null) => ({ code, severity, message, at });

function analyze(frames, audio, name) {
  const { samples, duration } = frames;
  const ev = audioEvents(audio);
  const dbAt = (a, b) => {
    if (!audio.hasAudio) return [];
    return audio.db.slice(Math.max(0, Math.floor(a / audio.hop)), Math.max(0, Math.ceil(b / audio.hop)));
  };

  // ---- cuts ---------------------------------------------------------------------
  const cuts = [];
  samples.forEach((s, i) => {
    if (i && s.hd > 0.42 && s.diff > 0.06 && (!cuts.length || s.t - cuts[cuts.length - 1] > 0.25)) cuts.push(s.t);
  });

  // ---- hook gate ----------------------------------------------------------------------
  const head = samples.filter((s) => s.t < HOOK);
  const f0 = samples[0];
  const moving = head.slice(1);
  const hookMotion = mean(moving.map((s) => s.motion));
  const early = mean(moving.filter((s) => s.t <= 0.5).map((s) => s.motion));
  const firstMotion = mean(moving.slice(0, 3).map((s) => s.motion));
  const hookCuts = cuts.filter((c) => c < HOOK);
  const credits = {
    motion: clip01((hookMotion - 0.003) / 0.032),
    early: clip01((early - 0.003) / 0.032),
    brightness: clip01((f0.luma - 15) / 45),
    detail: clip01(f0.std / 36),
    change: hookCuts.length ? Math.max(0.85, clip01(hookMotion / 0.035)) : clip01(hookMotion / 0.035),
  };
  const visual = 0.35 * credits.motion + 0.2 * credits.early + 0.15 * credits.brightness + 0.1 * credits.detail + 0.2 * credits.change;
  const flags = [];
  if (firstMotion < 0.003 && !cuts.some((c) => c < 0.15)) flags.push(flag("static", "high", "Frame 1 is static. Open on motion or a cut.", 0));
  if (f0.luma < 40) flags.push(flag("dark", "high", `Opening frame is dark (mean luma ${Math.round(f0.luma)}/255).`, 0));
  if (f0.std < 18) flags.push(flag("flat", "medium", `Opening frame has little detail (luma σ ${Math.round(f0.std)}).`, 0));
  if (hookMotion < 0.006 && !hookCuts.length) flags.push(flag("lowmotion", "high", "Almost no motion in the first 1.7s and no cut.", 0));

  let audioScore = 0, latencyMs = null, deadAirMs = null, hookVsBody = null, latencyCredit = 0, energyCredit = 0;
  if (audio.hasAudio) {
    latencyMs = ev.onset !== null ? ev.onset * 1000 : ev.firstSound !== null ? ev.firstSound * 1000 : null;
    deadAirMs = (ev.firstSound ?? duration) * 1000;
    latencyCredit = latencyMs === null ? 0 : latencyMs <= 150 ? 1 : clip01(1 - (latencyMs - 150) / 600);
    const body = audio.db.filter((x) => x > ev.thr);
    const hookDb = dbAt(ev.firstSound ?? HOOK, HOOK);
    if (body.length && hookDb.length) {
      hookVsBody = median(hookDb) - median(body);
      energyCredit = clip01(1 - Math.max(0, -hookVsBody - 3) / 9);
    }
    audioScore = 0.8 * latencyCredit + 0.2 * energyCredit;
    if (deadAirMs > 150) flags.push(flag("deadair", deadAirMs > 400 ? "high" : "medium", `${Math.round(deadAirMs)} ms of dead air before the first sound (limit 150 ms).`, 0));
    if (latencyMs === null) flags.push(flag("nohit", "high", "No vocal or high-energy audio hit detected.", 0));
    else if (latencyMs > 150) flags.push(flag("late", latencyMs > 400 ? "high" : "medium", `First audio hit at ${Math.round(latencyMs)} ms.`, latencyMs / 1000));
    if (hookVsBody !== null && hookVsBody < -6) flags.push(flag("quiet", "medium", `Hook is ${Math.abs(hookVsBody).toFixed(1)} dB quieter than the rest of the video.`, 0));
  } else {
    flags.push(flag("noaudio", "high", audio.error || "No audio track.", 0));
  }
  const hookScore = (100 * (40 * visual + 35 * audioScore)) / 75;

  // ---- pacing + stagnation ------------------------------------------------------------
  const bounds = [0, ...cuts, duration];
  const shots = bounds.slice(1).map((b, i) => b - bounds[i]);
  const nearCut = (t) => cuts.some((c) => Math.abs(c - t) <= 0.15);
  const still = samples.map((s, i) => i > 0 && s.motion < 0.006 && !nearCut(s.t));
  const stagnation = runs(still)
    .map(([i, j]) => ({ start: samples[i - 1]?.t ?? 0, end: j < samples.length ? samples[j].t : duration }))
    .filter((z) => z.end - z.start >= 2.5);
  const pacing = {
    cuts,
    cutCount: cuts.length,
    cpm: cuts.length / Math.max(duration / 60, 1e-6),
    avgShot: mean(shots),
    longestShot: Math.max(...shots),
    firstCut: cuts[0] ?? null,
    stagnation,
    stagnationSeconds: stagnation.reduce((s, z) => s + z.end - z.start, 0),
  };

  // ---- loop -------------------------------------------------------------------------
  const endT = duration;
  const avgHist = (list) => { const h = new Float32Array(16); list.forEach((s) => s.hist.forEach((v, i) => (h[i] += v / list.length))); return h; };
  const headW = samples.filter((s) => s.t < 0.5);
  const tailW = samples.filter((s) => s.t >= endT - 0.5);
  const tailSamples = samples.filter((s) => s.L);
  const last = tailSamples[tailSamples.length - 1];
  const histSim = 1 - histDistance(avgHist(headW.length ? headW : [f0]), avgHist(tailW.length ? tailW : [last]));
  const frameSim = frameSimilarity(f0.L, last.L);
  const hm = mean(headW.slice(1).map((s) => s.motion)) + 0.01, tm = mean(tailW.map((s) => s.motion)) + 0.01;
  const motionMatch = Math.min(hm, tm) / Math.max(hm, tm);
  let envCorr = null, levelMatch = null, boundary = null;
  const loopEnd = audio.hasAudio ? Math.min(endT, audio.duration) : endT;
  if (audio.hasAudio) {
    const a = dbAt(0, 0.5), b = dbAt(loopEnd - 0.5, loopEnd);
    const c = pearson(a, b);
    envCorr = c === null ? 0.5 : (c + 1) / 2;
    levelMatch = a.length && b.length ? clip01(1 - Math.abs(mean(a) - mean(b)) / 12) : 0;
    const ae = dbAt(0, 0.05), be = dbAt(loopEnd - 0.05, loopEnd);
    boundary = ae.length && be.length ? clip01(1 - Math.abs(mean(ae) - mean(be)) / 9) : 0;
  }
  const combine = (hs, fs, bd) =>
    envCorr === null
      ? 100 * (0.45 * hs + 0.35 * fs + 0.2 * motionMatch)
      : 100 * (0.3 * hs + 0.2 * fs + 0.1 * motionMatch + 0.15 * envCorr + 0.1 * levelMatch + 0.15 * bd);
  const loopScore = combine(histSim, frameSim, boundary);

  const headTrim = audio.hasAudio && ev.firstSound !== null && ev.firstSound > 0.15 ? Math.max(0, ev.firstSound - 0.04) : 0;
  const ref = head.find((s) => s.t >= headTrim - 1e-6 && s.L) || f0;
  const refLevel = audio.hasAudio ? mean(dbAt(headTrim, headTrim + 0.05)) : 0;
  let silenceEnd = loopEnd;
  if (audio.hasAudio && ev.lastSound !== null && loopEnd - ev.lastSound > 0.15) silenceEnd = Math.min(loopEnd, ev.lastSound + 0.08);
  const evaluate = (s, te) => {
    const vis = 0.55 * frameSimilarity(s.L, ref.L) + 0.45 * (1 - histDistance(s.hist, ref.hist));
    const lvl = dbAt(te - 0.05, te);
    const bd = audio.hasAudio ? clip01(1 - Math.abs((lvl.length ? mean(lvl) : -90) - refLevel) / 9) : 1;
    return { te, vis, bd, s };
  };
  const base = evaluate(last, endT);
  base.score = 0.7 * base.vis + 0.3 * base.bd;
  let best = null;
  tailSamples.filter((s) => s.t >= silenceEnd - 1.5 && s.t <= silenceEnd).forEach((s) => {
    const e = evaluate(s, s.t + 0.04);
    e.score = 0.7 * e.vis + 0.3 * e.bd - (0.04 * (endT - e.te)) / 1.5;
    if (!best || e.score > best.score) best = e;
  });
  let tailTrim = 0, reason = "The ending already matches the opening best; no tail trim.", chosen = base;
  if (silenceEnd < loopEnd - 1e-6) {
    chosen = best || base;
    tailTrim = endT - (best ? best.te : silenceEnd);
    reason = `Trailing silence of ${Math.round((loopEnd - ev.lastSound) * 1000)} ms after the last sound.`;
  } else if (best && best.score > base.score + 0.03) {
    chosen = best;
    tailTrim = endT - best.te;
    reason = "An earlier end frame matches the opening frame more closely.";
  }
  const projected =
    chosen === base && !headTrim
      ? loopScore
      : combine(Math.max(histSim, 1 - histDistance(chosen.s.hist, ref.hist)), Math.max(frameSim, frameSimilarity(chosen.s.L, ref.L)), audio.hasAudio ? chosen.bd : null);
  const loop = {
    score: loopScore, projected,
    trimStartMs: Math.round(headTrim * 1000), trimEndMs: Math.round(tailTrim * 1000),
    newDuration: endT - headTrim - tailTrim, reason,
    parts: { histogram: histSim, boundaryFrame: frameSim, motion: motionMatch, envelope: envCorr, level: levelMatch, audioBoundary: boundary },
  };

  // ---- timeline + swipe-risk zones --------------------------------------------------
  const bins = [];
  for (let a = 0; a < duration; a += 0.25) {
    const b = Math.min(duration, a + 0.25);
    const inBin = samples.filter((s) => s.t >= a && s.t < b);
    const near = inBin.length ? inBin : [samples.reduce((p, s) => (Math.abs(s.t - a) < Math.abs(p.t - a) ? s : p), samples[0])];
    const m = clip01(mean(near.map((s) => s.motion)) / 0.04);
    const lv = dbAt(a, b);
    const e = clip01(((lv.length ? mean(lv) : -90) + 60) / 60);
    const stag = stagnation.some((z) => z.start < b && z.end > a);
    const cut = cuts.some((c) => c >= a && c < b);
    let risk = 0.35 * (1 - m) + 0.2 * (1 - e) + 0.3 * (stag ? 1 : 0);
    if (cut) risk *= 0.6;
    if (a < HOOK) risk = Math.min(1, risk * 1.15);
    bins.push({ t: round(a, 2), motion: round(m * 100, 1), energy: round(e * 100, 1), risk: round(risk * 100, 1) });
  }
  const zones = [];
  runs(bins.map((b) => b.risk >= 55)).forEach(([i, j]) => {
    const start = bins[i].t, end = j < bins.length ? bins[j].t : duration;
    if (end - start >= 0.75) zones.push({ start, end });
  });
  stagnation.forEach((z) => zones.push({ start: z.start, end: z.end }));
  zones.sort((x, y) => x.start - y.start);
  const merged = [];
  zones.forEach((z) => {
    const p = merged[merged.length - 1];
    if (p && z.start <= p.end) p.end = Math.max(p.end, z.end);
    else merged.push({ ...z });
  });

  // ---- recommendations ----------------------------------------------------------------
  const recs = [...flags];
  stagnation.forEach((z) => recs.push(flag("stag", "high", `Stagnation ${z.start.toFixed(1)}–${z.end.toFixed(1)}s (${(z.end - z.start).toFixed(1)}s): add a cut, zoom or B-roll.`, z.start)));
  if (loop.trimStartMs || loop.trimEndMs)
    recs.push(flag("loop", "medium", `Trim ${loop.trimStartMs} ms from the start and ${loop.trimEndMs} ms from the end (loop ${Math.round(loopScore)} → ${Math.round(projected)}). ${reason}`));
  const aspect = frames.width / frames.height;
  if (Math.abs(aspect - 9 / 16) > 0.02) recs.push(flag("aspect", "high", `Video is ${frames.width}×${frames.height}, not 9:16; it will be letterboxed or cropped.`));
  const order = { high: 0, medium: 1, low: 2 };
  recs.sort((x, y) => order[x.severity] - order[y.severity] || (x.at ?? 1e9) - (y.at ?? 1e9));

  const retention = Math.max(0, 100 - (merged.reduce((s, z) => s + z.end - z.start, 0) / duration) * 100);
  return {
    name, example: false, duration, width: frames.width, height: frames.height,
    hook: { score: hookScore, visual: visual * 100, audio: audioScore * 100, credits, hookMotion, latencyMs, deadAirMs, hookVsBody, firstLuma: f0.luma, hookCuts },
    pacing, loop, bins, zones: merged, recs, retention,
    audio: { hasAudio: audio.hasAudio, curve: audio.hasAudio ? curve100(audio) : [] },
    telemetry: {
      duration, first_cut: pacing.firstCut, cpm: pacing.cpm, avg_shot: pacing.avgShot, max_gap: pacing.longestShot,
      latency_ms: latencyMs, hook_motion: clip01(hookMotion / 0.035) * 100, wpm: null,
    },
  };
}

function curve100(audio) {
  const out = [];
  for (let i = 0; i * 10 < audio.db.length; i++) {
    const seg = audio.db.slice(i * 10, i * 10 + 10);
    // power-average the 10 ms windows into one 100 ms value
    const p = mean(seg.map((d) => 10 ** (d / 10)));
    out.push({ t: round(i * 0.1, 1), db: round(Math.max(-90, 10 * Math.log10(Math.max(p, 1e-12))), 1) });
  }
  return out;
}

// ---------------------------------------------------------------------------------
// Leave-one-out trimmed baseline (Stage 2)
// ---------------------------------------------------------------------------------
const IG_VIEWS_PER_LIKE = 18.5;

function trimmedStats(values) {
  if (!values.length) return { tm: 1, med: 1, base: 1 };
  const pool = [...values].sort((a, b) => a - b);
  const trimmed = pool.length >= 5 ? pool.slice(1, -1) : pool;
  const tm = mean(trimmed);
  const med = median(pool);
  return { tm, med, base: Math.max(tm, med, 1) };
}

function scorePosts(posts, threshold, platform) {
  const withViews = posts.map((p) => {
    let views = p.views === "" || p.views === null || p.views === undefined ? null : Number(p.views);
    let estimated = false;
    if (platform === "instagram" && !views && Number(p.likes) > 0) { views = Math.round(Number(p.likes) * IG_VIEWS_PER_LIKE); estimated = true; }
    return { ...p, views, estimated };
  });
  const pool = withViews.map((p) => p.views).filter((v) => v !== null && Number.isFinite(v));
  const scored = withViews.map((p, i) => {
    if (p.views === null || !Number.isFinite(p.views)) return { ...p, baseline: null, score: null, velocity: null, outlier: false };
    const others = withViews.filter((q, j) => j !== i && q.views !== null && Number.isFinite(q.views)).map((q) => q.views);
    const { tm, med, base } = trimmedStats(others);
    const likes = Number(p.likes) || 0, comments = Number(p.comments) || 0, reposts = Number(p.reposts) || 0;
    const hasEngagement = [p.likes, p.comments, p.reposts].some((x) => x !== "" && x !== null && x !== undefined);
    const score = round(p.views / base, 2);
    return {
      ...p, trimmedMean: tm, median: med, baseline: base, score,
      velocity: hasEngagement ? round(((likes + comments * 3 + reposts * 5) / Math.max(p.views, 1)) * 1000, 2) : null,
      outlier: score >= threshold,
    };
  });
  return { scored, creatorBaseline: trimmedStats(pool).base };
}

// ---------------------------------------------------------------------------------
// Golden targets + draft delta
// ---------------------------------------------------------------------------------
const TARGETS = [
  { key: "cpm", label: "Cuts / minute", unit: "/min", stat: "median", prefix: "≥", digits: 1 },
  { key: "avg_shot", label: "Avg shot length", unit: "s", stat: "median", prefix: "≤", digits: 2 },
  { key: "first_cut", label: "First cut before", unit: "s", stat: "median", prefix: "≤", digits: 2 },
  { key: "latency_ms", label: "Max audio latency", unit: "ms", stat: "p75", prefix: "≤", digits: 0 },
  { key: "hook_motion", label: "Hook motion", unit: "/100", stat: "median", prefix: "≥", digits: 0 },
  { key: "wpm", label: "Speaking pace", unit: "wpm", stat: "median", prefix: "≈", digits: 0 },
];

function golden(blueprints) {
  const targets = {}, spread = {};
  TARGETS.forEach(({ key, stat }) => {
    const vals = blueprints.map((b) => b.t[key]).filter((v) => v !== null && v !== undefined);
    targets[key] = vals.length ? (stat === "p75" ? percentile(vals, 0.75) : median(vals)) : null;
    spread[key] = { p25: vals.length ? percentile(vals, 0.25) : null, p75: vals.length ? percentile(vals, 0.75) : null, n: vals.length };
  });
  return { n: blueprints.length, targets, spread, creators: [...new Set(blueprints.map((b) => b.creator))] };
}

function nicheDelta(t, g) {
  if (!g.n) return null;
  const T = g.targets, rows = [];
  const add = (label, draft, target, dir, unit, closeness, ok, message) => rows.push({ label, draft, target, dir, unit, closeness: ok ? 1 : closeness, ok, message });
  if (T.first_cut !== null) {
    if (t.first_cut === null) add("First cut", null, T.first_cut, "≤", "s", 0, false, `No cuts at all; 10x outliers cut by ${T.first_cut.toFixed(1)}s.`);
    else {
      const ok = t.first_cut <= T.first_cut;
      add("First cut", t.first_cut, T.first_cut, "≤", "s", T.first_cut / t.first_cut, ok,
        ok ? `First cut at ${t.first_cut.toFixed(1)}s, inside the target.` : `Your first cut is at ${t.first_cut.toFixed(1)}s; 10x outliers cut at ${T.first_cut.toFixed(1)}s — trim ${(t.first_cut - T.first_cut).toFixed(1)}s from shot 1.`);
    }
  }
  if (T.cpm) {
    const ok = t.cpm >= T.cpm * 0.9, need = Math.max(0, Math.ceil(((T.cpm - t.cpm) * t.duration) / 60));
    add("Cuts per minute", t.cpm, T.cpm, "≥", "/min", Math.min(1, t.cpm / T.cpm), ok, ok ? "Cut pace matches the outliers." : `You cut ${Math.round(t.cpm)}×/min; outliers cut ${Math.round(T.cpm)}×/min — add ~${need} cut${need === 1 ? "" : "s"}.`);
  }
  if (T.avg_shot) {
    const ok = t.avg_shot <= T.avg_shot * 1.1;
    add("Avg shot length", t.avg_shot, T.avg_shot, "≤", "s", Math.min(1, T.avg_shot / t.avg_shot), ok, ok ? "Shot length on target." : `Shots average ${t.avg_shot.toFixed(1)}s vs ${T.avg_shot.toFixed(1)}s — split your longest shot (${t.max_gap.toFixed(1)}s) first.`);
  }
  if (T.latency_ms !== null) {
    if (t.latency_ms === null) add("Audio onset", null, T.latency_ms, "≤", "ms", 0, false, `No audio hit; outliers hit within ${Math.round(T.latency_ms)} ms.`);
    else {
      const ok = t.latency_ms <= T.latency_ms;
      add("Audio onset", t.latency_ms, T.latency_ms, "≤", "ms", clip01(1 - (t.latency_ms - T.latency_ms) / 600), ok,
        ok ? "First audio hit lands in time." : `First audio hit at ${Math.round(t.latency_ms)} ms; outliers hit by ${Math.round(T.latency_ms)} ms — trim ${Math.round(t.latency_ms - T.latency_ms)} ms of lead-in.`);
    }
  }
  if (T.hook_motion) {
    const ok = t.hook_motion >= T.hook_motion * 0.85;
    add("Hook motion", t.hook_motion, T.hook_motion, "≥", "/100", Math.min(1, t.hook_motion / T.hook_motion), ok, ok ? "Hook motion matches the outliers." : `Hook motion ${Math.round(t.hook_motion)}/100 vs ${Math.round(T.hook_motion)}/100 — open on movement, a push-in or a cut.`);
  }
  const score = mean(rows.map((r) => r.closeness)) * 100;
  return { rows, score, n: g.n };
}

// ---------------------------------------------------------------------------------
// Example data (clearly marked in the UI)
// ---------------------------------------------------------------------------------
function rmsCurve(seed, seconds, leadIn = 0) {
  const r = rng(seed), out = [];
  for (let i = 0; i < seconds * 10; i++) {
    const t = i / 10;
    const speech = t < leadIn ? -90 : -24 + 7 * Math.sin(t * 5.3 + r()) + (r() - 0.5) * 10;
    out.push({ t: round(t, 1), db: round(Math.max(-90, Math.min(-6, speech)), 1) });
  }
  return out;
}
function cutTrack(seed, seconds, first, avg) {
  const r = rng(seed), cuts = [];
  for (let t = first; t < seconds - 0.4; t += avg * (0.6 + r() * 0.8)) cuts.push(round(t, 2));
  return cuts;
}
function blueprint(id, creator, title, views, baseline, seconds, first, avg, latency, motion, wpm, hook, seed) {
  const cuts = cutTrack(seed, seconds, first, avg);
  return {
    id, creator, title, views, baseline, score: round(views / baseline, 2),
    velocity: round(60 + rng(seed + 1)() * 140, 1), example: true, hook, cuts, rms: rmsCurve(seed + 2, seconds, latency / 1000),
    t: { duration: seconds, first_cut: cuts[0] ?? null, cpm: (cuts.length / seconds) * 60, avg_shot: seconds / (cuts.length + 1),
      max_gap: avg * 1.4, latency_ms: latency, hook_motion: motion, wpm },
  };
}

const LIBRARY = [
  blueprint("bp-nightowl-1", "nightowl.lab", "The 4-7-8 trick nobody does right", 2_400_000, 61_000, 31, 0.7, 1.45, 40, 71, 188, "Stop counting sheep. Do this instead, it takes", 11),
  blueprint("bp-nightowl-2", "nightowl.lab", "Why you wake up at 3am (it's not stress)", 1_150_000, 58_000, 27, 1.1, 1.7, 0, 64, 176, "If you wake up at 3am every single night", 12),
  blueprint("bp-restwell-1", "restwell", "I slept in a 16°C room for 30 days", 880_000, 24_500, 44, 0.9, 1.9, 90, 58, 171, "Thirty days, sixteen degrees, here's my data", 13),
  blueprint("bp-circadian-1", "dr.circadian", "Morning light: the 10-minute rule", 640_000, 17_800, 36, 1.3, 2.05, 120, 49, 166, "Ten minutes of morning light does more than", 14),
  blueprint("bp-circadian-2", "dr.circadian", "Melatonin dose: you're taking 10x too much", 1_900_000, 31_000, 29, 0.6, 1.35, 0, 77, 194, "You're probably taking ten times too much", 15),
];

const SAMPLE_TELEMETRY = {
  "sd-hit-1": blueprint("sd-hit-1", "sleepdoc", "How I fell asleep in 2 minutes", 121_000, 3100, 34, 0.8, 1.6, 30, 68, 182, "I fell asleep in two minutes with this", 21),
  "sd-hit-2": blueprint("sd-hit-2", "sleepdoc", "Morning sunlight explained", 48_200, 3100, 41, 1.2, 1.85, 110, 55, 172, "Morning sunlight isn't about waking up, it's", 22),
};

function samplePosts() {
  const r = rng(4);
  const titles = ["Why you wake up at 3am", "Magnesium before bed?", "My night routine", "Sleep myths pt 2", "Cold room trick", "What I eat before bed",
    "Mouth taping test", "Blue light glasses honest review", "How I fell asleep in 2 minutes", "Weighted blanket 30 days", "Sleep tracker accuracy",
    "Melatonin dose mistake", "Napping rules", "Coffee cutoff time", "Morning sunlight explained", "Sleep anxiety tip", "Bedtime stretch", "Alarm hack",
    "Room temperature test", "Dream journaling"];
  return titles.map((title, i) => {
    let views = Math.round(1900 + r() * 1300);
    let telemetry = null;
    if (i === 8) { views = 121_000; telemetry = "sd-hit-1"; }
    if (i === 14) { views = 48_200; telemetry = "sd-hit-2"; }
    if (i === 11) views = 14_000;
    return {
      id: `p${i}`, title, ts: 1_758_000_000 + i * 2 * 86400, views,
      likes: Math.round(views * (0.04 + r() * 0.08)), comments: Math.round(views * (0.002 + r() * 0.008)), reposts: Math.round(views * (0.001 + r() * 0.02)),
      telemetry,
    };
  });
}

function exampleAnalysis() {
  const r = rng(7);
  const duration = 18.4, bins = [], cuts = [3.0, 5.6, 7.9, 11.2, 14.8];
  for (let a = 0; a < duration; a += 0.25) {
    const cut = cuts.some((c) => c >= a && c < a + 0.25);
    const m = a < 2.9 ? 4 + r() * 4 : cut ? 92 : 28 + r() * 30;
    const e = a < 0.55 ? 0 : 42 + 16 * Math.sin(a * 4.1) + r() * 10;
    const stag = a < 2.9;
    let risk = 0.35 * (1 - m / 100) + 0.2 * (1 - e / 100) + (stag ? 0.3 : 0);
    if (cut) risk *= 0.6;
    if (a < HOOK) risk = Math.min(1, risk * 1.15);
    bins.push({ t: round(a, 2), motion: round(m, 1), energy: round(Math.max(0, e), 1), risk: round(risk * 100, 1) });
  }
  const telemetry = { duration, first_cut: 3.0, cpm: (cuts.length / duration) * 60, avg_shot: duration / 6, max_gap: 3.6, latency_ms: 560, hook_motion: 9, wpm: null };
  return {
    name: "example-draft.mp4", example: true, duration, width: 1080, height: 1920,
    hook: { score: 31, visual: 12, audio: 33, hookMotion: 0.003, latencyMs: 560, deadAirMs: 555, hookVsBody: -1.2, firstLuma: 24, hookCuts: [] },
    pacing: { cuts, cutCount: 5, cpm: telemetry.cpm, avgShot: telemetry.avg_shot, longestShot: 3.6, firstCut: 3.0, stagnation: [{ start: 0, end: 2.9 }], stagnationSeconds: 2.9 },
    loop: { score: 41, projected: 63, trimStartMs: 515, trimEndMs: 380, newDuration: 17.5, reason: "Trailing silence of 460 ms after the last sound." },
    bins, zones: [{ start: 0, end: 3.0 }], retention: 84,
    recs: [
      flag("static", "high", "Frame 1 is static. Open on motion or a cut.", 0),
      flag("dark", "high", "Opening frame is dark (mean luma 24/255).", 0),
      flag("deadair", "high", "555 ms of dead air before the first sound (limit 150 ms).", 0),
      flag("stag", "high", "Stagnation 0.0–2.9s (2.9s): add a cut, zoom or B-roll.", 0),
      flag("late", "high", "First audio hit at 560 ms.", 0.56),
      flag("loop", "medium", "Trim 515 ms from the start and 380 ms from the end (loop 41 → 63). Trailing silence of 460 ms after the last sound."),
    ],
    audio: { hasAudio: true, curve: rmsCurve(9, duration, 0.55) },
    telemetry,
  };
}

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
