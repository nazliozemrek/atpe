"""SQLite persistence (SQLAlchemy 2.0): viral templates, pre-flight audits, exports, jobs."""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Iterator

from sqlalchemy import JSON, DateTime, Float, ForeignKey, Integer, String, Text, create_engine
from sqlalchemy.orm import DeclarativeBase, Mapped, Session, mapped_column, sessionmaker

from config import DB_PATH

engine = create_engine(
    f"sqlite:///{DB_PATH}",
    connect_args={"check_same_thread": False, "timeout": 30},
    future=True,
)
SessionLocal = sessionmaker(bind=engine, expire_on_commit=False, future=True)


def _now() -> datetime:
    return datetime.now(timezone.utc)


class Base(DeclarativeBase):
    pass


class ViralTemplate(Base):
    __tablename__ = "viral_templates"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    name: Mapped[str] = mapped_column(String(300))
    niche: Mapped[str | None] = mapped_column(String(120), nullable=True)
    source_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    platform: Mapped[str | None] = mapped_column(String(40), nullable=True)
    file_path: Mapped[str] = mapped_column(Text)
    duration_s: Mapped[float] = mapped_column(Float)
    cuts_per_minute: Mapped[float] = mapped_column(Float)
    avg_shot_length_s: Mapped[float] = mapped_column(Float)
    hook_text: Mapped[str] = mapped_column(Text, default="")
    payoff_s: Mapped[float | None] = mapped_column(Float, nullable=True)
    wpm: Mapped[float | None] = mapped_column(Float, nullable=True)
    source_stats: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    blueprint: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)

    def summary(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "created_at": self.created_at.isoformat(),
            "name": self.name,
            "niche": self.niche,
            "source_url": self.source_url,
            "platform": self.platform,
            "duration_s": self.duration_s,
            "cuts_per_minute": self.cuts_per_minute,
            "avg_shot_length_s": self.avg_shot_length_s,
            "hook_text": self.hook_text,
            "payoff_s": self.payoff_s,
            "wpm": self.wpm,
            "source_stats": self.source_stats,
        }

    def full(self) -> dict[str, Any]:
        return {**self.summary(), "blueprint": self.blueprint}


class AuditLog(Base):
    __tablename__ = "audit_logs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    filename: Mapped[str] = mapped_column(String(300))
    file_path: Mapped[str] = mapped_column(Text)
    duration_s: Mapped[float] = mapped_column(Float)
    hook_score: Mapped[float] = mapped_column(Float)
    loop_score: Mapped[float] = mapped_column(Float)
    swipe_risk_zones: Mapped[int] = mapped_column(Integer, default=0)
    report: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)

    def summary(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "created_at": self.created_at.isoformat(),
            "filename": self.filename,
            "duration_s": self.duration_s,
            "hook_score": self.hook_score,
            "loop_score": self.loop_score,
            "swipe_risk_zones": self.swipe_risk_zones,
        }

    def full(self) -> dict[str, Any]:
        return {**self.summary(), "report": self.report}


class ExportJob(Base):
    __tablename__ = "exports"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    audit_id: Mapped[int | None] = mapped_column(ForeignKey("audit_logs.id", ondelete="SET NULL"), nullable=True)
    input_path: Mapped[str] = mapped_column(Text)
    output_path: Mapped[str] = mapped_column(Text)
    result: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)

    def full(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "created_at": self.created_at.isoformat(),
            "audit_id": self.audit_id,
            "result": self.result,
        }


class Job(Base):
    """Long-running work (audits take minutes on CPU) is queued and polled."""

    __tablename__ = "jobs"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now, onupdate=_now)
    kind: Mapped[str] = mapped_column(String(40))
    status: Mapped[str] = mapped_column(String(20), default="queued")  # queued|running|done|error
    progress: Mapped[float] = mapped_column(Float, default=0.0)
    stage: Mapped[str] = mapped_column(String(120), default="")
    result_ref: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)

    def full(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "kind": self.kind,
            "status": self.status,
            "progress": round(self.progress, 3),
            "stage": self.stage,
            "result": self.result_ref,
            "error": self.error,
            "created_at": self.created_at.isoformat(),
            "updated_at": self.updated_at.isoformat(),
        }


def init_db() -> None:
    Base.metadata.create_all(engine)


def get_session() -> Iterator[Session]:
    with SessionLocal() as session:
        yield session
