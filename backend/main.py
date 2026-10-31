"""ATPE API.

Long-running work (audit, decompile, export, previews) is queued on a thread pool and
returns a job id; poll GET /api/jobs/{id} until status is "done" and read `result`.

Run:  uvicorn main:app --reload --port 8000
"""
from __future__ import annotations

import re
import shutil
import uuid
from pathlib import Path
from typing import Literal

from fastapi import Depends, FastAPI, File, Form, HTTPException, Query, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel, Field, HttpUrl
from sqlalchemy import select
from sqlalchemy.orm import Session

from config import CORS_ORIGINS, PREVIEW_DIR, REFERENCE_DIR, UPLOAD_DIR
from db import AuditLog, ExportJob, Job, SessionLocal, ViralTemplate, get_session, init_db
from jobs import fail_interrupted_jobs, submit
from routers import outlier
from services import copy_engine, decompiler, optimizer, safe_zones, video_auditor
from services.media import MediaError, probe

app = FastAPI(title="ATPE — Algorithmic Telemetry & Pre-Flight Engine", version="1.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.include_router(outlier.router)
VIDEO_TYPES = {".mp4", ".mov", ".m4v", ".webm", ".mkv"}
Platform = Literal["tiktok", "reels"]
Fit = Literal["pad", "crop"]


@app.on_event("startup")
def _startup() -> None:
    init_db()
    fail_interrupted_jobs()


@app.get("/api/jobs/{job_id}")
def get_job(job_id: str, s: Session = Depends(get_session)) -> dict:
    job = s.get(Job, job_id)
    if job is None:
        raise HTTPException(404, "Job not found")
    return job.full()


# ----------------------------------------------------------------------------------
# Helpers
# ----------------------------------------------------------------------------------

def _safe_name(name: str) -> str:
    stem = re.sub(r"[^A-Za-z0-9._-]+", "_", Path(name).stem)[:80] or "video"
    return stem


async def _save_upload(upload: UploadFile, directory: Path) -> Path:
    ext = Path(upload.filename or "").suffix.lower()
    if ext not in VIDEO_TYPES:
        raise HTTPException(415, f"Unsupported file type {ext!r}; use one of {sorted(VIDEO_TYPES)}")
    dest = directory / f"{uuid.uuid4().hex[:10]}_{_safe_name(upload.filename or 'video')}{ext}"
    with dest.open("wb") as fh:
        shutil.copyfileobj(upload.file, fh, length=4 * 1024 * 1024)
    try:
        probe(dest)
    except MediaError as exc:
        dest.unlink(missing_ok=True)
        raise HTTPException(422, f"Not a readable video: {exc}") from exc
    return dest


def _audit_or_404(s: Session, audit_id: int) -> AuditLog:
    audit = s.get(AuditLog, audit_id)
    if audit is None:
        raise HTTPException(404, "Audit not found")
    if not Path(audit.file_path).exists():
        raise HTTPException(410, "The audited file is no longer on disk")
    return audit


def _template_or_404(s: Session, template_id: int) -> ViralTemplate:
    tpl = s.get(ViralTemplate, template_id)
    if tpl is None:
        raise HTTPException(404, "Template not found")
    return tpl


# ----------------------------------------------------------------------------------
# Health / config
# ----------------------------------------------------------------------------------

@app.get("/api/health")
def health() -> dict:
    return {"ok": True, "ffmpeg": shutil.which("ffmpeg") is not None}


@app.get("/api/safe-zones")
def get_safe_zones() -> dict:
    return safe_zones.all_zones()


# ----------------------------------------------------------------------------------
# Module 1: pre-flight audit
# ----------------------------------------------------------------------------------

@app.post("/api/audits", status_code=202)
async def create_audit(
    file: UploadFile = File(...),
    run_ocr: bool = Form(True),
    run_asr: bool = Form(True),
    niche: str | None = Form(None),
) -> dict:
    path = await _save_upload(file, UPLOAD_DIR)
    filename = file.filename or path.name
    niche_key = niche.strip().lower() or None if niche else None

    def work(progress):
        report = video_auditor.audit(path, progress=progress, run_ocr=run_ocr, run_asr=run_asr, niche=niche_key)
        with SessionLocal() as s:
            row = AuditLog(
                filename=filename,
                file_path=str(path),
                duration_s=report["media"]["analyzed_duration_s"],
                hook_score=report["hook"]["score"],
                loop_score=report["loop"]["score"],
                swipe_risk_zones=len(report["swipe_risk_zones"]),
                report=report,
            )
            s.add(row)
            s.commit()
            return {"audit_id": row.id}

    return submit("audit", work)


@app.get("/api/audits")
def list_audits(limit: int = Query(50, le=500), s: Session = Depends(get_session)) -> list[dict]:
    rows = s.scalars(select(AuditLog).order_by(AuditLog.created_at.desc()).limit(limit))
    return [a.summary() for a in rows]


@app.get("/api/audits/{audit_id}")
def get_audit(audit_id: int, s: Session = Depends(get_session)) -> dict:
    audit = s.get(AuditLog, audit_id)
    if audit is None:
        raise HTTPException(404, "Audit not found")
    return audit.full()


@app.delete("/api/audits/{audit_id}", status_code=204)
def delete_audit(audit_id: int, delete_file: bool = True, s: Session = Depends(get_session)) -> Response:
    audit = s.get(AuditLog, audit_id)
    if audit is None:
        raise HTTPException(404, "Audit not found")
    if delete_file:
        Path(audit.file_path).unlink(missing_ok=True)
    s.delete(audit)
    s.commit()
    return Response(status_code=204)


@app.get("/api/audits/{audit_id}/video")
def audit_video(audit_id: int, s: Session = Depends(get_session)) -> FileResponse:
    audit = _audit_or_404(s, audit_id)
    return FileResponse(audit.file_path, media_type="video/mp4", filename=audit.filename)


# ----------------------------------------------------------------------------------
# Module 2: decompiler + benchmark
# ----------------------------------------------------------------------------------

class DecompileRequest(BaseModel):
    url: HttpUrl
    name: str | None = None
    niche: str | None = None


def _store_template(result: dict, name: str | None, niche: str | None, source_url: str | None) -> dict:
    bp = result["blueprint"]
    stats = result["source_stats"]
    with SessionLocal() as s:
        row = ViralTemplate(
            name=name or stats.get("title") or Path(result["path"]).stem,
            niche=niche,
            source_url=source_url,
            platform=result["platform"],
            file_path=result["path"],
            duration_s=bp["duration_s"],
            cuts_per_minute=bp["cut_cadence"]["cuts_per_minute"],
            avg_shot_length_s=bp["cut_cadence"]["avg_shot_length_s"],
            hook_text=bp["hook_structure"]["text"],
            payoff_s=bp["payoff"].get("t"),
            wpm=bp["speech"]["wpm"],
            source_stats=stats,
            blueprint=bp,
        )
        s.add(row)
        s.commit()
        return {"template_id": row.id}


@app.post("/api/templates/from-url", status_code=202)
def decompile_url(body: DecompileRequest) -> dict:
    url = str(body.url)

    def work(progress):
        result = decompiler.decompile(url=url, progress=progress)
        return _store_template(result, body.name, body.niche, url)

    return submit("decompile", work)


@app.post("/api/templates/from-file", status_code=202)
async def decompile_file(
    file: UploadFile = File(...),
    name: str | None = Form(None),
    niche: str | None = Form(None),
) -> dict:
    path = await _save_upload(file, REFERENCE_DIR)

    def work(progress):
        result = decompiler.decompile(file_path=path, progress=progress)
        return _store_template(result, name or Path(file.filename or path.name).stem, niche, None)

    return submit("decompile", work)


@app.get("/api/templates")
def list_templates(niche: str | None = None, s: Session = Depends(get_session)) -> list[dict]:
    q = select(ViralTemplate).order_by(ViralTemplate.created_at.desc())
    if niche:
        q = q.where(ViralTemplate.niche == niche)
    return [t.summary() for t in s.scalars(q)]


@app.get("/api/templates/{template_id}")
def get_template(template_id: int, include_audit: bool = False, s: Session = Depends(get_session)) -> dict:
    tpl = _template_or_404(s, template_id)
    data = tpl.full()
    if not include_audit:
        data["blueprint"] = {k: v for k, v in data["blueprint"].items() if k != "audit"}
    return data


@app.delete("/api/templates/{template_id}", status_code=204)
def delete_template(template_id: int, delete_file: bool = True, s: Session = Depends(get_session)) -> Response:
    tpl = _template_or_404(s, template_id)
    if delete_file:
        Path(tpl.file_path).unlink(missing_ok=True)
    s.delete(tpl)
    s.commit()
    return Response(status_code=204)


@app.get("/api/templates/{template_id}/video")
def template_video(template_id: int, s: Session = Depends(get_session)) -> FileResponse:
    tpl = _template_or_404(s, template_id)
    if not Path(tpl.file_path).exists():
        raise HTTPException(410, "Reference file is no longer on disk")
    return FileResponse(tpl.file_path, media_type="video/mp4")


@app.get("/api/audits/{audit_id}/benchmark/{template_id}")
def benchmark(audit_id: int, template_id: int, s: Session = Depends(get_session)) -> dict:
    audit = s.get(AuditLog, audit_id)
    if audit is None:
        raise HTTPException(404, "Audit not found")
    tpl = _template_or_404(s, template_id)
    return {
        "audit": audit.summary(),
        "template": tpl.summary(),
        "comparison": decompiler.benchmark(audit.report, tpl.blueprint, tpl.name),
    }


# ----------------------------------------------------------------------------------
# Module 3: optimizer, sanitizer, safe-zone previews
# ----------------------------------------------------------------------------------

class OptimizeRequest(BaseModel):
    trim_dead_air: bool = True
    apply_loop_trim: bool = True
    normalize_loudness: bool = True
    fit: Fit = "pad"
    force_fps: float | None = Field(None, gt=0, le=60)


@app.post("/api/audits/{audit_id}/optimize", status_code=202)
def optimize(audit_id: int, body: OptimizeRequest, s: Session = Depends(get_session)) -> dict:
    audit = _audit_or_404(s, audit_id)
    path, report, stem = Path(audit.file_path), audit.report, _safe_name(audit.filename)

    def work(progress):
        result = optimizer.optimize(
            path,
            audit_report=report,
            output_name=f"{stem}_{uuid.uuid4().hex[:6]}_algorithm_ready.mp4",
            trim_dead_air=body.trim_dead_air,
            apply_loop_trim=body.apply_loop_trim,
            normalize_loudness=body.normalize_loudness,
            fit=body.fit,
            force_fps=body.force_fps,
            progress=progress,
        )
        with SessionLocal() as s2:
            row = ExportJob(audit_id=audit_id, input_path=str(path), output_path=result["output_path"], result=result)
            s2.add(row)
            s2.commit()
            return {"export_id": row.id, **{k: v for k, v in result.items() if k != "output_path"}}

    return submit("optimize", work)


@app.get("/api/exports")
def list_exports(audit_id: int | None = None, s: Session = Depends(get_session)) -> list[dict]:
    q = select(ExportJob).order_by(ExportJob.created_at.desc())
    if audit_id is not None:
        q = q.where(ExportJob.audit_id == audit_id)
    return [e.full() for e in s.scalars(q)]


@app.get("/api/exports/{export_id}/download")
def download_export(export_id: int, s: Session = Depends(get_session)) -> FileResponse:
    row = s.get(ExportJob, export_id)
    if row is None or not Path(row.output_path).exists():
        raise HTTPException(404, "Export not found")
    return FileResponse(row.output_path, media_type="video/mp4", filename="algorithm_ready.mp4")


@app.get("/api/safe-zones/{platform}/overlay.png")
def overlay(platform: Platform) -> FileResponse:
    return FileResponse(optimizer.overlay_png(platform), media_type="image/png")


@app.get("/api/audits/{audit_id}/safe-zone-frame")
def safe_zone_frame(
    audit_id: int,
    platform: Platform = "tiktok",
    t: float = Query(1.0, ge=0),
    fit: Fit = "pad",
    ocr: bool = True,
    s: Session = Depends(get_session),
) -> Response:
    audit = _audit_or_404(s, audit_id)
    jpeg, texts = optimizer.frame_preview(audit.file_path, t, platform, fit, run_ocr=ocr)
    blocked = sum(1 for x in texts if x["obstructed_by"])
    return Response(jpeg, media_type="image/jpeg", headers={
        "X-Text-Boxes": str(len(texts)), "X-Obstructed-Boxes": str(blocked),
        "Access-Control-Expose-Headers": "X-Text-Boxes, X-Obstructed-Boxes",
    })


@app.post("/api/audits/{audit_id}/safe-zone-preview", status_code=202)
def safe_zone_preview(audit_id: int, platform: Platform = "tiktok", fit: Fit = "pad",
                      s: Session = Depends(get_session)) -> dict:
    audit = _audit_or_404(s, audit_id)
    path = audit.file_path

    def work(progress):
        out = optimizer.preview_video(path, platform, fit, progress=progress)
        return {"preview": out.name, "url": f"/api/previews/{out.name}"}

    return submit("preview", work)


@app.post("/api/audits/{audit_id}/obstruction-scan", status_code=202)
def obstruction_scan(audit_id: int, platform: Platform = "tiktok", interval_s: float = Query(1.0, gt=0.1, le=10),
                     fit: Fit = "pad", s: Session = Depends(get_session)) -> dict:
    audit = _audit_or_404(s, audit_id)
    path = audit.file_path
    return submit("obstruction_scan",
                  lambda progress: optimizer.obstruction_scan(path, platform, interval_s, fit, progress=progress))


@app.get("/api/previews/{name}")
def get_preview(name: str) -> FileResponse:
    path = (PREVIEW_DIR / name).resolve()
    if path.parent != PREVIEW_DIR.resolve() or not path.exists():
        raise HTTPException(404, "Preview not found")
    return FileResponse(path, media_type="video/mp4" if path.suffix == ".mp4" else "image/png")


# ----------------------------------------------------------------------------------
# Module 4: copy engine
# ----------------------------------------------------------------------------------

class CopyRequest(BaseModel):
    niche: str | None = None
    keyword_volumes: dict[str, float] | None = None
    cta: str | None = None


@app.post("/api/audits/{audit_id}/copy")
def generate_copy(audit_id: int, body: CopyRequest, s: Session = Depends(get_session)) -> dict:
    audit = s.get(AuditLog, audit_id)
    if audit is None:
        raise HTTPException(404, "Audit not found")
    return copy_engine.generate(audit.report, niche=body.niche, keyword_volumes=body.keyword_volumes, cta=body.cta)
