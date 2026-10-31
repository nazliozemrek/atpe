"""MODULE 1 — Pre-Flight Video Telemetry Auditor.

One call, `audit(path)`, runs the full multimodal pass and returns a JSON report:

  hook      1.7 s Hook Survival Score (visual delta, audio onset latency, OCR hook)
  pacing    cuts, motion shifts, stagnation zones, WPM and pause gaps
  loop      Seamless Loop Coefficient + millisecond trim recommendations
  timeline  0.25 s bins of motion velocity, audio energy and swipe risk (for charts)
  swipe_risk_zones, recommendations, transcript, ocr, media

Pipeline cost is dominated by Farneback flow (one pass, ~15 samples/s at 270 px wide)
and Whisper; a 30 s 1080p clip audits in roughly 20–60 s on a laptop CPU.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any, Literal

import numpy as np

from config import CONFIG, AnalysisConfig
from services import safe_zones
from services.media import MediaInfo, load_audio, probe
from services.signals import (
    FrameScan,
    ProgressFn,
    clip01,
    detect_cuts,
    gray_similarity,
    hist_similarity,
    ocr_frame,
    pearson,
    resample,
    rms_db,
    runs,
    scan_frames,
    sound_bounds,
    sound_threshold,
    strong_onsets,
    transcribe,
)
from services.utils import r, to_jsonable


def _noop(_p: float, _s: str) -> None:
    return None


# ----------------------------------------------------------------------------------
# Entry point
# ----------------------------------------------------------------------------------

def audit(
    path: str | Path,
    progress: ProgressFn = _noop,
    run_ocr: bool = True,
    run_asr: bool = True,
    cfg: AnalysisConfig = CONFIG,
    golden_targets: dict[str, Any] | Literal["auto"] | None = "auto",
    niche: str | None = None,
) -> dict[str, Any]:
    """`golden_targets="auto"` grades the draft against the 10x+ blueprints stored in
    viral_blueprints (filtered by `niche` when given); pass a dict to use specific
    targets, or None to skip the niche comparison (the decompiler does, for references)."""
    path = str(path)
    progress(0.01, "Probing container")
    info = probe(path)

    still_times = tuple(t for t in cfg.ocr_times_s if t < info.duration_s) if run_ocr else ()
    scan = scan_frames(path, info, cfg, still_times=still_times, progress=progress, progress_span=(0.02, 0.45))
    duration = scan.duration_s

    progress(0.47, "Detecting cuts")
    cuts = [c for c in detect_cuts(path, cfg) if c < duration]

    progress(0.56, "Analyzing audio")
    sr = cfg.audio_sr
    audio = load_audio(path, sr) if info.has_audio else np.zeros(0, dtype=np.float32)
    t_db, db = rms_db(audio, sr)
    onsets = strong_onsets(audio, sr, cfg)
    first_sound, last_sound = sound_bounds(t_db, db, cfg)

    # A model that can't load (no network for the first download, missing weights)
    # degrades that signal and is reported, instead of failing the whole audit.
    warnings: list[dict] = []
    transcript: dict[str, Any] = {"language": None, "text": "", "segments": [], "words": []}
    asr_ran = False
    if run_asr and audio.size:
        progress(0.62, "Transcribing (word timestamps)")
        try:
            transcript = transcribe(load_audio(path, cfg.whisper_sr))
            asr_ran = True
        except Exception as exc:  # noqa: BLE001
            warnings.append({"code": "asr_unavailable", "message": f"Transcription skipped: {type(exc).__name__}: {exc}"})

    ocr: dict[float, list[dict]] = {}
    ocr_ran = False
    if still_times:
        progress(0.86, "Reading on-screen text")
        try:
            ocr = {t: ocr_frame(scan.stills[t]) for t in still_times if t in scan.stills}
            ocr_ran = True
        except Exception as exc:  # noqa: BLE001
            warnings.append({"code": "ocr_unavailable", "message": f"On-screen text check skipped: {type(exc).__name__}: {exc}"})

    niche_info: dict[str, Any] | None = None
    if golden_targets is not None:
        try:
            from services import outlier_decompiler as od

            golden = od.golden_targets(niche=niche) if golden_targets == "auto" else golden_targets
            if golden.get("sample_size"):
                progress(0.9, "Measuring against 10x niche outliers")
                draft_tel = od.extract_telemetry(path, transcript=transcript if asr_ran else None, run_asr=False)
                niche_info = od.niche_delta(draft_tel, golden)
            else:
                niche_info = od.niche_delta({}, golden)
        except Exception as exc:  # noqa: BLE001
            warnings.append({"code": "niche_benchmark_unavailable",
                             "message": f"Niche benchmark skipped: {type(exc).__name__}: {exc}"})

    progress(0.94, "Scoring")
    hook = _hook(scan, info, cuts, t_db, db, onsets, first_sound, transcript, ocr if ocr_ran else None, cfg)
    pacing = _pacing(scan, cuts, transcript, duration, cfg)
    loop = _loop(scan, audio, sr, t_db, db, first_sound, last_sound, transcript, duration, cfg)
    timeline, zones = _timeline(scan, cuts, t_db, db, transcript, pacing, duration, cfg)
    recs = _recommendations(hook, pacing, loop, zones, info)
    if niche_info and niche_info.get("available"):
        recs = [{"severity": "medium", "area": "niche", "at_s": None, "message": m} for m in niche_info["messages"]] + recs

    progress(1.0, "Done")
    return to_jsonable({
        "media": info.as_dict() | {"analyzed_duration_s": r(duration), "frames_decoded": scan.frames_read},
        "hook": hook,
        "pacing": pacing,
        "loop": loop,
        "timeline": timeline,
        "swipe_risk_zones": zones,
        "recommendations": recs,
        "transcript": transcript,
        "ocr": [{"t": t, "detections": d} for t, d in sorted(ocr.items())],
        "analysis": {"asr": asr_ran, "ocr": ocr_ran, "warnings": warnings},
        "niche_delta": niche_info,
        "config": {
            "hook_window_s": cfg.hook_window_s,
            "stagnation_s": cfg.stagnation_s,
            "pause_gap_s": cfg.pause_gap_s,
            "timeline_bin_s": cfg.timeline_bin_s,
            "safe_zone": safe_zones.AUDIT_SAFE_ZONE.as_dict(),
        },
    })


# ----------------------------------------------------------------------------------
# 1. Hook survival (0.0 – 1.7 s)
# ----------------------------------------------------------------------------------

def _flag(code: str, severity: str, message: str, at_s: float | None = None) -> dict:
    return {"code": code, "severity": severity, "message": message, "at_s": r(at_s)}


def _hook(
    scan: FrameScan,
    info: MediaInfo,
    cuts: list[float],
    t_db: np.ndarray,
    db: np.ndarray,
    onsets: list[float],
    first_sound: float | None,
    transcript: dict,
    ocr: dict[float, list[dict]] | None,
    cfg: AnalysisConfig,
) -> dict:
    flags: list[dict] = []
    head = scan.head
    f0 = head[0]
    moving = head[1:]
    flows = np.array([h.flow_px_s for h in moving]) if moving else np.zeros(1)
    diffs = np.array([h.frame_diff for h in moving]) if moving else np.zeros(1)
    early = np.array([h.flow_px_s for h in moving if h.t <= 0.5]) if moving else np.zeros(1)
    first_flow = float(np.mean(flows[:3])) if flows.size else 0.0
    first_diff = float(np.mean(diffs[:3])) if diffs.size else 0.0
    motion_mean = float(np.mean(flows))
    motion_early = float(np.mean(early)) if early.size else 0.0
    mean_diff = float(np.mean(diffs))
    luma_series = np.array([h.luma_mean for h in head])
    hook_cuts = [c for c in cuts if c < cfg.hook_window_s]

    # ---- visual delta --------------------------------------------------------------
    span = cfg.strong_flow_px_s - cfg.static_flow_px_s
    motion_credit = clip01((motion_mean - cfg.static_flow_px_s) / span)
    early_credit = clip01((motion_early - cfg.static_flow_px_s) / span)
    bright_credit = clip01((f0.luma_mean - 15.0) / (cfg.dark_luma * 1.5 - 15.0))
    detail_credit = clip01(f0.luma_std / (cfg.flat_luma_std * 2.0))
    change_credit = clip01(mean_diff / 0.035)
    if hook_cuts:
        change_credit = max(change_credit, 0.85)
    visual = (
        0.35 * motion_credit + 0.20 * early_credit + 0.15 * bright_credit
        + 0.10 * detail_credit + 0.20 * change_credit
    )

    if first_flow < cfg.static_flow_px_s and first_diff < 0.004 and not any(c < 0.15 for c in cuts):
        flags.append(_flag("static_first_frame", "high",
                           f"Frame 1 is static (flow {first_flow:.1f} px/s). Open on motion or a cut.", 0.0))
    if f0.luma_mean < cfg.dark_luma:
        flags.append(_flag("dark_first_frame", "high",
                           f"Opening frame is dark (mean luma {f0.luma_mean:.0f}/255).", 0.0))
    if f0.luma_std < cfg.flat_luma_std:
        flags.append(_flag("flat_first_frame", "medium",
                           f"Opening frame has little detail (luma σ {f0.luma_std:.0f}).", 0.0))
    if motion_mean < cfg.static_flow_px_s * 2 and not hook_cuts:
        flags.append(_flag("low_motion_hook", "high",
                           f"Almost no motion in the first {cfg.hook_window_s}s and no cut.", 0.0))

    # ---- audio onset latency ------------------------------------------------------------
    words = transcript.get("words") or []
    first_word = float(words[0]["start"]) if words else None
    first_onset = onsets[0] if onsets else None
    has_audio = db.size > 0
    latency_ms: float | None = None
    dead_air_ms: float | None = None
    energy_delta_db: float | None = None
    if has_audio:
        candidates = [x for x in (first_word, first_onset) if x is not None]
        # Onset detection can't fire on the very first frame, so a sound that is already
        # loud when it starts (within 12 dB of the file's peak) counts as the first hit.
        if first_sound is not None:
            start_lvl = db[(t_db >= first_sound) & (t_db <= first_sound + 0.06)]
            if start_lvl.size and float(start_lvl.max()) >= float(np.percentile(db, 99.5)) - 12.0:
                candidates.append(first_sound)
        event = min(candidates) if candidates else first_sound
        latency_ms = event * 1000.0 if event is not None else None
        dead_air_ms = (first_sound if first_sound is not None else scan.duration_s) * 1000.0
        if latency_ms is None:
            latency_credit = 0.0
        elif latency_ms <= cfg.dead_air_ms:
            latency_credit = 1.0
        else:
            latency_credit = clip01(1.0 - (latency_ms - cfg.dead_air_ms) / (cfg.dead_air_zero_ms - cfg.dead_air_ms))

        thr = sound_threshold(db, cfg)
        body = db[db > thr]
        # Level of the hook once sound starts; the silent lead-in is already scored as dead air.
        hook_start = first_sound if first_sound is not None else cfg.hook_window_s
        hook_db = db[(t_db >= hook_start) & (t_db < cfg.hook_window_s)]
        if body.size and hook_db.size:
            energy_delta_db = float(np.median(hook_db) - np.median(body))
            energy_credit = clip01(1.0 - max(0.0, -energy_delta_db - 3.0) / 9.0)
        else:
            energy_credit = 0.0
        audio_score = 0.8 * latency_credit + 0.2 * energy_credit

        if dead_air_ms > cfg.dead_air_ms:
            flags.append(_flag("dead_air", "high" if dead_air_ms > 400 else "medium",
                               f"{dead_air_ms:.0f} ms of dead air before the first sound (limit {cfg.dead_air_ms:.0f} ms).", 0.0))
        if latency_ms is None:
            flags.append(_flag("no_audio_hit", "high", "No vocal or high-energy audio hit detected.", 0.0))
        elif latency_ms > cfg.dead_air_ms:
            flags.append(_flag("late_audio_hit", "high" if latency_ms > 400 else "medium",
                               f"First vocal/transient hit at {latency_ms:.0f} ms.", latency_ms / 1000.0))
        if energy_delta_db is not None and energy_delta_db < -6:
            flags.append(_flag("quiet_hook", "medium",
                               f"Hook is {abs(energy_delta_db):.1f} dB quieter than the body of the video.", 0.0))
    else:
        latency_credit = energy_credit = audio_score = 0.0
        flags.append(_flag("no_audio_stream", "high", "File has no audio stream.", 0.0))

    # ---- OCR hook --------------------------------------------------------------------------
    text_score: float | None = None
    text_detail: list[dict] = []
    if ocr is not None:
        per_time = []
        for t in sorted(ocr):
            best = 0.0
            best_det = None
            for det in ocr[t]:
                x0, y0, x1, y1 = det["box"]
                safe = safe_zones.in_safe_zone(x0, y0, x1, y1)
                s = (
                    (0.5 if safe else 0.12)
                    + 0.3 * clip01(det["contrast"] / cfg.ocr_good_contrast)
                    + 0.2 * clip01(det["height_ratio"] / cfg.ocr_min_text_height)
                )
                det_out = {**det, "in_safe_zone": safe,
                           "obstructed_by": {p: safe_zones.obstructions(x0, y0, x1, y1, p) for p in ("tiktok", "reels")}}
                if s > best:
                    best, best_det = s, det_out
            per_time.append(best)
            text_detail.append({"t": t, "score": r(best), "best": best_det, "count": len(ocr[t])})
            if best_det is None:
                flags.append(_flag("no_text_hook", "medium", f"No on-screen text hook at {t:.1f}s.", t))
            else:
                if not best_det["in_safe_zone"]:
                    flags.append(_flag("text_outside_safe_zone", "high",
                                       f"Hook text “{best_det['text']}” sits under platform UI at {t:.1f}s.", t))
                if best_det["contrast"] < cfg.ocr_good_contrast:
                    flags.append(_flag("low_contrast_text", "medium",
                                       f"Hook text contrast {best_det['contrast']:.1f}:1 (target ≥ {cfg.ocr_good_contrast}:1).", t))
                if best_det["height_ratio"] < cfg.ocr_min_text_height:
                    flags.append(_flag("small_text", "low",
                                       f"Hook text is {best_det['height_ratio'] * 100:.1f}% of frame height; go bigger.", t))
        text_score = float(np.mean(per_time)) if per_time else 0.0

    weights = dict(cfg.hook_weights)
    parts = {"visual": visual, "audio": audio_score, "text": text_score}
    used = {k: v for k, v in parts.items() if v is not None}
    total_w = sum(weights[k] for k in used)
    score = 100.0 * sum(weights[k] * used[k] for k in used) / total_w if total_w else 0.0

    return {
        "score": r(score, 1),
        "components": {k: (r(v * 100, 1) if v is not None else None) for k, v in parts.items()},
        "weights": weights,
        "visual": {
            "first_frame_luma": r(f0.luma_mean, 1),
            "first_frame_luma_std": r(f0.luma_std, 1),
            "first_frame_flow_px_s": r(first_flow, 2),
            "mean_flow_px_s": r(motion_mean, 2),
            "early_flow_px_s": r(motion_early, 2),
            "mean_frame_diff": r(mean_diff, 4),
            "luma_variance": r(float(np.var(luma_series)), 2),
            "cuts_in_hook": [r(c) for c in hook_cuts],
            "frames_analyzed": len(head),
            "credits": {
                "motion": r(motion_credit), "early_motion": r(early_credit), "brightness": r(bright_credit),
                "detail": r(detail_credit), "change": r(change_credit),
            },
        },
        "audio": {
            "onset_latency_ms": r(latency_ms, 0),
            "dead_air_ms": r(dead_air_ms, 0),
            "first_word_s": r(first_word),
            "first_onset_s": r(first_onset),
            "hook_vs_body_db": r(energy_delta_db, 2),
            "credits": {"latency": r(latency_credit), "energy": r(energy_credit)},
        },
        "text": {"frames": text_detail, "ran": ocr is not None},
        "flags": flags,
    }


# ----------------------------------------------------------------------------------
# 2. Pacing, stagnation and speech
# ----------------------------------------------------------------------------------

def _pacing(scan: FrameScan, cuts: list[float], transcript: dict, duration: float, cfg: AnalysisConfig) -> dict:
    arr = scan.sample_arrays()
    t, flow, hd = arr["t"], arr["flow"], arr["hist_delta"]

    # Motion shifts: large appearance changes that aren't hard cuts (whip pans, reveals).
    shifts = [float(t[i]) for i in range(1, len(t))
              if hd[i] >= 0.25 and all(abs(t[i] - c) > 0.3 for c in cuts)]
    deduped: list[float] = []
    for s in shifts:
        if not deduped or s - deduped[-1] > 0.5:
            deduped.append(s)
    shifts = deduped
    events = sorted(cuts + shifts)

    active = (flow >= cfg.stagnation_flow_px_s) | (hd >= cfg.stagnation_hist_delta)
    for e in events:
        active |= np.abs(t - e) <= 0.15

    stagnation = []
    for i, j in runs(~active):
        start = float(t[i - 1]) if i > 0 else 0.0
        end = float(t[j]) if j < len(t) else duration
        if end - start >= cfg.stagnation_s:
            stagnation.append({
                "start_s": r(start), "end_s": r(end), "duration_s": r(end - start),
                "mean_flow_px_s": r(float(np.mean(flow[i:j])), 2),
            })

    bounds = [0.0] + cuts + [duration]
    shots = np.diff(bounds)
    shot_list = [{"start_s": r(bounds[k]), "end_s": r(bounds[k + 1]), "length_s": r(float(shots[k]))}
                 for k in range(len(shots))]
    minutes = max(duration / 60.0, 1e-6)

    words = transcript.get("words") or []
    speech: dict[str, Any] = {"words": len(words), "wpm": None, "articulation_wpm": None, "pauses": [], "wpm_curve": []}
    if words:
        span = float(words[-1]["end"] - words[0]["start"])
        pauses = []
        for a, b in zip(words, words[1:]):
            gap = float(b["start"] - a["end"])
            if gap > cfg.pause_gap_s:
                pauses.append({"start_s": r(a["end"]), "end_s": r(b["start"]), "duration_s": r(gap),
                               "after_word": a["word"]})
        paused = sum(p["duration_s"] for p in pauses)
        speech["wpm"] = r(len(words) / (span / 60.0), 1) if span > 0 else None
        speech["articulation_wpm"] = r(len(words) / ((span - paused) / 60.0), 1) if span - paused > 0 else None
        speech["pauses"] = pauses
        speech["longest_pause_s"] = r(max((p["duration_s"] for p in pauses), default=0.0))
        speech["speech_start_s"] = r(words[0]["start"])
        speech["speech_end_s"] = r(words[-1]["end"])
        starts = np.array([w["start"] for w in words])
        curve = []
        for c in np.arange(0.0, duration + 1e-6, 1.0):
            lo, hi = max(0.0, c - 2.5), min(duration, c + 2.5)
            n = int(np.sum((starts >= lo) & (starts < hi)))
            curve.append({"t": r(c, 2), "wpm": r(n / max((hi - lo) / 60.0, 1e-6), 1)})
        speech["wpm_curve"] = curve

    return {
        "cuts": [r(c) for c in cuts],
        "motion_shifts": [r(s) for s in shifts],
        "cut_count": len(cuts),
        "cuts_per_minute": r(len(cuts) / minutes, 2),
        "visual_events_per_minute": r(len(events) / minutes, 2),
        "avg_shot_length_s": r(float(np.mean(shots)), 3),
        "median_shot_length_s": r(float(np.median(shots)), 3),
        "longest_shot_s": r(float(np.max(shots)), 3),
        "shots": shot_list,
        "stagnation_zones": stagnation,
        "stagnation_seconds": r(sum(z["duration_s"] for z in stagnation), 2),
        "speech": speech,
    }


# ----------------------------------------------------------------------------------
# 3. Seamless loop coefficient
# ----------------------------------------------------------------------------------

def _mean_hist(hists: list[np.ndarray]) -> np.ndarray:
    h = np.mean(np.stack(hists), axis=0).astype(np.float32)
    s = float(h.sum())
    return h / s if s > 0 else h


def _db_window(t_db: np.ndarray, db: np.ndarray, start: float, end: float) -> np.ndarray:
    m = (t_db >= start) & (t_db < end)
    return db[m]


def _loop(
    scan: FrameScan,
    audio: np.ndarray,
    sr: int,
    t_db: np.ndarray,
    db: np.ndarray,
    first_sound: float | None,
    last_sound: float | None,
    transcript: dict,
    duration: float,
    cfg: AnalysisConfig,
) -> dict:
    win = cfg.loop_window_s
    fps = scan.fps
    end_t = scan.frames_read / fps
    has_audio = db.size > 0
    audio_end = audio.size / sr if has_audio else end_t
    loop_end = min(end_t, audio_end)

    head_w = [h for h in scan.head if h.t < win] or scan.head[:1]
    tail_w = [f for f in scan.tail if f.t >= end_t - win] or scan.tail[-1:]
    hist_sim = hist_similarity(_mean_hist([h.hist for h in head_w]), _mean_hist([f.hist for f in tail_w]))
    frame_sim = gray_similarity(scan.tail[-1].gray, scan.head[0].gray)

    arr = scan.sample_arrays()
    head_flow = arr["flow"][(arr["t"] > 0) & (arr["t"] < win)]
    tail_flow = arr["flow"][arr["t"] >= end_t - win]
    if head_flow.size and tail_flow.size:
        a, b = float(np.mean(head_flow)) + 1.0, float(np.mean(tail_flow)) + 1.0
        motion_match = min(a, b) / max(a, b)
    else:
        motion_match = 0.5

    rms_corr = level_match = boundary = None
    if has_audio:
        a_env = _db_window(t_db, db, 0.0, win)
        b_env = _db_window(t_db, db, loop_end - win, loop_end)
        n = min(a_env.size, b_env.size)
        c = pearson(resample(a_env, n), resample(b_env, n)) if n >= 3 else None
        rms_corr = (c + 1.0) / 2.0 if c is not None else 0.5
        level_match = clip01(1.0 - abs(float(np.mean(a_env)) - float(np.mean(b_env))) / 12.0) if a_env.size and b_env.size else 0.0
        a_edge = _db_window(t_db, db, 0.0, 0.05)
        b_edge = _db_window(t_db, db, loop_end - 0.05, loop_end)
        boundary = clip01(1.0 - abs(float(np.mean(a_edge)) - float(np.mean(b_edge))) / 9.0) if a_edge.size and b_edge.size else 0.0

    def combine(hs: float, fs: float, mm: float, rc: float | None, lm: float | None, bd: float | None) -> float:
        if rc is None:
            return 100.0 * (0.45 * hs + 0.35 * fs + 0.20 * mm)
        return 100.0 * (0.30 * hs + 0.20 * fs + 0.10 * mm + 0.15 * rc + 0.10 * lm + 0.15 * bd)

    score = combine(hist_sim, frame_sim, motion_match, rms_corr, level_match, boundary)

    # ---- trim search -------------------------------------------------------------------
    words = transcript.get("words") or []
    head_trim = 0.0
    if has_audio and first_sound is not None and first_sound * 1000.0 > cfg.dead_air_ms:
        head_trim = max(0.0, first_sound - cfg.trim_head_pad_ms / 1000.0)
    ref = next((h for h in scan.head if h.t >= head_trim - 1e-6), scan.head[-1])
    ref_level = float(np.mean(_db_window(t_db, db, head_trim, head_trim + 0.05))) if has_audio else 0.0

    silence_end = loop_end
    if has_audio and last_sound is not None and loop_end - last_sound > 0.15:
        silence_end = min(loop_end, last_sound + cfg.trim_tail_pad_ms / 1000.0)

    def mid_word(te: float) -> bool:
        return any(w["start"] < te < w["end"] + cfg.loop_word_pad_s for w in words)

    def evaluate(frame, te: float) -> dict:
        vis = 0.55 * gray_similarity(frame.gray, ref.gray) + 0.45 * hist_similarity(frame.hist, ref.hist)
        if has_audio:
            lvl = _db_window(t_db, db, te - 0.05, te)
            bd = clip01(1.0 - abs((float(np.mean(lvl)) if lvl.size else -90.0) - ref_level) / 9.0)
        else:
            bd = 1.0
        return {"te": te, "vis": vis, "boundary": bd, "frame_sim": gray_similarity(frame.gray, ref.gray),
                "hist_sim": hist_similarity(frame.hist, ref.hist)}

    candidates = []
    for f in scan.tail:
        te = f.t + 1.0 / fps
        if te < silence_end - cfg.loop_search_s - 1e-6 or te > silence_end + 1e-6:
            continue
        if mid_word(te):
            continue
        ev = evaluate(f, te)
        removed = end_t - te
        ev["score"] = 0.7 * ev["vis"] + 0.3 * ev["boundary"] - 0.04 * removed / cfg.loop_search_s
        candidates.append(ev)

    baseline = evaluate(scan.tail[-1], end_t)
    baseline["score"] = 0.7 * baseline["vis"] + 0.3 * baseline["boundary"]
    best = max(candidates, key=lambda e: e["score"]) if candidates else None

    tail_trim = 0.0
    chosen = baseline
    reason = "Current ending already matches the opening best; no tail trim."
    if silence_end < loop_end - 1e-6:
        tail_trim = loop_end - silence_end
        reason = f"Trailing silence of {(loop_end - (last_sound or loop_end)) * 1000:.0f} ms after the last sound."
        chosen = best or baseline
        if best is not None:
            tail_trim = end_t - best["te"]
            reason += " Cut placed on the frame that best matches the new first frame."
    elif best is not None and best["score"] > baseline["score"] + 0.03:
        tail_trim = end_t - best["te"]
        chosen = best
        reason = "An earlier end frame matches the opening frame more closely."

    if chosen is baseline and head_trim == 0.0:
        projected = score
    else:
        projected = combine(
            max(hist_sim, chosen["hist_sim"]), max(frame_sim, chosen["frame_sim"]), motion_match,
            rms_corr, level_match, chosen["boundary"] if has_audio else None,
        )

    ending: dict[str, Any] = {}
    segs = transcript.get("segments") or []
    if segs:
        last_text = segs[-1]["text"].strip()
        ending = {
            "last_sentence": last_text,
            "first_sentence": segs[0]["text"].strip(),
            "ends_open": bool(last_text) and last_text[-1] not in ".!?…",
            "cut_mid_word": bool(words) and words[-1]["end"] > loop_end - 0.03,
        }

    return {
        "score": r(score, 1),
        "components": {
            "visual_histogram": r(hist_sim * 100, 1),
            "boundary_frame": r(frame_sim * 100, 1),
            "motion_match": r(motion_match * 100, 1),
            "audio_envelope": r(rms_corr * 100, 1) if rms_corr is not None else None,
            "audio_level": r(level_match * 100, 1) if level_match is not None else None,
            "audio_boundary": r(boundary * 100, 1) if boundary is not None else None,
        },
        "recommendation": {
            "trim_start_ms": int(round(head_trim * 1000)),
            "trim_end_ms": int(round(tail_trim * 1000)),
            "new_start_s": r(head_trim),
            "new_end_s": r(end_t - tail_trim),
            "new_duration_s": r(end_t - tail_trim - head_trim),
            "projected_score": r(projected, 1),
            "reason": reason,
        },
        "ending": ending,
        "window_s": win,
    }


# ----------------------------------------------------------------------------------
# Timeline + swipe-risk zones
# ----------------------------------------------------------------------------------

def _timeline(
    scan: FrameScan,
    cuts: list[float],
    t_db: np.ndarray,
    db: np.ndarray,
    transcript: dict,
    pacing: dict,
    duration: float,
    cfg: AnalysisConfig,
) -> tuple[list[dict], list[dict]]:
    arr = scan.sample_arrays()
    words = transcript.get("words") or []
    pauses = pacing["speech"]["pauses"]
    stag = pacing["stagnation_zones"]
    step = cfg.timeline_bin_s
    edges = np.arange(0.0, duration + 1e-9, step)
    if edges.size == 0 or edges[-1] < duration:
        edges = np.append(edges, duration)

    def overlaps(items, a, b, s="start_s", e="end_s"):
        return any(it[s] < b and it[e] > a for it in items)

    bins = []
    for a, b in zip(edges[:-1], edges[1:]):
        m = (arr["t"] >= a) & (arr["t"] < b)
        flow = float(np.mean(arr["flow"][m])) if m.any() else float(np.interp((a + b) / 2, arr["t"], arr["flow"]))
        lvl = _db_window(t_db, db, a, b)
        level = float(np.mean(lvl)) if lvl.size else -90.0
        motion_n = clip01(flow / cfg.strong_flow_px_s)
        energy_n = clip01((level + 60.0) / 60.0)
        speaking = any(w["start"] < b and w["end"] > a for w in words)
        in_pause = overlaps(pauses, a, b)
        in_stag = overlaps(stag, a, b)
        has_cut = any(a <= c < b for c in cuts)
        risk = 0.35 * (1 - motion_n) + 0.20 * (1 - energy_n) + 0.30 * in_stag + 0.15 * in_pause
        if has_cut:
            risk *= 0.6
        if a < cfg.hook_window_s:
            risk = min(1.0, risk * 1.15)
        bins.append({
            "t": r(a, 3),
            "motion_px_s": r(flow, 2),
            "motion_velocity": r(motion_n * 100, 1),
            "audio_db": r(level, 2),
            "audio_energy": r(energy_n * 100, 1),
            "risk": r(risk * 100, 1),
            "speaking": speaking,
            "pause": in_pause,
            "stagnant": in_stag,
            "cut": has_cut,
        })

    risk = np.array([bn["risk"] for bn in bins])
    zones = []
    for i, j in runs(risk >= 55.0):
        start, end = float(edges[i]), float(edges[j])
        if end - start < 0.75:
            continue
        seg = bins[i:j]
        reasons = []
        if np.mean([s["motion_velocity"] for s in seg]) < 25:
            reasons.append("low visual motion")
        if np.mean([s["audio_energy"] for s in seg]) < 40:
            reasons.append("low audio energy")
        if any(s["stagnant"] for s in seg):
            reasons.append(f"stagnation > {cfg.stagnation_s}s")
        if any(s["pause"] for s in seg):
            reasons.append(f"vocal pause > {cfg.pause_gap_s}s")
        zones.append({"start_s": r(start), "end_s": r(end), "duration_s": r(end - start),
                      "peak_risk": r(float(max(s["risk"] for s in seg)), 1), "reasons": reasons})
    # Stagnation zones are swipe-risk zones even when audio keeps the blended risk lower.
    for z in stag:
        if not any(x["start_s"] <= z["start_s"] and x["end_s"] >= z["end_s"] for x in zones):
            seg = [bn for bn in bins if z["start_s"] <= bn["t"] < z["end_s"]]
            zones.append({"start_s": z["start_s"], "end_s": z["end_s"], "duration_s": z["duration_s"],
                          "peak_risk": r(max((s["risk"] for s in seg), default=0.0), 1),
                          "reasons": [f"stagnation > {cfg.stagnation_s}s"]})
    zones.sort(key=lambda z: z["start_s"])
    merged: list[dict] = []
    for z in zones:
        if merged and z["start_s"] <= merged[-1]["end_s"]:
            last = merged[-1]
            last["end_s"] = max(last["end_s"], z["end_s"])
            last["duration_s"] = r(last["end_s"] - last["start_s"])
            last["peak_risk"] = max(last["peak_risk"], z["peak_risk"])
            last["reasons"] = sorted(set(last["reasons"]) | set(z["reasons"]))
        else:
            merged.append(dict(z))
    return bins, merged


# ----------------------------------------------------------------------------------
# Recommendations
# ----------------------------------------------------------------------------------

def _recommendations(hook: dict, pacing: dict, loop: dict, zones: list[dict], info: MediaInfo) -> list[dict]:
    recs: list[dict] = []
    order = {"high": 0, "medium": 1, "low": 2}
    for f in hook["flags"]:
        recs.append({"severity": f["severity"], "area": "hook", "message": f["message"], "at_s": f["at_s"]})
    for z in pacing["stagnation_zones"]:
        recs.append({"severity": "high", "area": "pacing", "at_s": z["start_s"],
                     "message": f"Stagnation {z['start_s']:.1f}–{z['end_s']:.1f}s ({z['duration_s']:.1f}s): add a cut, zoom or B-roll."})
    for p in pacing["speech"]["pauses"]:
        recs.append({"severity": "medium" if p["duration_s"] < 0.8 else "high", "area": "speech", "at_s": p["start_s"],
                     "message": f"{p['duration_s'] * 1000:.0f} ms pause after “{p['after_word']}” at {p['start_s']:.2f}s: tighten the jump cut."})
    wpm = pacing["speech"].get("wpm")
    if wpm is not None and wpm < 140:
        recs.append({"severity": "medium", "area": "speech", "at_s": None,
                     "message": f"Speech pace {wpm:.0f} WPM; short-form outliers usually run 160–200 WPM."})
    rec = loop["recommendation"]
    if rec["trim_start_ms"] or rec["trim_end_ms"]:
        recs.append({"severity": "medium", "area": "loop", "at_s": None,
                     "message": (f"Trim {rec['trim_start_ms']} ms from the start and {rec['trim_end_ms']} ms from the end "
                                 f"(loop {loop['score']:.0f} → {rec['projected_score']:.0f}). {rec['reason']}")})
    if info.aspect and abs(info.aspect - 9 / 16) > 0.02:
        recs.append({"severity": "high", "area": "format", "at_s": None,
                     "message": f"Aspect ratio {info.width}x{info.height} is not 9:16; the optimizer will reframe to 1080x1920."})
    recs.sort(key=lambda x: (order.get(x["severity"], 3), x["at_s"] if x["at_s"] is not None else 1e9))
    return recs
