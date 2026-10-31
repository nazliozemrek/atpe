"""Central configuration for ATPE. Every threshold the pipeline uses lives here so it
can be tuned per niche without touching analysis code. Override any value with an
environment variable of the same name prefixed with ATPE_ (e.g. ATPE_WHISPER_MODEL=small).
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path


def _env(name: str, default):
    raw = os.environ.get(f"ATPE_{name}")
    if raw is None:
        return default
    if isinstance(default, bool):
        return raw.strip().lower() in {"1", "true", "yes", "on"}
    return type(default)(raw)


BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = Path(_env("DATA_DIR", str(BASE_DIR / "data")))
UPLOAD_DIR = DATA_DIR / "uploads"
REFERENCE_DIR = DATA_DIR / "references"
EXPORT_DIR = DATA_DIR / "exports"
PREVIEW_DIR = DATA_DIR / "previews"
DB_PATH = DATA_DIR / "atpe.sqlite3"

for _d in (DATA_DIR, UPLOAD_DIR, REFERENCE_DIR, EXPORT_DIR, PREVIEW_DIR):
    _d.mkdir(parents=True, exist_ok=True)


@dataclass(frozen=True)
class AnalysisConfig:
    # --- Decoding ---------------------------------------------------------------
    analysis_width: int = _env("ANALYSIS_WIDTH", 270)       # optical flow runs on this width
    motion_sample_fps: float = _env("MOTION_SAMPLE_FPS", 15.0)
    audio_sr: int = _env("AUDIO_SR", 22050)
    whisper_sr: int = 16000

    # --- 1.7 s hook gate ----------------------------------------------------------
    hook_window_s: float = 1.7
    hook_frames: int = 50
    dark_luma: float = 40.0              # mean luma (0-255) below this = dark opening frame
    flat_luma_std: float = 18.0          # luma std below this = flat / low-detail frame
    static_flow_px_s: float = 8.0        # flow (px/s at analysis_width) below this = static
    strong_flow_px_s: float = 60.0       # flow at which motion credit saturates
    dead_air_ms: float = 150.0           # audio latency tolerated before penalty
    dead_air_zero_ms: float = 750.0      # audio latency at which audio credit hits 0
    silence_dbfs: float = -45.0          # absolute floor for "sound present"
    silence_rel_db: float = 35.0         # or this far below the file's peak RMS
    ocr_times_s: tuple = (0.5, 1.2)
    ocr_min_conf: float = 0.35
    ocr_min_text_height: float = 0.025   # text box height / frame height for legibility
    ocr_good_contrast: float = 4.5       # WCAG contrast ratio
    hook_weights: dict = field(default_factory=lambda: {"visual": 40.0, "audio": 35.0, "text": 25.0})

    # --- Pacing / retention ---------------------------------------------------------
    stagnation_s: float = 2.5
    stagnation_flow_px_s: float = 14.0
    stagnation_hist_delta: float = 0.06  # 1 - histogram correlation between samples
    pause_gap_s: float = 0.4
    timeline_bin_s: float = 0.25
    scene_detector_threshold: float = 3.0  # AdaptiveDetector adaptive_threshold
    scene_min_scene_len_frames: int = 6

    # --- Loop ------------------------------------------------------------------------
    loop_window_s: float = 0.5
    loop_search_s: float = 1.5           # how far back from the end to search for a cut
    loop_word_pad_s: float = 0.06        # never cut closer than this after a word ends

    # --- Optimizer ------------------------------------------------------------------
    trim_silence_ms: float = 350.0
    trim_head_pad_ms: float = 40.0
    trim_tail_pad_ms: float = 80.0
    target_width: int = 1080
    target_height: int = 1920
    max_fps: float = 60.0
    target_lufs: float = -14.0
    target_true_peak: float = -1.0
    target_lra: float = 11.0
    video_crf: int = _env("VIDEO_CRF", 17)
    video_maxrate: str = _env("VIDEO_MAXRATE", "25M")
    video_bufsize: str = _env("VIDEO_BUFSIZE", "50M")
    audio_bitrate: str = "320k"
    x264_preset: str = _env("X264_PRESET", "slow")

    # --- Models ----------------------------------------------------------------------
    whisper_model: str = _env("WHISPER_MODEL", "base")
    whisper_device: str = _env("WHISPER_DEVICE", "cpu")
    whisper_compute_type: str = _env("WHISPER_COMPUTE_TYPE", "int8")
    ocr_languages: tuple = tuple(_env("OCR_LANGS", "en").split(","))
    ocr_gpu: bool = _env("OCR_GPU", False)


CONFIG = AnalysisConfig()

CORS_ORIGINS = [o.strip() for o in _env("CORS_ORIGINS", "http://localhost:3000,http://127.0.0.1:3000").split(",")]
WORKER_THREADS = _env("WORKER_THREADS", 2)
