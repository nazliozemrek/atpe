"""Outlier decompiler: scoring math, golden targets, draft delta and the full scan
pipeline (with yt-dlp replaced by local fixture videos)."""
from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest

from services import outlier_decompiler as od


def posts(views: list[int | None], **extra) -> list[dict]:
    return [{"video_id": str(i), "webpage_url": f"https://www.tiktok.com/@x/video/{i}", "views": v,
             "likes": 100, "comments": 10, "reposts": 5, **extra} for i, v in enumerate(views)]


# ---- Stage 2 math ------------------------------------------------------------------

def test_leave_one_out_keeps_a_hit_from_inflating_its_own_baseline():
    views = [2000] * 19 + [500_000]
    scored, creator_baseline = od.score_posts(posts(views))
    hit = scored[-1]
    assert hit["baseline"] == pytest.approx(2000.0)
    assert hit["outlier_score"] == 250.0
    assert hit["is_outlier"]
    # The hit is trimmed out of everyone else's pool, so normal posts stay ~1x.
    assert all(p["outlier_score"] == pytest.approx(1.0) for p in scored[:-1])
    assert creator_baseline == pytest.approx(2000.0)


def test_baseline_formula_matches_spec():
    views = [100, 200, 300, 400, 500, 600, 10_000]
    scored, _ = od.score_posts(posts(views))
    others = sorted(v for v in views if v != 10_000)          # post 6 left out
    trimmed = others[1:-1]
    median = (others[2] + others[3]) / 2                       # 300 and 400
    expected = max(sum(trimmed) / len(trimmed), median, 1.0)
    assert scored[6]["trimmed_mean"] == pytest.approx(sum(trimmed) / len(trimmed))
    assert scored[6]["median"] == pytest.approx(350.0)
    assert scored[6]["baseline"] == pytest.approx(expected)
    assert scored[6]["outlier_score"] == round(10_000 / expected, 2)


def test_small_pools_are_not_trimmed_and_baseline_floor_is_one():
    scored, _ = od.score_posts(posts([0, 0, 0, 50]))
    assert scored[3]["baseline"] == 1.0           # max(mean, median, 1)
    assert scored[3]["outlier_score"] == 50.0


def test_engagement_velocity_weights():
    scored, _ = od.score_posts(posts([1000, 1000, 1000]))
    # (100 + 10*3 + 5*5) / 1000 * 1000
    assert scored[0]["engagement_velocity"] == 155.0


def test_posts_without_views_are_skipped_and_not_pooled():
    scored, _ = od.score_posts(posts([1000, None, 1000, 1000, 1000, 20_000]))
    assert scored[1]["outlier_score"] is None and not scored[1]["is_outlier"]
    assert scored[5]["baseline"] == pytest.approx(1000.0)


def test_instagram_views_fallback_from_likes():
    p = od.post_from_entry({"id": "a", "view_count": 0, "like_count": 200}, "instagram")
    assert p["views"] == 3700 and p["views_estimated"]
    tiktok = od.post_from_entry({"id": "b", "view_count": 0, "like_count": 200}, "tiktok")
    assert tiktok["views"] == 0 and not tiktok["views_estimated"]


def test_profile_urls_and_handles():
    assert od.profile_url_for("@sleepdoc", "tiktok") == "https://www.tiktok.com/@sleepdoc"
    assert od.profile_url_for("sleepdoc", "instagram") == "https://www.instagram.com/sleepdoc/"
    assert od.handle_from_url("https://www.tiktok.com/@sleepdoc?lang=en") == "sleepdoc"
    assert od.detect_platform("https://instagram.com/x/") == "instagram"
    with pytest.raises(ValueError):
        od.detect_platform("https://youtube.com/@x")
    with pytest.raises(ValueError):
        od.validate_handle("not a handle!")
    assert od.canonical_profile_url("https://www.instagram.com/natgeo/reels/") == "https://www.instagram.com/natgeo/"
    assert od.canonical_profile_url("https://www.tiktok.com/@a?lang=en") == "https://www.tiktok.com/@a?lang=en"


def test_post_url_sweep_feeds_the_same_scoring(isolated_db):
    urls = [f"https://www.instagram.com/reel/C{i:02d}/" for i in range(8)]

    def fake_list(u, cookies):
        assert u == urls and cookies == "chrome"
        rows = posts([0, 0, 0, 0, 0, 0, 0, 0])
        for k, row in enumerate(rows):  # Instagram hides views: likes drive the estimate
            row.update(views=None, likes=100 if k else 2000)
            row.update(od.post_from_entry({"id": row["video_id"], "view_count": None, "like_count": row["likes"]}, "instagram"))
        return rows, {"platform": "instagram", "channel": "natgeo", "skipped_errors": []}

    result = od.scan_creator(post_urls=urls, cookies_from_browser="chrome", run_asr=False,
                             sweep_list=fake_list, fetch=lambda *a: (_ for _ in ()).throw(RuntimeError("offline")))
    assert result["creator_handle"] == "natgeo" and result["platform"] == "instagram"
    assert result["profile_url"] == "https://www.instagram.com/natgeo/"
    assert result["posts"][0]["views"] == 37000 and result["posts"][0]["outlier_score"] == 20.0
    assert any("estimated as likes" in w for w in result["warnings"])
    assert result["posts"][0]["decompile_error"] == "RuntimeError: offline"   # failure recorded, scan survives


# ---- Draft delta ---------------------------------------------------------------------

GOLDEN = {
    "sample_size": 4,
    "targets": {
        "target_cuts_per_minute": 30.0,
        "target_avg_shot_length_sec": 1.8,
        "target_first_cut_before_sec": 1.3,
        "target_max_audio_latency_ms": 120.0,
        "target_hook_optical_flow": 50.0,
        "target_speaking_wpm": 180.0,
    },
}


def test_delta_messages_are_concrete():
    draft = {"duration_sec": 30.0, "first_cut_timestamp_sec": 2.8, "cuts_per_minute": 12.0,
             "avg_shot_length_sec": 4.6, "max_static_gap_sec": 7.0, "audio_onset_latency_ms": 590.0,
             "hook_optical_flow_score": 20.0, "speaking_wpm": 140.0}
    d = od.niche_delta(draft, GOLDEN)
    by = {m["metric"]: m for m in d["metrics"]}
    assert d["available"] and d["sample_size"] == 4
    assert by["first_cut"]["message"].startswith("Your first cut is at 2.8s; 10x outliers in your database cut at 1.3s")
    assert "trim 1.5s from shot 1" in by["first_cut"]["message"]
    assert "add ~9 cuts" in by["cuts_per_minute"]["message"]      # (30-12) * 30s / 60
    assert "trim 470 ms of lead-in" in by["audio_latency"]["message"]
    assert not any(m["pass"] for m in d["metrics"])
    assert 0 <= d["score"] < 60


def test_delta_passes_when_on_target_and_unavailable_without_data():
    draft = {"duration_sec": 20.0, "first_cut_timestamp_sec": 0.9, "cuts_per_minute": 33.0,
             "avg_shot_length_sec": 1.7, "max_static_gap_sec": 2.0, "audio_onset_latency_ms": 40.0,
             "hook_optical_flow_score": 61.0, "speaking_wpm": 175.0}
    d = od.niche_delta(draft, GOLDEN)
    assert all(m["pass"] for m in d["metrics"]) and d["score"] == 100.0 and not d["messages"]
    assert od.niche_delta(draft, {"sample_size": 0, "targets": {}})["available"] is False


# ---- Full pipeline with fixtures -----------------------------------------------------

def _make_video(path: Path, cuts: int, lead_silence: float) -> None:
    """9:16 test clip: `cuts + 1` visually distinct shots, a tone after `lead_silence`."""
    shot = 6.0 / (cuts + 1)
    # Alternate dark and bright shots: ContentDetector keys on luma/saturation change.
    colors = ["black", "white", "navy", "yellow", "darkgreen", "white", "black", "cyan"]
    inputs: list[str] = []
    for k in range(cuts + 1):
        inputs += ["-f", "lavfi", "-i", f"testsrc2=s=360x640:r=30:d={shot:.3f}" if k == 0 else
                   f"color=c={colors[k % len(colors)]}:s=360x640:r=30:d={shot:.3f}"]
    n = cuts + 1
    inputs += ["-f", "lavfi", "-i", f"anullsrc=r=22050:cl=mono:d={max(lead_silence, 0.01):.3f}",
               "-f", "lavfi", "-i", "sine=f=440:r=22050:d=6"]
    graph = "".join(f"[{k}:v]" for k in range(n)) + f"concat=n={n}:v=1:a=0[v];[{n}:a][{n + 1}:a]concat=n=2:v=0:a=1[a]"
    subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", *inputs, "-filter_complex", graph,
                    "-map", "[v]", "-map", "[a]", "-t", "6", "-c:v", "libx264", "-pix_fmt", "yuv420p",
                    "-c:a", "aac", str(path)], check=True)


@pytest.fixture()
def isolated_db(tmp_path, monkeypatch):
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker

    import db

    engine = create_engine(f"sqlite:///{tmp_path / 'test.sqlite3'}", connect_args={"check_same_thread": False})
    db.Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine, expire_on_commit=False)
    monkeypatch.setattr(db, "SessionLocal", Session)
    monkeypatch.setattr(od, "SessionLocal", Session)
    return Session


@pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="needs ffmpeg")
def test_scan_creator_decompiles_only_outliers(tmp_path, isolated_db):
    fixtures = tmp_path / "fixtures"
    fixtures.mkdir()
    _make_video(fixtures / "hit.mp4", cuts=3, lead_silence=0.0)
    views = [1500, 1800, 2200, 2000, 1700, 1900, 2100, 2500, 1600, 2300, 90_000]
    sweep_calls = {}

    def fake_sweep(url, last_n, cookies):
        sweep_calls.update(url=url, last_n=last_n, cookies=cookies)
        return posts(views), {"platform": "tiktok", "channel": "Sleep Doc"}

    downloaded: list[str] = []

    def fake_fetch(url, directory, cookies):
        downloaded.append(url)
        dest = directory / "hit.mp4"
        shutil.copy(fixtures / "hit.mp4", dest)
        return dest

    result = od.scan_creator(creator_handle="sleepdoc", platform="tiktok", last_n=11, niche="sleep",
                             run_asr=False, sweep=fake_sweep, fetch=fake_fetch)

    assert sweep_calls == {"url": "https://www.tiktok.com/@sleepdoc", "last_n": 11, "cookies": None}
    assert downloaded == ["https://www.tiktok.com/@x/video/10"]          # only the 10x+ post
    assert len(result["posts"]) == 11 and result["outlier_count"] == 1
    bp = result["blueprints"][0]
    assert bp["outlier_score"] >= 10 and bp["niche"] == "sleep"
    assert bp["total_cuts"] == 3
    assert bp["first_cut_timestamp_sec"] == pytest.approx(1.5, abs=0.1)
    assert bp["audio_onset_latency_ms"] is not None and bp["audio_onset_latency_ms"] <= 50
    assert len(bp["telemetry"]["rms_energy_curve_100ms"]) >= 55
    assert any(p["blueprint_id"] == bp["id"] for p in result["posts"])
    assert not list(Path(tmp_path).glob("atpe_outliers_*"))             # temp media deleted

    golden = od.golden_targets(niche="sleep")
    assert golden["sample_size"] == 1
    assert golden["targets"]["target_first_cut_before_sec"] == pytest.approx(1.5, abs=0.1)

    # Re-scanning upserts instead of duplicating.
    od.scan_creator(creator_handle="sleepdoc", platform="tiktok", last_n=11, niche="sleep",
                    run_asr=False, sweep=fake_sweep, fetch=fake_fetch)
    assert od.golden_targets(niche="sleep")["sample_size"] == 1


@pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="needs ffmpeg")
def test_draft_audit_reports_delta_vs_outliers(tmp_path, isolated_db):
    from services.video_auditor import audit

    _make_video(tmp_path / "draft.mp4", cuts=1, lead_silence=0.6)
    golden = dict(GOLDEN, targets=dict(GOLDEN["targets"], target_first_cut_before_sec=1.3))
    report = audit(tmp_path / "draft.mp4", run_ocr=False, run_asr=False, golden_targets=golden)
    delta = report["niche_delta"]
    by = {m["metric"]: m for m in delta["metrics"]}
    assert delta["available"]
    assert by["first_cut"]["draft"] == pytest.approx(3.0, abs=0.1)
    assert "trim 1.7s from shot 1" in by["first_cut"]["message"]
    assert by["audio_latency"]["draft"] >= 550
    assert any(rec["area"] == "niche" for rec in report["recommendations"])

    skipped = audit(tmp_path / "draft.mp4", run_ocr=False, run_asr=False, golden_targets=None)
    assert skipped["niche_delta"] is None
