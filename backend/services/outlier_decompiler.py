"""10x+ Outlier Decompiler & Niche Benchmark.

Stage 1  Zero-video metadata sweep of a creator's last N posts (yt-dlp, no downloads).
Stage 2  Leave-one-out trimmed baseline per post:
           others   = every other post's views (post i excluded, so a hit can't inflate
                      its own baseline)
           trimmed  = sorted(others)[1:-1] when len(others) >= 5
           baseline = max(mean(trimmed), median(others), 1)
           outlier_score       = views_i / baseline
           engagement_velocity = (likes + 3*comments + 5*reposts) / views * 1000
Stage 3  Only posts with outlier_score >= threshold are downloaded (to a temp dir that
         is deleted afterwards) and decompiled with `extract_telemetry`.

`extract_telemetry` is also what the Pre-Flight auditor runs on drafts, so a draft and
the outliers it is graded against are measured by exactly the same code.
"""
from __future__ import annotations

import math
import re
import statistics
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable
from urllib.parse import urlparse

import cv2
import numpy as np
from sqlalchemy import select
from sqlalchemy.orm import Session

from config import _env
from db import CreatorScan, SessionLocal, ViralBlueprint
from services.media import load_audio, probe
from services.signals import transcribe
from services.utils import r, to_jsonable

ProgressFn = Callable[[float, str], None]

INSTAGRAM_VIEWS_PER_LIKE = 18.5
HOOK_WINDOW_S = 1.7
HOOK_TRANSCRIPT_S = 3.0
FLOW_SIZE = (202, 360)          # (width, height) for the hook optical-flow pass
FLOW_FULL_SCALE_PX_S = 45.0     # mean flow at 202 px wide that maps to a score of 100
# PySceneDetect ContentDetector default. It keys mostly on hue/saturation/luma change, so
# a hard cut between two similarly bright, saturated shots can score below it; drafts are
# measured with the same detector, so niche deltas stay like-for-like either way.
CONTENT_THRESHOLD = _env("OUTLIER_CONTENT_THRESHOLD", 27.0)
MIN_SCENE_LEN_FRAMES = 8


def _noop(_p: float, _s: str) -> None:
    return None


# ----------------------------------------------------------------------------------
# Profiles
# ----------------------------------------------------------------------------------

def detect_platform(url: str) -> str:
    host = (urlparse(url).hostname or "").lower()
    if "tiktok" in host:
        return "tiktok"
    if "instagram" in host:
        return "instagram"
    raise ValueError(f"Unsupported profile host {host!r}; use a TikTok or Instagram profile URL")


def normalize_handle(handle: str) -> str:
    return handle.strip().lstrip("@").strip("/")


def profile_url_for(handle: str, platform: str) -> str:
    h = normalize_handle(handle)
    if platform == "tiktok":
        return f"https://www.tiktok.com/@{h}"
    if platform == "instagram":
        return f"https://www.instagram.com/{h}/"
    raise ValueError(f"Unknown platform {platform!r}")


def canonical_profile_url(url: str) -> str:
    """yt-dlp's Instagram profile extractor only matches instagram.com/<user>/, so
    /<user>/reels/ and similar tab URLs are reduced to the profile root."""
    if detect_platform(url) == "instagram":
        handle = handle_from_url(url)
        if handle:
            return profile_url_for(handle, "instagram")
    return url


def handle_from_url(url: str) -> str | None:
    path = urlparse(url).path.strip("/")
    if not path:
        return None
    first = path.split("/")[0]
    return normalize_handle(first) or None


class _ErrorLog:
    """yt-dlp logger that keeps error messages; with ignoreerrors they're otherwise lost."""

    def __init__(self) -> None:
        self.errors: list[str] = []

    def debug(self, msg: str) -> None:
        pass

    def info(self, msg: str) -> None:
        pass

    def warning(self, msg: str) -> None:
        pass

    def error(self, msg: str) -> None:
        self.errors.append(re.sub(r"\x1b\[[0-9;]*m", "", str(msg)).replace("ERROR: ", "", 1).strip())


def _ydl_opts(cookies_from_browser: str | None, **extra: Any) -> dict[str, Any]:
    opts: dict[str, Any] = {"quiet": True, "no_warnings": True, "retries": 3, **extra}
    if cookies_from_browser:
        # yt-dlp expects (browser, profile, keyring, container)
        opts["cookiesfrombrowser"] = (cookies_from_browser.lower(), None, None, None)
    return opts


# ----------------------------------------------------------------------------------
# Stage 1: metadata sweep
# ----------------------------------------------------------------------------------

def _int(v: Any) -> int | None:
    try:
        return None if v is None else int(v)
    except (TypeError, ValueError):
        return None


def post_from_entry(entry: dict[str, Any], platform: str) -> dict[str, Any]:
    views = _int(entry.get("view_count"))
    likes = _int(entry.get("like_count"))
    estimated = False
    if platform == "instagram" and not views and likes and likes > 0:
        views = int(likes * INSTAGRAM_VIEWS_PER_LIKE)
        estimated = True
    return {
        "video_id": str(entry.get("id") or ""),
        "webpage_url": entry.get("webpage_url") or entry.get("url") or "",
        "title": (entry.get("title") or entry.get("description") or "")[:300] or None,
        "timestamp": _int(entry.get("timestamp")),
        "duration": entry.get("duration"),
        "views": views,
        "views_estimated": estimated,
        "likes": likes,
        "comments": _int(entry.get("comment_count")),
        "reposts": _int(entry.get("repost_count")),
    }


def sweep_profile(
    profile_url: str,
    last_n: int = 20,
    cookies_from_browser: str | None = None,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Metadata for the creator's last `last_n` posts; nothing is downloaded."""
    from yt_dlp import YoutubeDL

    platform = detect_platform(profile_url)
    log = _ErrorLog()
    opts = _ydl_opts(
        cookies_from_browser,
        skip_download=True,
        extract_flat=False,
        playlistend=last_n,
        ignoreerrors=True,  # one private/removed post shouldn't abort the sweep
        logger=log,
    )
    with YoutubeDL(opts) as ydl:
        info = ydl.extract_info(profile_url, download=False)
    entries = [e for e in ((info or {}).get("entries") or ([info] if info else [])) if e]
    posts = [post_from_entry(e, platform) for e in entries[:last_n] if e.get("id")]
    if not posts:
        reason = log.errors[-1] if log.errors else "no posts were returned"
        hint = ""
        if platform == "instagram":
            hint = (" yt-dlp's Instagram profile listing is flagged as broken upstream; paste the creator's "
                    "Reel URLs (post_urls) instead, with cookies_from_browser set.")
        raise RuntimeError(f"Couldn't read {profile_url}: {reason}.{hint}")
    meta = {
        "platform": platform,
        "channel": info.get("uploader") or info.get("channel") or info.get("title"),
        "returned": len(posts),
        "skipped_errors": log.errors,
    }
    return posts, meta


def sweep_urls(
    urls: list[str],
    cookies_from_browser: str | None = None,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Metadata for an explicit list of post URLs (one extraction each, no downloads).
    The fallback for Instagram, whose profile listing yt-dlp can't currently read."""
    from yt_dlp import YoutubeDL

    if not urls:
        raise ValueError("No post URLs given")
    platform = detect_platform(urls[0])
    if any(detect_platform(u) != platform for u in urls):
        raise ValueError("All post URLs must be from the same platform")
    log = _ErrorLog()
    posts: list[dict[str, Any]] = []
    channel = None
    with YoutubeDL(_ydl_opts(cookies_from_browser, skip_download=True, ignoreerrors=True, logger=log)) as ydl:
        for url in urls:
            info = ydl.extract_info(url, download=False)
            if info and info.get("id"):
                posts.append(post_from_entry(info, platform))
                channel = channel or info.get("uploader_id") or info.get("channel") or info.get("uploader")
    if not posts:
        reason = log.errors[-1] if log.errors else "no posts could be read"
        hint = " Instagram needs a logged-in session: set cookies_from_browser (e.g. 'chrome')." if platform == "instagram" else ""
        raise RuntimeError(f"Couldn't read any of the {len(urls)} post URLs: {reason}.{hint}")
    return posts, {"platform": platform, "channel": channel, "returned": len(posts), "skipped_errors": log.errors}


# ----------------------------------------------------------------------------------
# Stage 2: leave-one-out trimmed baseline
# ----------------------------------------------------------------------------------

def trimmed_stats(values: list[float]) -> tuple[float, float, float]:
    """(trimmed_mean, median, robust_baseline) of a pool of view counts."""
    if not values:
        return 1.0, 1.0, 1.0
    pool = sorted(values)
    trimmed = pool[1:-1] if len(pool) >= 5 else pool
    tm = float(statistics.fmean(trimmed))
    med = float(statistics.median(pool))
    return tm, med, max(tm, med, 1.0)


def score_posts(posts: list[dict[str, Any]], outlier_threshold: float = 10.0) -> tuple[list[dict[str, Any]], float]:
    """Adds baseline / outlier_score / engagement_velocity to every post (in place order).
    Posts without a view count get no score and are left out of other posts' pools."""
    scored_idx = [i for i, p in enumerate(posts) if p.get("views") is not None]
    out: list[dict[str, Any]] = []
    for i, post in enumerate(posts):
        p = dict(post)
        views = p.get("views")
        if views is None:
            p.update(baseline=None, trimmed_mean=None, median=None, outlier_score=None,
                     engagement_velocity=None, is_outlier=False)
            out.append(p)
            continue
        others = [float(posts[j]["views"]) for j in scored_idx if j != i]
        tm, med, base = trimmed_stats(others)
        likes, comments, reposts = p.get("likes") or 0, p.get("comments") or 0, p.get("reposts") or 0
        score = round(views / base, 2)
        p.update(
            baseline=r(base, 1),
            trimmed_mean=r(tm, 1),
            median=r(med, 1),
            outlier_score=score,
            engagement_velocity=round(((likes + comments * 3 + reposts * 5) / max(views, 1)) * 1000, 2),
            is_outlier=score >= outlier_threshold,
        )
        out.append(p)
    _, _, creator_baseline = trimmed_stats([float(posts[j]["views"]) for j in scored_idx])
    return out, creator_baseline


# ----------------------------------------------------------------------------------
# Stage 3: telemetry
# ----------------------------------------------------------------------------------

def _cut_telemetry(path: Path, duration: float) -> dict[str, Any]:
    from scenedetect import ContentDetector, detect

    scenes = detect(str(path), ContentDetector(threshold=CONTENT_THRESHOLD, min_scene_len=MIN_SCENE_LEN_FRAMES),
                    show_progress=False)

    def seconds(tc) -> float:
        return float(tc.seconds if hasattr(type(tc), "seconds") else tc.get_seconds())

    cuts = [seconds(start) for start, _ in scenes[1:] if seconds(start) < duration]
    bounds = [0.0] + cuts + [duration]
    shots = np.diff(bounds) if len(bounds) > 1 else np.array([duration])
    minutes = max(duration / 60.0, 1e-6)
    return {
        "total_cuts": len(cuts),
        "cuts_per_minute": round(len(cuts) / minutes, 2),
        "avg_shot_length_sec": round(float(np.mean(shots)), 3),
        "cut_timestamps_sec": [round(c, 3) for c in cuts],
        "max_static_gap_sec": round(float(np.max(shots)), 3),
        "first_cut_timestamp_sec": round(cuts[0], 3) if cuts else None,
    }


def _hook_flow(path: Path, fps: float) -> dict[str, Any]:
    """Dense Farneback flow over the first 1.7 s at 202x360, as a 0-100 score."""
    cap = cv2.VideoCapture(str(path))
    if not cap.isOpened():
        raise RuntimeError(f"OpenCV could not open {path}")
    n = max(2, int(fps * HOOK_WINDOW_S))
    prev = None
    curve: list[dict[str, float]] = []
    mags: list[float] = []
    for i in range(n):
        ok, frame = cap.read()
        if not ok:
            break
        gray = cv2.cvtColor(cv2.resize(frame, FLOW_SIZE, interpolation=cv2.INTER_AREA), cv2.COLOR_BGR2GRAY)
        if prev is not None:
            flow = cv2.calcOpticalFlowFarneback(prev, gray, None, 0.5, 3, 15, 3, 5, 1.2, 0)
            mag, _ang = cv2.cartToPolar(flow[..., 0], flow[..., 1])
            m = float(mag.mean()) * fps  # px/frame -> px/s
            mags.append(m)
            curve.append({"t": round(i / fps, 3), "magnitude": round(m, 2)})
        prev = gray
    cap.release()
    mean = float(np.mean(mags)) if mags else 0.0
    return {
        "hook_optical_flow_score": round(100.0 * min(1.0, mean / FLOW_FULL_SCALE_PX_S), 1),
        "hook_flow_px_s": round(mean, 2),
        "hook_flow_curve": curve,
    }


def _audio_telemetry(path: Path, has_audio: bool) -> dict[str, Any]:
    import librosa

    if not has_audio:
        return {"rms_energy_curve_100ms": [], "audio_onset_latency_ms": None}
    sr = 22050
    y = load_audio(path, sr)
    if y.size == 0:
        return {"rms_energy_curve_100ms": [], "audio_onset_latency_ms": None}
    win = int(sr * 0.1)
    rms = librosa.feature.rms(y=y, frame_length=win, hop_length=win, center=False)[0]
    db = np.maximum(20.0 * np.log10(np.maximum(rms, 1e-10)) + 3.0103, -90.0)
    curve = [{"t": round(i * 0.1, 2), "db": round(float(v), 2)} for i, v in enumerate(db)]

    onsets = librosa.onset.onset_detect(y=y, sr=sr, units="time", backtrack=True)
    latency = float(onsets[0]) * 1000.0 if len(onsets) else None
    # onset_detect can't fire on frame 0: a sound that is already loud at the start
    # (within 12 dB of the file's peak in the first 100 ms) is a 0 ms hit.
    if db.size and float(db[0]) >= float(np.percentile(db, 99)) - 12.0:
        latency = 0.0
    return {"rms_energy_curve_100ms": curve, "audio_onset_latency_ms": r(latency, 0)}


def _speech_telemetry(path: Path, has_audio: bool, transcript: dict | None) -> dict[str, Any]:
    if transcript is None and has_audio:
        transcript = transcribe(load_audio(path, 16000))
    words = (transcript or {}).get("words") or []
    hook = " ".join(w["word"] for w in words if w["start"] < HOOK_TRANSCRIPT_S).strip()
    wpm = None
    if len(words) >= 2:
        span = float(words[-1]["end"] - words[0]["start"])
        wpm = round(len(words) / (span / 60.0), 1) if span > 0 else None
    return {
        "hook_transcript_3s": hook,
        "full_transcript": (transcript or {}).get("text", ""),
        "speaking_wpm": wpm,
        "word_count": len(words),
    }


def extract_telemetry(
    path: str | Path,
    transcript: dict | None = None,
    run_asr: bool = True,
    progress: ProgressFn = _noop,
) -> dict[str, Any]:
    """Cut cadence, 1.7 s hook flow, 100 ms RMS curve, onset latency and speech pace.
    Pass `transcript` (signals.transcribe output) to reuse an existing ASR pass."""
    path = Path(path)
    info = probe(path)
    progress(0.1, "Cut cadence")
    cuts = _cut_telemetry(path, info.duration_s)
    progress(0.4, "Hook optical flow")
    flow = _hook_flow(path, info.fps or 30.0)
    progress(0.55, "Audio energy")
    audio = _audio_telemetry(path, info.has_audio)
    progress(0.65, "Transcribing")
    if run_asr or transcript is not None:
        try:
            speech = _speech_telemetry(path, info.has_audio, transcript)
            speech["asr"] = True
        except Exception as exc:  # noqa: BLE001 — a missing model shouldn't lose the rest
            speech = {"hook_transcript_3s": "", "full_transcript": "", "speaking_wpm": None, "word_count": 0,
                      "asr": False, "asr_error": f"{type(exc).__name__}: {exc}"}
    else:
        speech = {"hook_transcript_3s": "", "full_transcript": "", "speaking_wpm": None, "word_count": 0, "asr": False}
    progress(1.0, "Done")
    return to_jsonable({"duration_sec": round(info.duration_s, 3), "fps": round(info.fps, 3),
                        **cuts, **flow, **audio, **speech})


def download_temp(url: str, directory: Path, cookies_from_browser: str | None = None) -> Path:
    from yt_dlp import YoutubeDL

    opts = _ydl_opts(
        cookies_from_browser,
        format="bv*[ext=mp4]+ba[ext=m4a]/bv*+ba/b",
        merge_output_format="mp4",
        outtmpl=str(directory / "%(id)s.%(ext)s"),
        noplaylist=True,
    )
    with YoutubeDL(opts) as ydl:
        info = ydl.extract_info(url, download=True)
        path = Path(ydl.prepare_filename(info)).with_suffix(".mp4")
    if not path.exists():
        found = sorted(directory.glob(f"{info['id']}.*"))
        if not found:
            raise FileNotFoundError(f"Download finished but no file was found for {url}")
        path = found[0]
    return path


# ----------------------------------------------------------------------------------
# Persistence
# ----------------------------------------------------------------------------------

def _posted_at(ts: int | None) -> datetime | None:
    return datetime.fromtimestamp(ts, tz=timezone.utc) if ts else None


def upsert_blueprint(s: Session, post: dict, tel: dict, creator: str, platform: str,
                     niche: str | None, scan_id: int | None) -> ViralBlueprint:
    row = s.scalars(select(ViralBlueprint).where(ViralBlueprint.platform == platform,
                                                 ViralBlueprint.video_id == post["video_id"])).first()
    if row is None:
        row = ViralBlueprint(platform=platform, video_id=post["video_id"])
        s.add(row)
    row.scan_id = scan_id
    row.creator_handle = creator
    row.niche = niche
    row.webpage_url = post["webpage_url"]
    row.title = post.get("title")
    row.posted_at = _posted_at(post.get("timestamp"))
    row.views = int(post["views"])
    row.views_estimated = bool(post.get("views_estimated"))
    row.likes, row.comments, row.reposts = post.get("likes"), post.get("comments"), post.get("reposts")
    row.baseline = float(post["baseline"])
    row.outlier_score = float(post["outlier_score"])
    row.engagement_velocity = float(post["engagement_velocity"])
    row.duration_sec = tel.get("duration_sec")
    row.total_cuts = int(tel["total_cuts"])
    row.cuts_per_minute = float(tel["cuts_per_minute"])
    row.avg_shot_length_sec = float(tel["avg_shot_length_sec"])
    row.first_cut_timestamp_sec = tel.get("first_cut_timestamp_sec")
    row.max_static_gap_sec = float(tel["max_static_gap_sec"])
    row.hook_optical_flow_score = float(tel["hook_optical_flow_score"])
    row.audio_onset_latency_ms = tel.get("audio_onset_latency_ms")
    row.speaking_wpm = tel.get("speaking_wpm")
    row.hook_transcript_3s = tel.get("hook_transcript_3s") or ""
    row.telemetry = {k: tel.get(k) for k in (
        "cut_timestamps_sec", "rms_energy_curve_100ms", "full_transcript", "hook_flow_curve",
        "hook_flow_px_s", "fps", "word_count", "asr", "asr_error")}
    return row


# ----------------------------------------------------------------------------------
# Orchestration
# ----------------------------------------------------------------------------------

def scan_creator(
    profile_url: str | None = None,
    creator_handle: str | None = None,
    platform: str | None = None,
    post_urls: list[str] | None = None,
    last_n: int = 20,
    outlier_threshold: float = 10.0,
    niche: str | None = None,
    cookies_from_browser: str | None = None,
    run_asr: bool = True,
    progress: ProgressFn = _noop,
    sweep: Callable[..., tuple[list[dict], dict]] = sweep_profile,
    sweep_list: Callable[..., tuple[list[dict], dict]] = sweep_urls,
    fetch: Callable[[str, Path, str | None], Path] = download_temp,
) -> dict[str, Any]:
    """Sweep -> score -> decompile the outliers -> persist. With `post_urls`, those posts
    are swept instead of the profile listing. `sweep`, `sweep_list` and `fetch` are
    injectable so the pipeline can run against local fixtures."""
    post_urls = [u.strip() for u in (post_urls or []) if u and u.strip()][:last_n]
    if post_urls:
        platform = detect_platform(post_urls[0])
        progress(0.02, f"Reading {len(post_urls)} post URLs")
        raw, meta = sweep_list(post_urls, cookies_from_browser)
        handle = normalize_handle(creator_handle) if creator_handle else normalize_handle(str(meta.get("channel") or "unknown"))
        profile_url = profile_url or profile_url_for(handle, platform)
    else:
        if not profile_url:
            if not creator_handle or not platform:
                raise ValueError("Provide profile_url, post_urls, or creator_handle together with platform")
            profile_url = profile_url_for(creator_handle, platform)
        profile_url = canonical_profile_url(profile_url)
        platform = detect_platform(profile_url)
        handle = normalize_handle(creator_handle) if creator_handle else (handle_from_url(profile_url) or "unknown")
        progress(0.02, f"Sweeping @{handle}'s last {last_n} posts")
        raw, meta = sweep(profile_url, last_n, cookies_from_browser)
    warnings: list[str] = []
    if meta.get("skipped_errors"):
        warnings.append(f"{len(meta['skipped_errors'])} post(s) couldn't be read and were skipped.")
    if len(raw) < 5:
        warnings.append(f"Only {len(raw)} posts returned; the baseline needs 20–30 to be stable.")
    elif len(raw) < 20:
        warnings.append(f"{len(raw)} posts returned; 20–30 give a more stable baseline.")
    missing = sum(1 for p in raw if p.get("views") is None)
    if missing:
        warnings.append(f"{missing} post(s) had no view count and were not scored.")
    estimated = sum(1 for p in raw if p.get("views_estimated"))
    if estimated:
        warnings.append(f"{estimated} Instagram view count(s) estimated as likes × {INSTAGRAM_VIEWS_PER_LIKE}.")

    posts, creator_baseline = score_posts(raw, outlier_threshold)
    for p in posts:
        p["blueprint_id"], p["decompile_error"] = None, None

    with SessionLocal() as s:
        scan = CreatorScan(creator_handle=handle, platform=platform, profile_url=profile_url, niche=niche,
                           last_n=last_n, outlier_threshold=outlier_threshold,
                           creator_baseline=creator_baseline, posts=[], warnings=warnings)
        s.add(scan)
        s.commit()
        scan_id = scan.id

    outliers = [p for p in posts if p["is_outlier"]]
    blueprints: list[dict] = []
    with tempfile.TemporaryDirectory(prefix="atpe_outliers_") as tmp:
        for k, post in enumerate(outliers):
            span0 = 0.1 + 0.85 * k / max(1, len(outliers))
            span1 = 0.1 + 0.85 * (k + 1) / max(1, len(outliers))
            label = f"Decompiling outlier {k + 1}/{len(outliers)} ({post['outlier_score']}x)"
            try:
                progress(span0, f"{label}: downloading")
                path = fetch(post["webpage_url"], Path(tmp), cookies_from_browser)
                tel = extract_telemetry(
                    path, run_asr=run_asr,
                    progress=lambda p, stage, a=span0, b=span1: progress(a + 0.15 * (b - a) + 0.85 * (b - a) * p, f"{label}: {stage}"),
                )
                with SessionLocal() as s:
                    row = upsert_blueprint(s, post, tel, handle, platform, niche, scan_id)
                    s.commit()
                    post["blueprint_id"] = row.id
                    blueprints.append(row.full())
                if tel.get("asr_error"):
                    warnings.append(f"{post['video_id']}: transcription skipped ({tel['asr_error']}).")
            except Exception as exc:  # noqa: BLE001 — one bad video shouldn't sink the scan
                post["decompile_error"] = f"{type(exc).__name__}: {exc}"
                warnings.append(f"{post['video_id']}: decompile failed ({post['decompile_error']}).")
            finally:
                for f in Path(tmp).glob("*"):
                    f.unlink(missing_ok=True)  # temporary: never keep competitor media

    with SessionLocal() as s:
        scan = s.get(CreatorScan, scan_id)
        scan.posts = to_jsonable(posts)
        scan.warnings = warnings
        scan.outlier_count = len(outliers)
        s.commit()
        result = scan.full()

    progress(1.0, "Done")
    return to_jsonable({**result, "channel": meta.get("channel"), "blueprints": blueprints})


# ----------------------------------------------------------------------------------
# Golden targets + draft delta
# ----------------------------------------------------------------------------------

TARGET_FIELDS = {
    # target name: (column, statistic)
    "target_cuts_per_minute": ("cuts_per_minute", "median"),
    "target_avg_shot_length_sec": ("avg_shot_length_sec", "median"),
    "target_first_cut_before_sec": ("first_cut_timestamp_sec", "median"),
    "target_max_audio_latency_ms": ("audio_onset_latency_ms", "p75"),  # most outliers hit by this
    "target_hook_optical_flow": ("hook_optical_flow_score", "median"),
    "target_speaking_wpm": ("speaking_wpm", "median"),
}


def golden_targets(
    s: Session | None = None,
    niche: str | None = None,
    creator: str | None = None,
    min_score: float = 10.0,
) -> dict[str, Any]:
    """Robust aggregates over stored blueprints: medians, and the 75th percentile for the
    audio-latency ceiling. Each target also reports its p25–p75 spread and sample size."""
    own = s is None
    s = s or SessionLocal()
    try:
        q = select(ViralBlueprint).where(ViralBlueprint.outlier_score >= min_score)
        if niche:
            q = q.where(ViralBlueprint.niche == niche)
        if creator:
            q = q.where(ViralBlueprint.creator_handle == normalize_handle(creator))
        rows = list(s.scalars(q))
    finally:
        if own:
            s.close()

    targets: dict[str, float | None] = {}
    spread: dict[str, dict[str, Any]] = {}
    for name, (col, stat) in TARGET_FIELDS.items():
        vals = np.array([v for v in (getattr(row, col) for row in rows) if v is not None], dtype=float)
        if vals.size == 0:
            targets[name] = None
            spread[name] = {"p25": None, "p75": None, "n": 0}
            continue
        value = float(np.percentile(vals, 75)) if stat == "p75" else float(np.median(vals))
        targets[name] = r(value, 2)
        spread[name] = {"p25": r(float(np.percentile(vals, 25)), 2), "p75": r(float(np.percentile(vals, 75)), 2),
                        "n": int(vals.size)}
    return {
        "sample_size": len(rows),
        "niche": niche,
        "creator": creator,
        "min_score": min_score,
        "targets": targets,
        "spread": spread,
        "creators": sorted({row.creator_handle for row in rows}),
    }


def niche_delta(draft: dict[str, Any], golden: dict[str, Any]) -> dict[str, Any]:
    """Compares draft telemetry (from extract_telemetry) with golden targets and writes
    one concrete instruction per metric."""
    t = golden.get("targets") or {}
    n = golden.get("sample_size", 0)
    if not n:
        return {"available": False, "sample_size": 0, "score": None, "metrics": [], "messages": []}
    duration = float(draft.get("duration_sec") or 0.0)
    metrics: list[dict[str, Any]] = []

    def add(metric: str, label: str, value, target, direction: str, unit: str, closeness: float | None,
            ok: bool | None, message: str) -> None:
        if ok:
            closeness = 1.0  # on target counts in full; partial credit is for misses
        metrics.append({"metric": metric, "label": label, "draft": r(value, 2), "target": r(target, 2),
                        "direction": direction, "unit": unit, "pass": ok, "closeness": r(closeness, 3),
                        "gap": r(None if value is None or target is None else value - target, 2), "message": message})

    # First cut (lower is better)
    target = t.get("target_first_cut_before_sec")
    if target is not None:
        first = draft.get("first_cut_timestamp_sec")
        if first is None:
            add("first_cut", "First cut", None, target, "lower", "s", 0.0, False,
                f"No cuts at all; 10x outliers in your database cut by {target:.1f}s. Add a cut before {target:.1f}s.")
        else:
            ok = first <= target
            msg = (f"First cut at {first:.1f}s, inside the {target:.1f}s outlier target."
                   if ok else f"Your first cut is at {first:.1f}s; 10x outliers in your database cut at {target:.1f}s — "
                              f"trim {first - target:.1f}s from shot 1.")
            add("first_cut", "First cut", first, target, "lower", "s", 1.0 if ok else target / first, ok, msg)

    # Cuts per minute (higher is better)
    target = t.get("target_cuts_per_minute")
    if target:
        cpm = float(draft.get("cuts_per_minute") or 0.0)
        ok = cpm >= target * 0.9
        need = max(0, math.ceil((target - cpm) * duration / 60.0))
        msg = (f"{cpm:.0f} cuts/min matches the outlier pace ({target:.0f}/min)."
               if ok else f"You cut {cpm:.0f}×/min; outliers cut {target:.0f}×/min — add ~{need} cut{'s' if need != 1 else ''}.")
        add("cuts_per_minute", "Cuts per minute", cpm, target, "higher", "/min", min(1.0, cpm / target), ok, msg)

    # Average shot length (lower is better)
    target = t.get("target_avg_shot_length_sec")
    if target:
        shot = float(draft.get("avg_shot_length_sec") or duration)
        ok = shot <= target * 1.1
        msg = (f"Average shot {shot:.1f}s, on target." if ok
               else f"Shots average {shot:.1f}s vs {target:.1f}s for outliers — split your longest shot "
                    f"({draft.get('max_static_gap_sec', shot):.1f}s) first.")
        add("avg_shot_length", "Avg shot length", shot, target, "lower", "s", min(1.0, target / max(shot, 1e-6)), ok, msg)

    # Audio onset latency (lower is better)
    target = t.get("target_max_audio_latency_ms")
    if target is not None:
        lat = draft.get("audio_onset_latency_ms")
        if lat is None:
            add("audio_latency", "Audio onset", None, target, "lower", "ms", 0.0, False,
                f"No audio hit detected; outliers hit within {target:.0f} ms.")
        else:
            ok = lat <= target
            msg = (f"First audio hit at {lat:.0f} ms, within the {target:.0f} ms outlier ceiling." if ok
                   else f"First audio hit at {lat:.0f} ms; outliers hit by {target:.0f} ms — trim {lat - target:.0f} ms of lead-in.")
            add("audio_latency", "Audio onset", lat, target, "lower", "ms",
                1.0 if ok else max(0.0, 1.0 - (lat - target) / 600.0), ok, msg)

    # Hook optical flow (higher is better)
    target = t.get("target_hook_optical_flow")
    if target:
        flow = float(draft.get("hook_optical_flow_score") or 0.0)
        ok = flow >= target * 0.85
        msg = (f"Hook motion {flow:.0f}/100 matches outliers ({target:.0f}/100)." if ok
               else f"Hook motion {flow:.0f}/100 vs {target:.0f}/100 for outliers — open on movement, a push-in or a cut.")
        add("hook_flow", "Hook motion (0–1.7s)", flow, target, "higher", "/100", min(1.0, flow / target), ok, msg)

    # Speaking pace (match within 15 %)
    target = t.get("target_speaking_wpm")
    if target:
        wpm = draft.get("speaking_wpm")
        if wpm is None:
            add("wpm", "Speaking pace", None, target, "match", "wpm", None, None,
                f"No speech measured; outliers speak at {target:.0f} WPM.")
        else:
            diff = (wpm - target) / target
            ok = abs(diff) <= 0.15
            msg = (f"{wpm:.0f} WPM, in line with outliers ({target:.0f})." if ok
                   else f"{wpm:.0f} WPM is {abs(diff) * 100:.0f}% {'slower' if diff < 0 else 'faster'} than outliers "
                        f"({target:.0f} WPM){' — tighten pauses or speed delivery' if diff < 0 else ''}.")
            add("wpm", "Speaking pace", wpm, target, "match", "wpm", max(0.0, 1.0 - abs(diff)), ok, msg)

    scored = [m["closeness"] for m in metrics if m["closeness"] is not None]
    return to_jsonable({
        "available": True,
        "sample_size": n,
        "niche": golden.get("niche"),
        "score": r(100.0 * float(np.mean(scored)), 1) if scored else None,
        "metrics": metrics,
        "messages": [m["message"] for m in metrics if m["pass"] is False],
        "targets": t,
        "draft_telemetry": {k: draft.get(k) for k in (
            "first_cut_timestamp_sec", "cuts_per_minute", "avg_shot_length_sec", "max_static_gap_sec",
            "audio_onset_latency_ms", "hook_optical_flow_score", "speaking_wpm")},
    })


_HANDLE_RE = re.compile(r"^[A-Za-z0-9._]{1,60}$")


def validate_handle(handle: str) -> str:
    h = normalize_handle(handle)
    if not _HANDLE_RE.match(h):
        raise ValueError(f"{handle!r} doesn't look like a TikTok/Instagram handle")
    return h
