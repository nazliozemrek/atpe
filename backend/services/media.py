"""Container probing and decoding helpers shared by every module."""
from __future__ import annotations

from dataclasses import asdict, dataclass, field
from fractions import Fraction
from pathlib import Path
from typing import Any

import ffmpeg
import numpy as np


class MediaError(RuntimeError):
    pass


@dataclass
class MediaInfo:
    path: str
    duration_s: float
    fps: float
    width: int            # display width (after rotation)
    height: int           # display height (after rotation)
    rotation: int
    nb_frames: int
    has_audio: bool
    video_codec: str
    audio_codec: str | None
    audio_sample_rate: int | None
    audio_channels: int | None
    bitrate: int | None
    format_name: str
    format_tags: dict[str, str] = field(default_factory=dict)
    stream_tags: list[dict[str, str]] = field(default_factory=list)
    extra_streams: list[str] = field(default_factory=list)

    @property
    def aspect(self) -> float:
        return self.width / self.height if self.height else 0.0

    def as_dict(self) -> dict[str, Any]:
        d = asdict(self)
        d["aspect"] = round(self.aspect, 4)
        return d


def _parse_rate(rate: str | None) -> float:
    if not rate or rate in {"0/0", "0"}:
        return 0.0
    try:
        return float(Fraction(rate))
    except (ValueError, ZeroDivisionError):
        return 0.0


def _rotation(stream: dict) -> int:
    for side in stream.get("side_data_list", []) or []:
        if "rotation" in side:
            return int(round(float(side["rotation"]))) % 360
    tag = (stream.get("tags") or {}).get("rotate")
    return int(tag) % 360 if tag else 0


def probe(path: str | Path) -> MediaInfo:
    path = str(path)
    try:
        data = ffmpeg.probe(path)
    except ffmpeg.Error as exc:
        raise MediaError(f"ffprobe failed: {exc.stderr.decode(errors='ignore') if exc.stderr else exc}") from exc

    streams = data.get("streams", [])
    video = next((s for s in streams if s.get("codec_type") == "video" and not (s.get("disposition") or {}).get("attached_pic")), None)
    if video is None:
        raise MediaError("No video stream found")
    audio = next((s for s in streams if s.get("codec_type") == "audio"), None)
    fmt = data.get("format", {})

    fps = _parse_rate(video.get("avg_frame_rate")) or _parse_rate(video.get("r_frame_rate")) or 30.0
    duration = float(fmt.get("duration") or video.get("duration") or 0.0)
    if duration <= 0:
        raise MediaError("Could not determine duration")
    rotation = _rotation(video)
    w, h = int(video["width"]), int(video["height"])
    if rotation in (90, 270):
        w, h = h, w
    nb = int(video.get("nb_frames") or 0) or int(round(duration * fps))

    return MediaInfo(
        path=path,
        duration_s=duration,
        fps=fps,
        width=w,
        height=h,
        rotation=rotation,
        nb_frames=nb,
        has_audio=audio is not None,
        video_codec=video.get("codec_name", ""),
        audio_codec=audio.get("codec_name") if audio else None,
        audio_sample_rate=int(audio["sample_rate"]) if audio and audio.get("sample_rate") else None,
        audio_channels=int(audio["channels"]) if audio and audio.get("channels") else None,
        bitrate=int(fmt["bit_rate"]) if fmt.get("bit_rate") else None,
        format_name=fmt.get("format_name", ""),
        format_tags={k: str(v) for k, v in (fmt.get("tags") or {}).items()},
        stream_tags=[{k: str(v) for k, v in (s.get("tags") or {}).items()} for s in streams],
        extra_streams=[
            f"{s.get('index')}:{s.get('codec_type')}:{s.get('codec_tag_string') or s.get('codec_name')}"
            for s in streams
            if s.get("codec_type") not in {"video", "audio"}
            or (s.get("codec_type") == "video" and (s.get("disposition") or {}).get("attached_pic"))
        ],
    )


def load_audio(
    path: str | Path,
    sr: int,
    start_s: float | None = None,
    duration_s: float | None = None,
) -> np.ndarray:
    """Decodes the first audio stream to mono float32 PCM in [-1, 1]. Returns an empty
    array when the file has no audio."""
    in_kwargs: dict[str, Any] = {}
    if start_s:
        in_kwargs["ss"] = f"{start_s:.6f}"
    if duration_s:
        in_kwargs["t"] = f"{duration_s:.6f}"
    try:
        out, _ = (
            ffmpeg.input(str(path), **in_kwargs)
            .output("pipe:", format="f32le", acodec="pcm_f32le", ac=1, ar=sr, map="0:a:0")
            .global_args("-nostdin", "-hide_banner", "-loglevel", "error")
            .run(capture_stdout=True, capture_stderr=True)
        )
    except ffmpeg.Error as exc:
        stderr = exc.stderr.decode(errors="ignore") if exc.stderr else ""
        if "matches no streams" in stderr or "does not contain any stream" in stderr:
            return np.zeros(0, dtype=np.float32)
        raise MediaError(f"Audio decode failed: {stderr}") from exc
    return np.frombuffer(out, dtype=np.float32).copy()


def read_frame_at(path: str | Path, t: float):
    """Returns one full-resolution BGR frame at time t (accurate seek via ffmpeg)."""
    import cv2

    info = probe(path)
    t = min(max(0.0, t), max(0.0, info.duration_s - 1.0 / max(info.fps, 1.0)))
    try:
        out, _ = (
            ffmpeg.input(str(path), ss=f"{t:.4f}")
            .output("pipe:", vframes=1, format="image2", vcodec="png")
            .global_args("-nostdin", "-hide_banner", "-loglevel", "error")
            .run(capture_stdout=True, capture_stderr=True)
        )
    except ffmpeg.Error as exc:
        raise MediaError(f"Frame grab failed: {exc.stderr.decode(errors='ignore') if exc.stderr else exc}") from exc
    frame = cv2.imdecode(np.frombuffer(out, dtype=np.uint8), cv2.IMREAD_COLOR)
    if frame is None:
        raise MediaError(f"No frame decoded at {t:.3f}s")
    return frame
