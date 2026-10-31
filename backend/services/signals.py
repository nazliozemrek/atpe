"""Signal-level primitives: one decode pass over the frames, audio envelopes and onsets,
shot boundaries, ASR with word timestamps, and OCR with contrast measurement.

Units used throughout:
- motion: mean Farneback optical-flow magnitude in pixels per second, measured at
  CONFIG.analysis_width (so the same motion reads the same at 720p and 4K)
- audio level: dBFS of a short-window RMS (full-scale square wave = 0 dBFS)
- histogram delta: 1 - correlation of normalised HSV (H x S) histograms, 0 = identical
"""
from __future__ import annotations

import threading
from collections import deque
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

import cv2
import numpy as np

from config import CONFIG, AnalysisConfig
from services.media import MediaInfo

ProgressFn = Callable[[float, str], None]


def _noop(_p: float, _s: str) -> None:
    return None


# ----------------------------------------------------------------------------------
# Frame scan
# ----------------------------------------------------------------------------------

@dataclass
class FrameSample:
    t: float
    flow_px_s: float
    luma_mean: float
    luma_std: float
    hist_delta: float
    frame_diff: float


@dataclass
class HeadFrame:
    t: float
    gray: np.ndarray
    hist: np.ndarray
    luma_mean: float
    luma_std: float
    flow_px_s: float          # flow from the previous frame (0 for frame 0)
    frame_diff: float


@dataclass
class TailFrame:
    t: float
    gray: np.ndarray
    hist: np.ndarray


@dataclass
class FrameScan:
    fps: float
    frames_read: int
    duration_s: float
    analysis_size: tuple[int, int]
    samples: list[FrameSample] = field(default_factory=list)
    head: list[HeadFrame] = field(default_factory=list)
    tail: list[TailFrame] = field(default_factory=list)
    stills: dict[float, np.ndarray] = field(default_factory=dict)  # full-res BGR for OCR

    def sample_arrays(self) -> dict[str, np.ndarray]:
        return {
            "t": np.array([s.t for s in self.samples], dtype=np.float64),
            "flow": np.array([s.flow_px_s for s in self.samples], dtype=np.float64),
            "luma": np.array([s.luma_mean for s in self.samples], dtype=np.float64),
            "hist_delta": np.array([s.hist_delta for s in self.samples], dtype=np.float64),
            "diff": np.array([s.frame_diff for s in self.samples], dtype=np.float64),
        }


def hsv_hist(bgr_small: np.ndarray) -> np.ndarray:
    hsv = cv2.cvtColor(bgr_small, cv2.COLOR_BGR2HSV)
    hist = cv2.calcHist([hsv], [0, 1], None, [30, 32], [0, 180, 0, 256])
    cv2.normalize(hist, hist, alpha=1.0, beta=0.0, norm_type=cv2.NORM_L1)
    return hist


def hist_similarity(a: np.ndarray, b: np.ndarray) -> float:
    """Histogram correlation mapped to [0, 1]."""
    return float(max(0.0, cv2.compareHist(a.astype(np.float32), b.astype(np.float32), cv2.HISTCMP_CORREL)))


def gray_similarity(a: np.ndarray, b: np.ndarray) -> float:
    """Normalised cross-correlation of two grayscale frames, mapped to [0, 1]."""
    if a.shape != b.shape:
        b = cv2.resize(b, (a.shape[1], a.shape[0]), interpolation=cv2.INTER_AREA)
    av = a.astype(np.float64).ravel()
    bv = b.astype(np.float64).ravel()
    av -= av.mean()
    bv -= bv.mean()
    denom = np.sqrt((av * av).sum() * (bv * bv).sum())
    if denom < 1e-9:
        # Two flat frames: similar if their brightness matches.
        return float(1.0 - min(1.0, abs(float(a.mean()) - float(b.mean())) / 64.0))
    return float(max(0.0, (av * bv).sum() / denom))


def _flow_magnitude(prev: np.ndarray, cur: np.ndarray) -> float:
    flow = cv2.calcOpticalFlowFarneback(
        prev, cur, None,
        pyr_scale=0.5, levels=3, winsize=15, iterations=3, poly_n=5, poly_sigma=1.2, flags=0,
    )
    mag = np.sqrt(flow[..., 0] ** 2 + flow[..., 1] ** 2)
    return float(mag.mean())


def scan_frames(
    path: str | Path,
    info: MediaInfo,
    cfg: AnalysisConfig = CONFIG,
    still_times: tuple[float, ...] = (),
    head_s: float | None = None,
    tail_s: float | None = None,
    progress: ProgressFn = _noop,
    progress_span: tuple[float, float] = (0.0, 1.0),
) -> FrameScan:
    """Decodes every frame once.

    - Every frame inside `head_s` is kept at full rate with per-frame flow (hook gate).
    - Every frame inside the final `tail_s` is kept in a ring buffer (loop search).
    - Flow / luma / histogram samples are taken at ~cfg.motion_sample_fps for the
      whole file (pacing and stagnation).
    - Full-resolution stills are kept for the requested timestamps (OCR).
    """
    head_s = cfg.hook_window_s if head_s is None else head_s
    tail_s = (cfg.loop_search_s + cfg.loop_window_s) if tail_s is None else tail_s
    fps = info.fps if info.fps > 0 else 30.0
    stride = max(1, int(round(fps / cfg.motion_sample_fps)))
    aw = cfg.analysis_width
    ah = int(round(aw * info.height / max(1, info.width))) // 2 * 2 or aw

    cap = cv2.VideoCapture(str(path))
    if not cap.isOpened():
        raise RuntimeError(f"OpenCV could not open {path}")
    # OpenCV >= 4.5 auto-rotates using container metadata; keep it explicit.
    cap.set(cv2.CAP_PROP_ORIENTATION_AUTO, 1)

    scan = FrameScan(fps=fps, frames_read=0, duration_s=info.duration_s, analysis_size=(aw, ah))
    tail_len = max(2, int(np.ceil(tail_s * fps)) + 2)
    tail_buf: deque[TailFrame] = deque(maxlen=tail_len)
    pending_stills = sorted(still_times)
    best_still: dict[float, tuple[float, np.ndarray]] = {}

    prev_head_gray = None
    prev_sample_gray = None
    prev_sample_hist = None
    idx = 0
    total = max(1, info.nb_frames)
    p0, p1 = progress_span

    while True:
        ok, frame = cap.read()
        if not ok or frame is None:
            break
        t = idx / fps

        for st in pending_stills:
            # keep the decoded frame closest to each requested still time
            d = abs(t - st)
            if d < 1.0 and (st not in best_still or d < best_still[st][0]):
                best_still[st] = (d, frame.copy())

        small = cv2.resize(frame, (aw, ah), interpolation=cv2.INTER_AREA)
        gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
        hist = hsv_hist(small)

        if t < head_s:
            flow = 0.0
            diff = 0.0
            if prev_head_gray is not None:
                flow = _flow_magnitude(prev_head_gray, gray) * fps
                diff = float(np.mean(cv2.absdiff(prev_head_gray, gray))) / 255.0
            scan.head.append(HeadFrame(
                t=t, gray=gray, hist=hist,
                luma_mean=float(gray.mean()), luma_std=float(gray.std()),
                flow_px_s=flow, frame_diff=diff,
            ))
            prev_head_gray = gray

        if idx % stride == 0:
            if prev_sample_gray is None:
                flow_s, hd, diff_s = 0.0, 0.0, 0.0
            else:
                flow_s = _flow_magnitude(prev_sample_gray, gray) * fps / stride
                hd = 1.0 - hist_similarity(prev_sample_hist, hist)
                diff_s = float(np.mean(cv2.absdiff(prev_sample_gray, gray))) / 255.0
            scan.samples.append(FrameSample(
                t=t, flow_px_s=flow_s, luma_mean=float(gray.mean()), luma_std=float(gray.std()),
                hist_delta=hd, frame_diff=diff_s,
            ))
            prev_sample_gray, prev_sample_hist = gray, hist

        tail_buf.append(TailFrame(t=t, gray=gray, hist=hist))
        idx += 1
        if idx % 30 == 0:
            progress(p0 + (p1 - p0) * min(1.0, idx / total), "Scanning frames")

    cap.release()
    if idx == 0:
        raise RuntimeError("No frames could be decoded")

    scan.frames_read = idx
    # Container duration can include a trailing audio tail; frames are what's on screen.
    scan.duration_s = min(info.duration_s, idx / fps) if idx / fps > 0.5 else info.duration_s
    scan.tail = [f for f in tail_buf if f.t >= (idx / fps) - tail_s - 1e-6]
    scan.stills = {st: fr for st, (_, fr) in best_still.items()}
    return scan


# ----------------------------------------------------------------------------------
# Audio
# ----------------------------------------------------------------------------------

def rms_db(audio: np.ndarray, sr: int, hop_s: float = 0.01, frame_s: float = 0.03) -> tuple[np.ndarray, np.ndarray]:
    """Short-window RMS level in dBFS. Returns (times, db)."""
    import librosa

    if audio.size == 0:
        return np.zeros(0), np.zeros(0)
    hop = max(1, int(round(hop_s * sr)))
    frame = max(hop * 2, int(round(frame_s * sr)))
    rms = librosa.feature.rms(y=audio, frame_length=frame, hop_length=hop, center=True)[0]
    db = 20.0 * np.log10(np.maximum(rms, 1e-10)) + 3.0103  # +3 dB: sine RMS -> peak-referenced dBFS
    db = np.maximum(db, -90.0)  # digital silence would otherwise read as -197 dBFS
    times = librosa.frames_to_time(np.arange(len(db)), sr=sr, hop_length=hop)
    return times, db


def sound_threshold(db: np.ndarray, cfg: AnalysisConfig = CONFIG) -> float:
    if db.size == 0:
        return cfg.silence_dbfs
    peak = float(np.percentile(db, 99.5))
    return max(cfg.silence_dbfs, peak - cfg.silence_rel_db)


def sound_bounds(times: np.ndarray, db: np.ndarray, cfg: AnalysisConfig = CONFIG, min_run_s: float = 0.03) -> tuple[float | None, float | None]:
    """First and last moment the level stays above the sound threshold for min_run_s."""
    if db.size == 0:
        return None, None
    thr = sound_threshold(db, cfg)
    above = db > thr
    hop = float(times[1] - times[0]) if len(times) > 1 else 0.01
    run = max(1, int(round(min_run_s / hop)))
    if run > 1:
        kernel = np.ones(run, dtype=int)
        sustained = np.convolve(above.astype(int), kernel, mode="valid") >= run
        if not sustained.any():
            return None, None
        first_i = int(np.argmax(sustained))
        last_i = int(len(sustained) - 1 - np.argmax(sustained[::-1])) + run - 1
    else:
        if not above.any():
            return None, None
        first_i = int(np.argmax(above))
        last_i = int(len(above) - 1 - np.argmax(above[::-1]))
    return float(times[first_i]), float(times[min(last_i, len(times) - 1)])


def strong_onsets(audio: np.ndarray, sr: int, cfg: AnalysisConfig = CONFIG) -> list[float]:
    """Onset times (backtracked to the transient start) whose level clears the sound
    threshold, i.e. real hits rather than noise-floor wiggles."""
    import librosa

    if audio.size < sr // 10:
        return []
    hop = 256
    env = librosa.onset.onset_strength(y=audio, sr=sr, hop_length=hop)
    frames = librosa.onset.onset_detect(onset_envelope=env, sr=sr, hop_length=hop, backtrack=True, units="frames")
    if len(frames) == 0:
        return []
    times = librosa.frames_to_time(frames, sr=sr, hop_length=hop)
    t_db, db = rms_db(audio, sr)
    thr = sound_threshold(db, cfg)
    out = []
    for t in times:
        # level in the 60 ms after the transient start
        m = (t_db >= t) & (t_db <= t + 0.06)
        if m.any() and float(db[m].max()) > thr:
            out.append(float(t))
    return out


def energy_curve(audio: np.ndarray, sr: int, step_s: float = 0.1) -> list[dict]:
    """RMS dBFS envelope on a fixed grid (the decompiler's 100 ms curve)."""
    if audio.size == 0:
        return []
    times, db = rms_db(audio, sr, hop_s=step_s, frame_s=step_s)
    return [{"t": round(float(t), 3), "db": round(float(max(d, -90.0)), 2)} for t, d in zip(times, db)]


# ----------------------------------------------------------------------------------
# Shots
# ----------------------------------------------------------------------------------

def detect_cuts(path: str | Path, cfg: AnalysisConfig = CONFIG) -> list[float]:
    """Hard and fast-dissolve cut times in seconds (PySceneDetect AdaptiveDetector)."""
    from scenedetect import AdaptiveDetector, detect

    scenes = detect(
        str(path),
        AdaptiveDetector(
            adaptive_threshold=cfg.scene_detector_threshold,
            min_scene_len=cfg.scene_min_scene_len_frames,
        ),
        show_progress=False,
    )
    def seconds(tc) -> float:
        # PySceneDetect 0.7 exposes `.seconds`; 0.6 only had get_seconds().
        return float(tc.seconds if hasattr(type(tc), "seconds") else tc.get_seconds())

    return [seconds(start) for start, _end in scenes[1:]]


# ----------------------------------------------------------------------------------
# ASR
# ----------------------------------------------------------------------------------

_whisper_model = None
_whisper_lock = threading.Lock()


def _whisper():
    global _whisper_model
    if _whisper_model is None:
        from faster_whisper import WhisperModel

        _whisper_model = WhisperModel(
            CONFIG.whisper_model, device=CONFIG.whisper_device, compute_type=CONFIG.whisper_compute_type
        )
    return _whisper_model


def transcribe(audio_16k: np.ndarray, language: str | None = None) -> dict:
    """Word-level transcript. `audio_16k` is mono float32 at 16 kHz."""
    if audio_16k.size < 16000 * 0.3:
        return {"language": None, "text": "", "segments": [], "words": []}
    with _whisper_lock:
        model = _whisper()
        segments, info = model.transcribe(
            audio_16k,
            language=language,
            word_timestamps=True,
            vad_filter=False,
            condition_on_previous_text=False,
            beam_size=5,
        )
        segs, words = [], []
        for seg in segments:
            segs.append({"start": round(seg.start, 3), "end": round(seg.end, 3), "text": seg.text.strip()})
            for w in seg.words or []:
                text = w.word.strip()
                if text:
                    words.append({
                        "word": text,
                        "start": round(float(w.start), 3),
                        "end": round(float(w.end), 3),
                        "probability": round(float(w.probability), 3),
                    })
    return {
        "language": info.language,
        "language_probability": round(float(info.language_probability), 3),
        "text": " ".join(s["text"] for s in segs).strip(),
        "segments": segs,
        "words": words,
    }


# ----------------------------------------------------------------------------------
# OCR
# ----------------------------------------------------------------------------------

_ocr_reader = None
_ocr_lock = threading.Lock()


def _reader():
    global _ocr_reader
    if _ocr_reader is None:
        import easyocr

        _ocr_reader = easyocr.Reader(list(CONFIG.ocr_languages), gpu=CONFIG.ocr_gpu, verbose=False)
    return _ocr_reader


def _relative_luminance(v: float) -> float:
    c = v / 255.0
    c = c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4
    return c


def contrast_ratio(gray_region: np.ndarray) -> float:
    """WCAG contrast between the two tone clusters (text vs. background) of a region,
    split with Otsu's threshold."""
    if gray_region.size < 16:
        return 1.0
    region = gray_region.astype(np.uint8)
    thr, _ = cv2.threshold(region, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    lo = region[region <= thr]
    hi = region[region > thr]
    if lo.size == 0 or hi.size == 0:
        return 1.0
    l1 = _relative_luminance(float(np.median(hi)))
    l2 = _relative_luminance(float(np.median(lo)))
    return float((l1 + 0.05) / (l2 + 0.05))


def ocr_frame(frame_bgr: np.ndarray, min_conf: float = CONFIG.ocr_min_conf) -> list[dict]:
    """Text boxes with normalised coordinates, confidence, height ratio and contrast."""
    h, w = frame_bgr.shape[:2]
    # EasyOCR is slow above ~1280 px; detection quality is unchanged at this size.
    scale = min(1.0, 1280.0 / max(h, w))
    img = cv2.resize(frame_bgr, (int(w * scale), int(h * scale)), interpolation=cv2.INTER_AREA) if scale < 1 else frame_bgr
    rgb = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
    with _ocr_lock:
        results = _reader().readtext(rgb, detail=1, paragraph=False)
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    ih, iw = gray.shape[:2]
    out = []
    for pts, text, conf in results:
        if float(conf) < min_conf or not str(text).strip():
            continue
        xs = [p[0] for p in pts]
        ys = [p[1] for p in pts]
        x0, x1 = max(0, int(min(xs))), min(iw, int(max(xs)))
        y0, y1 = max(0, int(min(ys))), min(ih, int(max(ys)))
        if x1 <= x0 or y1 <= y0:
            continue
        out.append({
            "text": str(text).strip(),
            "conf": round(float(conf), 3),
            "box": [round(x0 / iw, 4), round(y0 / ih, 4), round(x1 / iw, 4), round(y1 / ih, 4)],
            "height_ratio": round((y1 - y0) / ih, 4),
            "contrast": round(contrast_ratio(gray[y0:y1, x0:x1]), 2),
        })
    return out


# ----------------------------------------------------------------------------------
# Small numeric helpers
# ----------------------------------------------------------------------------------

def clip01(x: float) -> float:
    return float(min(1.0, max(0.0, x)))


def runs(mask: np.ndarray) -> list[tuple[int, int]]:
    """[start, end) index pairs of consecutive True values."""
    if mask.size == 0:
        return []
    padded = np.concatenate([[False], mask.astype(bool), [False]])
    edges = np.flatnonzero(padded[1:] != padded[:-1])
    return [(int(edges[i]), int(edges[i + 1])) for i in range(0, len(edges), 2)]


def resample(values: np.ndarray, n: int) -> np.ndarray:
    if values.size == 0:
        return np.zeros(n)
    if values.size == 1:
        return np.full(n, float(values[0]))
    x_old = np.linspace(0.0, 1.0, values.size)
    return np.interp(np.linspace(0.0, 1.0, n), x_old, values)


def pearson(a: np.ndarray, b: np.ndarray) -> float | None:
    if a.size < 3 or b.size < 3 or a.size != b.size:
        return None
    if np.std(a) < 1e-9 or np.std(b) < 1e-9:
        return None
    return float(np.corrcoef(a, b)[0, 1])
