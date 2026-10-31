"""/api/outlier: creator scans, 10x+ blueprints and the niche benchmark."""
from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from pydantic import BaseModel, Field, field_validator, model_validator
from sqlalchemy import select
from sqlalchemy.orm import Session

from db import CreatorScan, ViralBlueprint, get_session
from jobs import submit
from services import outlier_decompiler as od

router = APIRouter(prefix="/api/outlier", tags=["outlier"])

Browser = Literal["chrome", "chromium", "firefox", "safari", "edge", "brave", "opera", "vivaldi"]


class ScanRequest(BaseModel):
    profile_url: str | None = None
    creator_handle: str | None = None
    platform: Literal["tiktok", "instagram"] | None = None
    post_urls: list[str] | None = Field(None, max_length=60,
                                        description="Explicit post URLs to sweep instead of the profile listing")
    last_n: int = Field(20, ge=3, le=60)
    outlier_threshold: float = Field(10.0, gt=1.0, le=1000.0)
    niche: str | None = Field(None, max_length=120)
    cookies_from_browser: Browser | None = None
    run_asr: bool = True

    @field_validator("creator_handle")
    @classmethod
    def _handle(cls, v: str | None) -> str | None:
        return od.validate_handle(v) if v else None

    @field_validator("niche")
    @classmethod
    def _niche(cls, v: str | None) -> str | None:
        return v.strip().lower() or None if v else None

    @field_validator("post_urls")
    @classmethod
    def _posts(cls, v: list[str] | None) -> list[str] | None:
        urls = [u.strip() for u in (v or []) if u and u.strip()]
        if not urls:
            return None
        platforms = {od.detect_platform(u) for u in urls}  # raises for unsupported hosts
        if len(platforms) > 1:
            raise ValueError("All post URLs must be from the same platform")
        return urls

    @model_validator(mode="after")
    def _target(self) -> "ScanRequest":
        if self.post_urls:
            if len(self.post_urls) < 3:
                raise ValueError("Give at least 3 post URLs (20–30 for a stable baseline)")
        elif self.profile_url:
            od.detect_platform(self.profile_url)  # raises for unsupported hosts
        elif not (self.creator_handle and self.platform):
            raise ValueError("Provide profile_url, post_urls, or creator_handle together with platform")
        return self


@router.post("/scan-creator", status_code=202)
def scan_creator(body: ScanRequest) -> dict:
    """Queues sweep → leave-one-out scoring → decompile 10x+ outliers. The finished job's
    result holds every scored post and the extracted blueprints."""
    params = body.model_dump()
    return submit("scan_creator", lambda progress: od.scan_creator(progress=progress, **params))


@router.get("/scans")
def list_scans(limit: int = Query(50, le=500), s: Session = Depends(get_session)) -> list[dict]:
    rows = s.scalars(select(CreatorScan).order_by(CreatorScan.created_at.desc()).limit(limit))
    return [row.summary() for row in rows]


@router.get("/scans/{scan_id}")
def get_scan(scan_id: int, s: Session = Depends(get_session)) -> dict:
    scan = s.get(CreatorScan, scan_id)
    if scan is None:
        raise HTTPException(404, "Scan not found")
    blueprints = s.scalars(select(ViralBlueprint).where(ViralBlueprint.scan_id == scan_id)
                           .order_by(ViralBlueprint.outlier_score.desc()))
    return {**scan.full(), "blueprints": [b.full() for b in blueprints]}


@router.delete("/scans/{scan_id}", status_code=204)
def delete_scan(scan_id: int, s: Session = Depends(get_session)) -> Response:
    scan = s.get(CreatorScan, scan_id)
    if scan is None:
        raise HTTPException(404, "Scan not found")
    s.delete(scan)  # blueprints keep their telemetry; scan_id is set to NULL
    s.commit()
    return Response(status_code=204)


@router.get("/blueprints")
def list_blueprints(
    niche: str | None = None,
    creator: str | None = None,
    min_score: float = 0.0,
    s: Session = Depends(get_session),
) -> list[dict]:
    q = select(ViralBlueprint).where(ViralBlueprint.outlier_score >= min_score).order_by(ViralBlueprint.outlier_score.desc())
    if niche:
        q = q.where(ViralBlueprint.niche == niche.strip().lower())
    if creator:
        q = q.where(ViralBlueprint.creator_handle == od.normalize_handle(creator))
    return [b.summary() for b in s.scalars(q)]


@router.get("/blueprints/{blueprint_id}")
def get_blueprint(blueprint_id: int, s: Session = Depends(get_session)) -> dict:
    row = s.get(ViralBlueprint, blueprint_id)
    if row is None:
        raise HTTPException(404, "Blueprint not found")
    return row.full()


@router.delete("/blueprints/{blueprint_id}", status_code=204)
def delete_blueprint(blueprint_id: int, s: Session = Depends(get_session)) -> Response:
    row = s.get(ViralBlueprint, blueprint_id)
    if row is None:
        raise HTTPException(404, "Blueprint not found")
    s.delete(row)
    s.commit()
    return Response(status_code=204)


@router.get("/niche-benchmark")
def niche_benchmark(
    niche: str | None = None,
    creator: str | None = None,
    min_score: float = Query(10.0, ge=0.0),
    s: Session = Depends(get_session),
) -> dict:
    """Golden Target Metrics aggregated over stored 10x+ blueprints."""
    return od.golden_targets(s, niche=niche.strip().lower() if niche else None, creator=creator, min_score=min_score)


@router.get("/niches")
def list_niches(s: Session = Depends(get_session)) -> list[str]:
    rows = s.scalars(select(ViralBlueprint.niche).where(ViralBlueprint.niche.is_not(None)).distinct())
    return sorted(n for n in rows if n)
