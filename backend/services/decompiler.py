"""MODULE 2 — Competitor Viral Decompiler.

Turns a reference Reel/TikTok (URL or file) into a "Viral DNA Blueprint":
  - cut cadence array, average shot length, cuts per minute
  - 100 ms RMS energy curve and motion-velocity curve
  - transcript hook structure (first 3 s) and payoff timestamp
  - the reference's own hook / loop scores from the auditor
and benchmarks a draft audit against a stored template.

The reference is analysed with the same engine as drafts (video_auditor.audit), so
every number in a comparison is measured the same way.
"""
from __future__ import annotations

import re
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import numpy as np

from config import CONFIG, REFERENCE_DIR, AnalysisConfig
from services.media import load_audio
from services.signals import ProgressFn, clip01, energy_curve, pearson, resample
from services.utils import r, to_jsonable
from services.video_auditor import audit

HOOK_WINDOW_S = 3.0

# Phrases that typically open the reveal/answer part of a short-form script.
PAYOFF_MARKERS = (
    "here's", "heres", "here is", "the answer", "turns out", "the secret", "that's why", "thats why",
    "the reason", "so what", "which means", "the result", "and then", "watch this", "look at this",
    "finally", "the trick", "the real", "number one", "the best part", "this is how", "this is why",
)


def _noop(_p: float, _s: str) -> None:
    return None


def detect_platform(url: str) -> str:
    host = (urlparse(url).hostname or "").lower()
    if "tiktok" in host:
        return "tiktok"
    if "instagram" in host:
        return "instagram"
    if "youtube" in host or "youtu.be" in host:
        return "youtube"
    return host or "unknown"


def download(url: str, progress: ProgressFn = _noop) -> tuple[Path, dict[str, Any]]:
    """Downloads the best video+audio stream merged to MP4. Returns (path, metadata)."""
    from yt_dlp import YoutubeDL

    def hook(d: dict) -> None:
        if d.get("status") == "downloading":
            total = d.get("total_bytes") or d.get("total_bytes_estimate") or 0
            if total:
                progress(0.02 + 0.13 * min(1.0, d.get("downloaded_bytes", 0) / total), "Downloading reference")

    opts = {
        "format": "bv*[ext=mp4]+ba[ext=m4a]/bv*+ba/b",
        "merge_output_format": "mp4",
        "outtmpl": str(REFERENCE_DIR / "%(extractor)s_%(id)s.%(ext)s"),
        "noplaylist": True,
        "quiet": True,
        "no_warnings": True,
        "progress_hooks": [hook],
        "retries": 3,
        "concurrent_fragment_downloads": 4,
    }
    with YoutubeDL(opts) as ydl:
        info = ydl.extract_info(url, download=True)
        if info.get("_type") == "playlist" and info.get("entries"):
            info = info["entries"][0]
        path = Path(ydl.prepare_filename(info)).with_suffix(".mp4")
        if not path.exists():
            # yt-dlp keeps the original container when no merge was needed
            candidates = sorted(REFERENCE_DIR.glob(f"{info.get('extractor', '*')}_{info['id']}.*"))
            if not candidates:
                raise FileNotFoundError(f"Download finished but no file was found for {url}")
            path = candidates[0]

    meta = {
        "id": info.get("id"),
        "title": info.get("title") or info.get("description", "")[:120],
        "description": info.get("description"),
        "uploader": info.get("uploader") or info.get("channel"),
        "upload_date": info.get("upload_date"),
        "view_count": info.get("view_count"),
        "like_count": info.get("like_count"),
        "comment_count": info.get("comment_count"),
        "repost_count": info.get("repost_count"),
        "duration": info.get("duration"),
        "extractor": info.get("extractor"),
        "webpage_url": info.get("webpage_url") or url,
        "track": info.get("track"),
        "artist": info.get("artist"),
    }
    views = meta["view_count"] or 0
    if views:
        engaged = (meta["like_count"] or 0) + (meta["comment_count"] or 0) + (meta["repost_count"] or 0)
        meta["engagement_rate"] = round(engaged / views, 5)
    return path, meta


def _payoff(report: dict, duration: float) -> dict[str, Any]:
    """Where the video "pays off" the hook: the strongest combined spike in audio energy,
    cut density and motion after the hook window, with a bonus where the transcript
    uses reveal phrasing. Returns the timestamp and why it was chosen."""
    bins = report["timeline"]
    if not bins or duration <= HOOK_WINDOW_S + 1.0:
        return {"t": None, "reason": "Video too short for a separate payoff."}
    t = np.array([b["t"] for b in bins])
    energy = np.array([b["audio_energy"] for b in bins], dtype=float)
    motion = np.array([b["motion_velocity"] for b in bins], dtype=float)
    cuts = np.array([1.0 if b["cut"] else 0.0 for b in bins])

    def smooth(x: np.ndarray, width: int) -> np.ndarray:
        k = np.ones(width) / width
        return np.convolve(x, k, mode="same")

    def z(x: np.ndarray) -> np.ndarray:
        s = x.std()
        return (x - x.mean()) / s if s > 1e-9 else np.zeros_like(x)

    step = report["config"]["timeline_bin_s"]
    w1 = max(1, int(round(1.0 / step)))
    w2 = max(1, int(round(2.0 / step)))
    score = z(smooth(energy, w1)) + z(smooth(cuts, w2)) + 0.5 * z(smooth(motion, w1))

    words = report["transcript"].get("words") or []
    text_hits: list[tuple[float, str]] = []
    if words:
        lowered = [re.sub(r"[^\w' ]", "", w["word"].lower()) for w in words]
        for i in range(len(words)):
            window = " ".join(lowered[i:i + 4])
            for marker in PAYOFF_MARKERS:
                if window.startswith(marker):
                    text_hits.append((float(words[i]["start"]), marker))
                    break
        for ts, _ in text_hits:
            score += 1.5 * np.exp(-((t - ts) ** 2) / (2 * 0.75 ** 2))

    valid = (t >= HOOK_WINDOW_S) & (t <= duration * 0.92)
    if not valid.any():
        return {"t": None, "reason": "No candidate window after the hook."}
    idx = int(np.argmax(np.where(valid, score, -np.inf)))
    ts = float(t[idx])
    marker = next((m for tt, m in text_hits if abs(tt - ts) < 1.5), None)
    reason = f"Peak of energy/cut-density/motion at {ts:.2f}s"
    if marker:
        reason += f", aligned with reveal phrase “{marker}”"
    return {"t": r(ts), "relative": r(ts / duration), "reason": reason, "reveal_phrases": [
        {"t": r(tt), "phrase": m} for tt, m in text_hits]}


def build_blueprint(path: Path, report: dict, cfg: AnalysisConfig = CONFIG) -> dict[str, Any]:
    duration = float(report["media"]["analyzed_duration_s"])
    pacing = report["pacing"]
    words = report["transcript"].get("words") or []
    hook_words = [w for w in words if w["start"] < HOOK_WINDOW_S]
    hook_text = " ".join(w["word"] for w in hook_words).strip()

    audio = load_audio(path, cfg.audio_sr) if report["media"]["has_audio"] else np.zeros(0, dtype=np.float32)
    curve = energy_curve(audio, cfg.audio_sr, step_s=0.1)
    cuts = pacing["cuts"]
    shot_lengths = [s["length_s"] for s in pacing["shots"]]
    payoff = _payoff(report, duration)

    first_cut = cuts[0] if cuts else None
    return to_jsonable({
        "duration_s": r(duration),
        "cut_cadence": {
            "cuts_s": cuts,
            "shot_lengths_s": shot_lengths,
            "cut_count": len(cuts),
            "cuts_per_minute": pacing["cuts_per_minute"],
            "avg_shot_length_s": pacing["avg_shot_length_s"],
            "median_shot_length_s": pacing["median_shot_length_s"],
            "first_cut_s": first_cut,
            "cuts_in_first_3s": sum(1 for c in cuts if c < HOOK_WINDOW_S),
            "motion_shifts_s": pacing["motion_shifts"],
        },
        "audio_energy_curve": curve,
        "motion_curve": [{"t": b["t"], "v": b["motion_velocity"]} for b in report["timeline"]],
        "hook_structure": {
            "window_s": HOOK_WINDOW_S,
            "text": hook_text,
            "words": hook_words,
            "word_count": len(hook_words),
            "first_word_s": words[0]["start"] if words else None,
            "onset_latency_ms": report["hook"]["audio"]["onset_latency_ms"],
            "on_screen_text": [
                d["best"]["text"] for d in report["hook"]["text"]["frames"] if d.get("best")
            ],
        },
        "payoff": payoff,
        "speech": {
            "wpm": pacing["speech"]["wpm"],
            "articulation_wpm": pacing["speech"]["articulation_wpm"],
            "pause_count": len(pacing["speech"]["pauses"]),
        },
        "scores": {"hook": report["hook"]["score"], "loop": report["loop"]["score"]},
        "transcript": report["transcript"].get("text", ""),
        "audit": report,
    })


def decompile(
    url: str | None = None,
    file_path: str | Path | None = None,
    progress: ProgressFn = _noop,
    cfg: AnalysisConfig = CONFIG,
) -> dict[str, Any]:
    """Returns {"path", "source_stats", "platform", "blueprint"}; persistence is done by the caller."""
    if not url and not file_path:
        raise ValueError("Provide a URL or a reference file")
    if url:
        progress(0.01, "Resolving reference URL")
        path, meta = download(url, progress)
        platform = detect_platform(url)
    else:
        path, meta, platform = Path(file_path), {"title": Path(file_path).stem}, "file"

    def sub(p: float, stage: str) -> None:
        progress(0.15 + 0.8 * p, stage)

    report = audit(path, progress=sub, cfg=cfg)
    progress(0.96, "Building blueprint")
    blueprint = build_blueprint(path, report, cfg)
    return {"path": str(path), "source_stats": meta, "platform": platform, "blueprint": blueprint}


# ----------------------------------------------------------------------------------
# Benchmark a draft audit against a template
# ----------------------------------------------------------------------------------

def _ratio_gap(draft: float | None, ref: float | None) -> float | None:
    if draft is None or ref in (None, 0):
        return None
    return (draft - ref) / ref


def benchmark(draft: dict, template_blueprint: dict, template_name: str = "template") -> dict[str, Any]:
    """Side-by-side telemetry: deltas, curve similarity and concrete edits."""
    d_dur = float(draft["media"]["analyzed_duration_s"])
    t_dur = float(template_blueprint["duration_s"])
    d_p, t_c = draft["pacing"], template_blueprint["cut_cadence"]

    metrics = {
        "hook_score": (draft["hook"]["score"], template_blueprint["scores"]["hook"]),
        "loop_score": (draft["loop"]["score"], template_blueprint["scores"]["loop"]),
        "cuts_per_minute": (d_p["cuts_per_minute"], t_c["cuts_per_minute"]),
        "avg_shot_length_s": (d_p["avg_shot_length_s"], t_c["avg_shot_length_s"]),
        "first_cut_s": (d_p["cuts"][0] if d_p["cuts"] else None, t_c["first_cut_s"]),
        "onset_latency_ms": (draft["hook"]["audio"]["onset_latency_ms"], template_blueprint["hook_structure"]["onset_latency_ms"]),
        "wpm": (d_p["speech"]["wpm"], template_blueprint["speech"]["wpm"]),
        "duration_s": (r(d_dur), r(t_dur)),
        "stagnation_seconds": (d_p["stagnation_seconds"], template_blueprint["audit"]["pacing"]["stagnation_seconds"]),
    }
    table = [{"metric": k, "draft": a, "template": b, "gap": r(_ratio_gap(a, b), 3)} for k, (a, b) in metrics.items()]

    # Curves on a shared relative timeline (0..1) and on absolute seconds for the first 10 s.
    n = 100
    d_energy = np.array([b["audio_db"] for b in draft["timeline"]], dtype=float)
    t_energy = np.array([p["db"] for p in template_blueprint["audio_energy_curve"]], dtype=float)
    d_motion = np.array([b["motion_velocity"] for b in draft["timeline"]], dtype=float)
    t_motion = np.array([p["v"] for p in template_blueprint["motion_curve"]], dtype=float)
    energy_corr = pearson(resample(d_energy, n), resample(t_energy, n)) if d_energy.size and t_energy.size else None
    motion_corr = pearson(resample(d_motion, n), resample(t_motion, n)) if d_motion.size and t_motion.size else None

    rel = np.linspace(0, 1, n)
    overlay = [
        {
            "x": r(x, 3),
            "draft_energy_db": r(a, 2), "template_energy_db": r(b, 2),
            "draft_motion": r(c, 1), "template_motion": r(d, 1),
        }
        for x, a, b, c, d in zip(
            rel,
            resample(d_energy, n) if d_energy.size else [None] * n,
            resample(t_energy, n) if t_energy.size else [None] * n,
            resample(d_motion, n) if d_motion.size else [None] * n,
            resample(t_motion, n) if t_motion.size else [None] * n,
        )
    ]
    cadence = {
        "draft_relative": [r(c / d_dur, 4) for c in d_p["cuts"]],
        "template_relative": [r(c / t_dur, 4) for c in t_c["cuts_s"]],
    }

    actions: list[str] = []
    if t_c["avg_shot_length_s"] and d_p["avg_shot_length_s"] > t_c["avg_shot_length_s"] * 1.25:
        target_cuts = int(np.ceil(d_dur / t_c["avg_shot_length_s"])) - 1
        actions.append(
            f"{template_name} averages a shot every {t_c['avg_shot_length_s']:.2f}s; you average "
            f"{d_p['avg_shot_length_s']:.2f}s. Add ~{max(1, target_cuts - d_p['cut_count'])} cuts to match the cadence."
        )
    if t_c["first_cut_s"] is not None and (not d_p["cuts"] or d_p["cuts"][0] > t_c["first_cut_s"] + 0.5):
        actions.append(f"Template's first cut lands at {t_c['first_cut_s']:.2f}s; move your first cut earlier.")
    d_lat, t_lat = metrics["onset_latency_ms"]
    if d_lat is not None and t_lat is not None and d_lat > t_lat + 100:
        actions.append(f"Your first audio hit is {d_lat - t_lat:.0f} ms later than the template's ({t_lat:.0f} ms).")
    d_wpm, t_wpm = metrics["wpm"]
    if d_wpm and t_wpm and abs(d_wpm - t_wpm) / t_wpm > 0.15:
        actions.append(f"Speech pace {d_wpm:.0f} WPM vs template {t_wpm:.0f} WPM.")
    payoff = template_blueprint.get("payoff", {})
    if payoff.get("relative") is not None:
        actions.append(
            f"Template pays off at {payoff['relative'] * 100:.0f}% of runtime ({payoff['t']:.1f}s); "
            f"in your cut that's {payoff['relative'] * d_dur:.1f}s."
        )
    if energy_corr is not None and energy_corr < 0.3:
        actions.append(f"Energy arc differs strongly from the template (r = {energy_corr:.2f}).")
    d_hook, t_hook = metrics["hook_score"]
    if d_hook is not None and t_hook is not None and t_hook - d_hook >= 10:
        actions.append(f"Hook score {d_hook:.0f} vs template {t_hook:.0f}; fix the hook flags first.")
    d_loop, t_loop = metrics["loop_score"]
    if d_loop is not None and t_loop is not None and t_loop - d_loop >= 15:
        rec = draft["loop"]["recommendation"]
        actions.append(
            f"Loop score {d_loop:.0f} vs template {t_loop:.0f}. Apply the loop trim "
            f"({rec['trim_start_ms']} ms head, {rec['trim_end_ms']} ms tail) or end on a frame that matches frame 0."
        )
    d_stag, t_stag = metrics["stagnation_seconds"]
    if d_stag and d_stag > (t_stag or 0) + 1.0:
        zones = ", ".join(f"{z['start_s']:.1f}–{z['end_s']:.1f}s" for z in d_p["stagnation_zones"])
        actions.append(f"{d_stag:.1f}s of stagnation vs {t_stag or 0:.1f}s in the template ({zones}).")

    match = np.mean([
        clip01(1 - abs(_ratio_gap(d_p["avg_shot_length_s"], t_c["avg_shot_length_s"]) or 0)),
        clip01(((energy_corr if energy_corr is not None else 0.0) + 1) / 2),
        clip01(((motion_corr if motion_corr is not None else 0.0) + 1) / 2),
        clip01((draft["hook"]["score"] or 0) / max(1.0, template_blueprint["scores"]["hook"] or 1.0)),
        clip01((draft["loop"]["score"] or 0) / max(1.0, template_blueprint["scores"]["loop"] or 1.0)),
    ])
    return to_jsonable({
        "template_match_score": r(float(match) * 100, 1),
        "metrics": table,
        "energy_correlation": r(energy_corr, 3),
        "motion_correlation": r(motion_corr, 3),
        "overlay": overlay,
        "cadence": cadence,
        "actions": actions,
    })
