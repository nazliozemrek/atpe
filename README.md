# ATPE — Algorithmic Telemetry & Pre-Flight Engine

Local tooling that audits draft short-form videos before posting and benchmarks them
against measured outliers in your niche.

| Page | What it does |
| --- | --- |
| **Pre-Flight** | 1.7 s hook score (optical flow, audio onset latency, OCR text in the safe zone), swipe-risk timeline, pacing, WPM and pauses, loop coefficient with ms trim recommendations, and a **delta vs 10x niche outliers** |
| **Safe Zones & Export** | Synced TikTok / Reels 9:16 players with UI boxes, OCR obstruction checks, one-click export (dead-air trim, loop trim, metadata strip, 1080×1920 H.264, −14 LUFS), captions, hashtags and share prompts |
| **Decompiler** | Turn one reference video (URL or file) into a template and compare a draft against it |
| **Outlier Radar** | Sweep a creator's last N posts, score each against a leave-one-out trimmed baseline, decompile only the 10x+ outliers, and aggregate them into golden targets |

## Setup

Requires Python 3.11+, ffmpeg with libx264, and Node 18.18+.

```bash
./setup.sh --cpu-torch   # drop --cpu-torch if you have an NVIDIA GPU
./dev.sh                 # API on :8000 (docs at /docs), dashboard on :3000
```

Run the backend tests with `cd backend && .venv/bin/python -m pip install -r requirements-dev.txt && .venv/bin/python -m pytest`.

## Outlier scoring

For every post *i* in the sweep, the other posts' views are sorted, the single highest
and lowest are trimmed (when there are ≥ 5), and

```
baseline_i            = max(trimmed_mean, median, 1)
outlier_score_i       = views_i / baseline_i
engagement_velocity_i = (likes + 3·comments + 5·reposts) / views · 1000
```

Only posts at or above the threshold (default 10x) are downloaded, to a temporary folder
that is deleted after decompiling. Golden targets are medians over stored blueprints
(the audio-latency ceiling is the 75th percentile). Every Pre-Flight audit is graded
against them automatically, optionally filtered to one niche.

## Things to know

- **Instagram:** yt-dlp's Instagram *profile* extractor is flagged as broken upstream.
  Paste the creator's Reel URLs into the scanner instead, and pick the browser you're
  logged into Instagram with (`cookies_from_browser`). Views Instagram hides are estimated
  as likes × 18.5 and marked as estimated.
- **Several hits in one sweep raise each other's baselines.** Only the single highest
  value is trimmed, and `max(trimmed_mean, median)` then picks the inflated mean. This
  is deliberately conservative.
- **Cut detection for outliers** uses PySceneDetect's ContentDetector (threshold 27,
  `ATPE_OUTLIER_CONTENT_THRESHOLD`). It can miss a hard cut between two similarly bright,
  saturated shots. Drafts are measured with the same extractor, so deltas stay
  like-for-like.
- **Safe-zone boxes** in `backend/services/safe_zones.py` are measured approximations of
  the current TikTok and Reels players; re-measure them from a screenshot when the apps
  change.
- **Copy engine** is deterministic. Pass `keyword_volumes` (phrase → search volume from
  any keyword tool) to rank keywords by real demand.
- All thresholds live in `backend/config.py` and can be overridden with `ATPE_<NAME>`
  environment variables.
