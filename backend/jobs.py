"""Background job runner shared by every router.

Long-running work (audits, decompiles, exports, creator scans) runs on a thread pool;
the client gets a job id and polls GET /api/jobs/{id}.
"""
from __future__ import annotations

import traceback
import uuid
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Callable

from config import WORKER_THREADS
from db import Job, SessionLocal

ProgressFn = Callable[[float, str], None]

executor = ThreadPoolExecutor(max_workers=WORKER_THREADS, thread_name_prefix="atpe")


def update_job(job_id: str, **fields: Any) -> None:
    with SessionLocal() as s:
        job = s.get(Job, job_id)
        if job is None:
            return
        for k, v in fields.items():
            setattr(job, k, v)
        s.commit()


def submit(kind: str, fn: Callable[[ProgressFn], dict]) -> dict:
    """Queues fn(progress) and returns {"job_id", "kind", "status"} immediately."""
    job_id = str(uuid.uuid4())
    with SessionLocal() as s:
        s.add(Job(id=job_id, kind=kind))
        s.commit()

    last = {"p": -1.0}

    def progress(p: float, stage: str) -> None:
        if p - last["p"] >= 0.01 or p >= 1.0:
            last["p"] = p
            update_job(job_id, progress=float(min(1.0, max(0.0, p))), stage=stage)

    def run() -> None:
        update_job(job_id, status="running", stage="Starting")
        try:
            result = fn(progress)
            update_job(job_id, status="done", progress=1.0, stage="Done", result_ref=result)
        except Exception as exc:  # noqa: BLE001 — surfaced to the client
            traceback.print_exc()
            update_job(job_id, status="error", error=f"{type(exc).__name__}: {exc}")

    executor.submit(run)
    return {"job_id": job_id, "kind": kind, "status": "queued"}


def fail_interrupted_jobs() -> None:
    """Jobs that were running when the server stopped will never finish."""
    from sqlalchemy import select

    with SessionLocal() as s:
        for job in s.scalars(select(Job).where(Job.status.in_(["queued", "running"]))):
            job.status, job.error = "error", "Server restarted before the job finished."
        s.commit()
