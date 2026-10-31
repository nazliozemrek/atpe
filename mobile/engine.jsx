/* ATPE engine — shared by every ATPE Mobile UI (ATPE.jsx, ATPE-Simple.jsx).
 *
 * Pure functions, no React: platform safe zones, in-browser frame and audio extraction,
 * hook / pacing / loop / swipe-risk scoring, the leave-one-out outlier formula, golden
 * niche targets, the draft delta, and the example data. build.mjs prepends this file to
 * each UI so both apps measure and score identically.
 */
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
