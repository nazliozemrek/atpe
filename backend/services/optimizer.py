"""MODULE 3 — FFmpeg Optimizer & Sanitizer.

optimize(path) -> algorithm_ready.mp4:
  1. Micro-dead-air trimmer: removes leading/trailing silence longer than 350 ms (and,
     when an audit is supplied, applies its loop trim so the end flows into frame 0).
  2. Metadata sanitizer: drops container/stream metadata, chapters, data/timecode tracks,
     cover art and the encoder's SEI fingerprint (NLE / CapCut / app tags, GPS, dates).
  3. Delivery encode: 1080x1920, H.264 High (CRF, capped bitrate, 2 s GOP, faststart),
     AAC 320k 48 kHz, two-pass EBU R128 loudness normalisation to -14 LUFS / -1 dBTP.

Plus UI safe-zone tooling: transparent overlay PNGs, an annotated frame preview with
OCR obstruction checks, and a low-res overlay preview video for the dashboard.
"""
from __future__ import annotations

import json
import re
import subprocess
from pathlib import Path
from typing import Any, Literal

import cv2
import ffmpeg
import numpy as np

from config import CONFIG, EXPORT_DIR, PREVIEW_DIR, AnalysisConfig
from services import safe_zones
from services.media import MediaError, MediaInfo, load_audio, probe, read_frame_at
from services.signals import ProgressFn, ocr_frame, rms_db, sound_bounds
from services.utils import r, to_jsonable

FitMode = Literal["pad", "crop"]
STANDARD_RATES = (23.976, 24.0, 25.0, 29.97, 30.0, 50.0, 59.94, 60.0)
FINGERPRINT_TAG = re.compile(
    r"(capcut|edits|premiere|davinci|resolve|final ?cut|imovie|vn|inshot|kinemaster|lavf|lavc|handbrake|"
    r"com\.apple|android|location|gps|creation_time|encoder|comment|description|copyright|author|software|make|model)",
    re.I,
)


def _noop(_p: float, _s: str) -> None:
    return None


# ----------------------------------------------------------------------------------
# Trim points
# ----------------------------------------------------------------------------------

def dead_air_trims(path: str | Path, info: MediaInfo, cfg: AnalysisConfig = CONFIG) -> dict[str, Any]:
    """Silence longer than cfg.trim_silence_ms at the head or tail is cut down to a short pad."""
    if not info.has_audio:
        return {"start_s": 0.0, "end_s": info.duration_s, "head_silence_ms": None, "tail_silence_ms": None}
    audio = load_audio(path, cfg.audio_sr)
    times, db = rms_db(audio, cfg.audio_sr)
    first, last = sound_bounds(times, db, cfg)
    audio_end = min(info.duration_s, audio.size / cfg.audio_sr)
    if first is None or last is None:
        return {"start_s": 0.0, "end_s": info.duration_s, "head_silence_ms": None, "tail_silence_ms": None,
                "note": "No sound above threshold; nothing trimmed."}
    head_ms = first * 1000.0
    tail_ms = (audio_end - last) * 1000.0
    start = max(0.0, first - cfg.trim_head_pad_ms / 1000.0) if head_ms > cfg.trim_silence_ms else 0.0
    end = min(info.duration_s, last + cfg.trim_tail_pad_ms / 1000.0) if tail_ms > cfg.trim_silence_ms else info.duration_s
    return {"start_s": start, "end_s": end, "head_silence_ms": r(head_ms, 0), "tail_silence_ms": r(tail_ms, 0)}


def _output_fps(source: float, cfg: AnalysisConfig, force: float | None) -> float:
    if force:
        return min(force, cfg.max_fps)
    # Frame-rate up-conversion only duplicates frames; keep the source cadence up to the cap.
    target = min(source or 30.0, cfg.max_fps)
    return min(STANDARD_RATES, key=lambda s: abs(s - target))


# ----------------------------------------------------------------------------------
# Loudness
# ----------------------------------------------------------------------------------

def measure_loudness(path: str | Path, start_s: float = 0.0, duration_s: float | None = None,
                     cfg: AnalysisConfig = CONFIG) -> dict[str, float] | None:
    """loudnorm analysis pass. Returns its JSON (input_i, input_tp, input_lra, input_thresh,
    target_offset) or None for silent / audio-less input."""
    cmd = ["ffmpeg", "-nostdin", "-hide_banner", "-ss", f"{start_s:.6f}"]
    if duration_s:
        cmd += ["-t", f"{duration_s:.6f}"]
    cmd += ["-i", str(path), "-map", "0:a:0", "-af",
            f"loudnorm=I={cfg.target_lufs}:TP={cfg.target_true_peak}:LRA={cfg.target_lra}:print_format=json",
            "-f", "null", "-"]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        if "matches no streams" in proc.stderr:
            return None
        raise MediaError(f"Loudness analysis failed: {proc.stderr[-800:]}")
    match = re.search(r"\{[^{}]*\"input_i\"[^{}]*\}", proc.stderr, re.S)
    if not match:
        raise MediaError("Loudness analysis produced no measurement")
    data = json.loads(match.group(0))
    try:
        values = {k: float(v) for k, v in data.items() if k != "normalization_type"}
    except ValueError:
        return None  # "-inf": digital silence
    if not np.isfinite(values.get("input_i", -np.inf)):
        return None
    return values


# ----------------------------------------------------------------------------------
# Video framing
# ----------------------------------------------------------------------------------

def _frame_filters(stream, fit: FitMode, fps: float, cfg: AnalysisConfig):
    w, h = cfg.target_width, cfg.target_height
    if fit == "crop":
        stream = stream.filter("scale", w, h, force_original_aspect_ratio="increase", flags="lanczos",
                               out_color_matrix="bt709").filter("crop", w, h)
    else:
        stream = (stream.filter("scale", w, h, force_original_aspect_ratio="decrease", flags="lanczos",
                                out_color_matrix="bt709")
                  .filter("pad", w, h, "(ow-iw)/2", "(oh-ih)/2", color="black"))
    return stream.filter("setsar", 1).filter("fps", fps=f"{fps:.3f}").filter("format", "yuv420p")


def reframe(frame: np.ndarray, fit: FitMode, cfg: AnalysisConfig = CONFIG) -> np.ndarray:
    """Same framing as the encode, in numpy, so previews and OCR use output coordinates."""
    w, h = cfg.target_width, cfg.target_height
    fh, fw = frame.shape[:2]
    if fit == "crop":
        s = max(w / fw, h / fh)
        resized = cv2.resize(frame, (int(np.ceil(fw * s)), int(np.ceil(fh * s))), interpolation=cv2.INTER_LANCZOS4)
        y0 = (resized.shape[0] - h) // 2
        x0 = (resized.shape[1] - w) // 2
        return resized[y0:y0 + h, x0:x0 + w]
    s = min(w / fw, h / fh)
    nw, nh = int(round(fw * s)), int(round(fh * s))
    resized = cv2.resize(frame, (nw, nh), interpolation=cv2.INTER_LANCZOS4)
    canvas = np.zeros((h, w, 3), dtype=np.uint8)
    y0, x0 = (h - nh) // 2, (w - nw) // 2
    canvas[y0:y0 + nh, x0:x0 + nw] = resized
    return canvas


# ----------------------------------------------------------------------------------
# One-click export
# ----------------------------------------------------------------------------------

def _tags_report(info: MediaInfo) -> dict[str, Any]:
    flagged = {k: v for k, v in info.format_tags.items() if FINGERPRINT_TAG.search(k) or FINGERPRINT_TAG.search(v)}
    stream_flagged = [
        {k: v for k, v in tags.items() if FINGERPRINT_TAG.search(k) or FINGERPRINT_TAG.search(v)}
        for tags in info.stream_tags
    ]
    return {
        "format_tags": info.format_tags,
        "stream_tags": info.stream_tags,
        "fingerprint_tags": flagged,
        "stream_fingerprint_tags": [t for t in stream_flagged if t],
        "extra_streams": info.extra_streams,
    }


def optimize(
    path: str | Path,
    audit_report: dict | None = None,
    output_name: str | None = None,
    trim_dead_air: bool = True,
    apply_loop_trim: bool = True,
    normalize_loudness: bool = True,
    fit: FitMode = "pad",
    force_fps: float | None = None,
    progress: ProgressFn = _noop,
    cfg: AnalysisConfig = CONFIG,
) -> dict[str, Any]:
    path = Path(path)
    progress(0.02, "Probing input")
    info = probe(path)

    start, end = 0.0, info.duration_s
    trims: dict[str, Any] = {}
    if trim_dead_air:
        progress(0.06, "Measuring dead air")
        trims["dead_air"] = dead_air_trims(path, info, cfg)
        start, end = trims["dead_air"]["start_s"], trims["dead_air"]["end_s"]
    if apply_loop_trim and audit_report:
        rec = audit_report["loop"]["recommendation"]
        loop_start = rec["trim_start_ms"] / 1000.0
        analyzed = float(audit_report["media"]["analyzed_duration_s"])
        loop_end = analyzed - rec["trim_end_ms"] / 1000.0
        trims["loop"] = {"start_s": r(loop_start), "end_s": r(loop_end), "reason": rec["reason"]}
        start, end = max(start, loop_start), min(end, loop_end)
    if end - start < 0.5:
        raise MediaError(f"Trims leave only {end - start:.2f}s of video; refusing to export.")

    fps = _output_fps(info.fps, cfg, force_fps)
    loud_in = None
    if info.has_audio and normalize_loudness:
        progress(0.12, "Loudness analysis (pass 1)")
        loud_in = measure_loudness(path, start, end - start, cfg)

    EXPORT_DIR.mkdir(parents=True, exist_ok=True)
    out_path = EXPORT_DIR / (output_name or f"{path.stem}_algorithm_ready.mp4")
    inp = ffmpeg.input(str(path), ss=f"{start:.6f}", t=f"{end - start:.6f}")
    video = _frame_filters(inp.video, fit, fps, cfg)
    streams = [video]
    if info.has_audio:
        audio = inp.audio
        if loud_in is not None:
            audio = audio.filter(
                "loudnorm",
                I=cfg.target_lufs, TP=cfg.target_true_peak, LRA=cfg.target_lra,
                measured_I=loud_in["input_i"], measured_TP=loud_in["input_tp"],
                measured_LRA=loud_in["input_lra"], measured_thresh=loud_in["input_thresh"],
                offset=loud_in["target_offset"], linear="true", print_format="none",
            )
        audio = audio.filter("aresample", 48000, resampler="soxr" if _has_soxr() else "swr")
        streams.append(audio)

    out_kwargs: dict[str, Any] = {
        "vcodec": "libx264",
        "preset": cfg.x264_preset,
        "crf": cfg.video_crf,
        "profile:v": "high",
        "level:v": "4.2",
        "pix_fmt": "yuv420p",
        "maxrate": cfg.video_maxrate,
        "bufsize": cfg.video_bufsize,
        "g": int(round(fps * 2)),
        "keyint_min": int(round(fps)),
        "bf": 2,
        "color_primaries": "bt709",
        "color_trc": "bt709",
        "colorspace": "bt709",
        "color_range": "tv",
        "movflags": "+faststart",
        "map_metadata": -1,
        "map_chapters": -1,
        "fflags": "+bitexact",
        "flags:v": "+bitexact",
        "bsf:v": "filter_units=remove_types=6",  # drop SEI (x264 settings string)
        "metadata:s:v:0": "handler_name=VideoHandler",
        "dn": None,
        "sn": None,
    }
    if info.has_audio:
        out_kwargs.update({"acodec": "aac", "b:a": cfg.audio_bitrate, "ar": 48000, "ac": 2,
                           "flags:a": "+bitexact", "metadata:s:a:0": "handler_name=SoundHandler"})
    else:
        out_kwargs["an"] = None

    cmd = (
        ffmpeg.output(*streams, str(out_path), **out_kwargs)
        .global_args("-nostdin", "-hide_banner", "-loglevel", "error", "-progress", "pipe:1", "-nostats")
        .overwrite_output()
        .compile()
    )
    progress(0.18, "Encoding")
    target_us = (end - start) * 1_000_000
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    assert proc.stdout is not None
    for line in proc.stdout:
        if line.startswith("out_time_us=") or line.startswith("out_time_ms="):
            try:
                done = float(line.split("=", 1)[1])
            except ValueError:
                continue
            progress(0.18 + 0.72 * min(1.0, done / max(target_us, 1.0)), "Encoding")
    stderr = proc.stderr.read() if proc.stderr else ""
    if proc.wait() != 0:
        raise MediaError(f"Encode failed: {stderr[-1500:]}")

    progress(0.93, "Verifying output")
    out_info = probe(out_path)
    loud_out = measure_loudness(out_path, cfg=cfg) if out_info.has_audio else None
    progress(1.0, "Done")
    return to_jsonable({
        "output_path": str(out_path),
        "output_name": out_path.name,
        "size_bytes": out_path.stat().st_size,
        "trim": {"start_s": r(start), "end_s": r(end), "removed_head_ms": r(start * 1000, 0),
                 "removed_tail_ms": r((info.duration_s - end) * 1000, 0), "details": trims},
        "loudness": {
            "target_lufs": cfg.target_lufs,
            "input_lufs": r(loud_in["input_i"], 2) if loud_in else None,
            "input_true_peak": r(loud_in["input_tp"], 2) if loud_in else None,
            "output_lufs": r(loud_out["input_i"], 2) if loud_out else None,
            "output_true_peak": r(loud_out["input_tp"], 2) if loud_out else None,
        },
        "encode": {
            "width": out_info.width, "height": out_info.height, "fps": r(out_info.fps, 3),
            "source_fps": r(info.fps, 3), "fit": fit, "video_codec": out_info.video_codec,
            "audio_codec": out_info.audio_codec, "bitrate": out_info.bitrate,
            "duration_s": r(out_info.duration_s),
        },
        "metadata": {"input": _tags_report(info), "output": _tags_report(out_info)},
    })


_SOXR: bool | None = None


def _has_soxr() -> bool:
    global _SOXR
    if _SOXR is None:
        proc = subprocess.run(["ffmpeg", "-hide_banner", "-buildconf"], capture_output=True, text=True)
        _SOXR = "--enable-libsoxr" in proc.stdout
    return _SOXR


# ----------------------------------------------------------------------------------
# Safe-zone previews
# ----------------------------------------------------------------------------------

ZONE_COLORS = {  # BGR
    "header": (255, 170, 60),
    "ui": (60, 60, 255),
    "caption": (60, 200, 255),
    "ticker": (200, 120, 255),
    "safe": (90, 220, 90),
}


def overlay_rgba(platform: str, cfg: AnalysisConfig = CONFIG, show_safe: bool = True) -> np.ndarray:
    """Transparent 1080x1920 BGRA overlay of the platform UI boxes."""
    w, h = cfg.target_width, cfg.target_height
    layer = np.zeros((h, w, 4), dtype=np.uint8)
    boxes = list(safe_zones.zones(platform))
    for box in boxes:
        x0, y0, x1, y1 = int(box.x0 * w), int(box.y0 * h), int(box.x1 * w), int(box.y1 * h)
        color = ZONE_COLORS.get(box.kind, (255, 255, 255))
        fill = layer[y0:y1, x0:x1]
        fill[..., :3] = color
        fill[..., 3] = 70
        cv2.rectangle(layer, (x0, y0), (x1 - 1, y1 - 1), (*color, 230), 4)
        _label(layer, box.label, x0 + 14, min(y1 - 14, y0 + 44), x1 - x0 - 28)
    if show_safe:
        z = safe_zones.AUDIT_SAFE_ZONE
        x0, y0, x1, y1 = int(z.x0 * w), int(z.y0 * h), int(z.x1 * w), int(z.y1 * h)
        for x in range(x0, x1, 40):  # dashed outline
            cv2.line(layer, (x, y0), (min(x + 20, x1), y0), (*ZONE_COLORS["safe"], 255), 3)
            cv2.line(layer, (x, y1), (min(x + 20, x1), y1), (*ZONE_COLORS["safe"], 255), 3)
        for y in range(y0, y1, 40):
            cv2.line(layer, (x0, y), (x0, min(y + 20, y1)), (*ZONE_COLORS["safe"], 255), 3)
            cv2.line(layer, (x1, y), (x1, min(y + 20, y1)), (*ZONE_COLORS["safe"], 255), 3)
        cv2.putText(layer, "SAFE ZONE", (x0 + 14, y0 + 40), cv2.FONT_HERSHEY_SIMPLEX, 0.9,
                    (*ZONE_COLORS["safe"], 255), 2, cv2.LINE_AA)
    return layer


def _label(layer: np.ndarray, text: str, x: int, y: int, max_w: int) -> None:
    """Draws text that fits max_w: shrinks the font, then drops the parenthetical, then truncates."""
    font = cv2.FONT_HERSHEY_SIMPLEX
    candidates = [text, text.split(" (")[0]]
    for candidate in candidates:
        for scale in (0.95, 0.8, 0.65):
            (w, _), _ = cv2.getTextSize(candidate, font, scale, 2)
            if w <= max_w:
                cv2.putText(layer, candidate, (x, y), font, scale, (255, 255, 255, 255), 2, cv2.LINE_AA)
                return
    short = candidates[-1]
    while len(short) > 3 and cv2.getTextSize(short + "…", font, 0.65, 2)[0][0] > max_w:
        short = short[:-1]
    cv2.putText(layer, short + ".", (x, y), font, 0.65, (255, 255, 255, 255), 2, cv2.LINE_AA)


def overlay_png(platform: str, cfg: AnalysisConfig = CONFIG) -> Path:
    out = PREVIEW_DIR / f"overlay_{platform}.png"
    cv2.imwrite(str(out), overlay_rgba(platform, cfg))
    return out


def _composite(frame: np.ndarray, layer: np.ndarray) -> np.ndarray:
    alpha = layer[..., 3:4].astype(np.float32) / 255.0
    return (frame.astype(np.float32) * (1 - alpha) + layer[..., :3].astype(np.float32) * alpha).astype(np.uint8)


def frame_preview(path: str | Path, t: float, platform: str, fit: FitMode = "pad",
                  run_ocr: bool = True, cfg: AnalysisConfig = CONFIG) -> tuple[bytes, list[dict]]:
    """JPEG of the frame at t, reframed to 1080x1920, with UI boxes and OCR text boxes
    (red where platform UI covers them). Returns (jpeg_bytes, text_boxes)."""
    frame = reframe(read_frame_at(path, t), fit, cfg)
    out = _composite(frame, overlay_rgba(platform, cfg))
    texts: list[dict] = []
    if run_ocr:
        h, w = frame.shape[:2]
        for det in ocr_frame(frame):
            x0, y0, x1, y1 = det["box"]
            hits = safe_zones.obstructions(x0, y0, x1, y1, platform)
            det = {**det, "obstructed_by": hits}
            texts.append(det)
            color = (40, 40, 255) if hits else (80, 230, 80)
            cv2.rectangle(out, (int(x0 * w), int(y0 * h)), (int(x1 * w), int(y1 * h)), color, 5)
    ok, buf = cv2.imencode(".jpg", out, [cv2.IMWRITE_JPEG_QUALITY, 88])
    if not ok:
        raise MediaError("JPEG encode failed")
    return buf.tobytes(), to_jsonable(texts)


def preview_video(path: str | Path, platform: str, fit: FitMode = "pad", cfg: AnalysisConfig = CONFIG,
                  progress: ProgressFn = _noop) -> Path:
    """540x960 preview with the platform overlay burned in, for side-by-side playback."""
    path = Path(path)
    info = probe(path)
    png = overlay_png(platform, cfg)
    out = PREVIEW_DIR / f"{path.stem}_{platform}_{fit}_preview.mp4"
    base = ffmpeg.input(str(path))
    framed = _frame_filters(base.video, fit, min(info.fps or 30.0, 30.0), cfg)
    over = ffmpeg.input(str(png), loop=1, framerate=30)
    composed = ffmpeg.filter([framed, over], "overlay", 0, 0, shortest=1).filter("scale", 540, 960)
    streams = [composed]
    kwargs: dict[str, Any] = {"vcodec": "libx264", "preset": "veryfast", "crf": 26, "pix_fmt": "yuv420p",
                              "movflags": "+faststart", "map_metadata": -1}
    if info.has_audio:
        streams.append(base.audio)
        kwargs.update({"acodec": "aac", "b:a": "128k"})
    progress(0.1, "Rendering overlay preview")
    try:
        (ffmpeg.output(*streams, str(out), **kwargs)
         .global_args("-nostdin", "-hide_banner", "-loglevel", "error")
         .overwrite_output()
         .run(capture_stdout=True, capture_stderr=True))
    except ffmpeg.Error as exc:
        raise MediaError(f"Preview render failed: {exc.stderr.decode(errors='ignore')[-1200:] if exc.stderr else exc}") from exc
    progress(1.0, "Done")
    return out


def obstruction_scan(path: str | Path, platform: str, interval_s: float = 1.0, fit: FitMode = "pad",
                     cfg: AnalysisConfig = CONFIG, progress: ProgressFn = _noop) -> dict[str, Any]:
    """OCR every `interval_s` across the whole video and report text covered by UI."""
    path = Path(path)
    info = probe(path)
    cap = cv2.VideoCapture(str(path))
    if not cap.isOpened():
        raise MediaError(f"OpenCV could not open {path}")
    fps = info.fps or 30.0
    every = max(1, int(round(interval_s * fps)))
    idx = 0
    samples = []
    total = max(1, info.nb_frames)
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        if idx % every == 0:
            t = idx / fps
            texts = []
            for det in ocr_frame(reframe(frame, fit, cfg)):
                hits = safe_zones.obstructions(*det["box"], platform)
                texts.append({**det, "obstructed_by": hits})
            samples.append({"t": r(t), "texts": texts, "obstructed": [x for x in texts if x["obstructed_by"]]})
            progress(min(0.99, idx / total), "Checking text against UI")
        idx += 1
    cap.release()
    blocked = [s for s in samples if s["obstructed"]]
    return to_jsonable({
        "platform": platform,
        "interval_s": interval_s,
        "samples": samples,
        "obstructed_count": len(blocked),
        "obstructed_times": [s["t"] for s in blocked],
        "clean": not blocked,
    })
