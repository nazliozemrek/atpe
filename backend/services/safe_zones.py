"""UI overlay geometry for 9:16 feeds, as fractions of the frame (x0, y0, x1, y1).

These boxes are measured approximations of the TikTok and Instagram Reels players on
current iPhone/Android layouts. Both apps change their chrome often and vary by device,
locale and caption length, so the boxes are deliberately generous and live in one table
you can re-measure against a fresh screenshot. Nothing else in the pipeline hardcodes
platform geometry.
"""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Box:
    label: str
    x0: float
    y0: float
    x1: float
    y1: float
    kind: str = "ui"  # ui | caption | ticker | header

    def as_dict(self) -> dict:
        return {"label": self.label, "x0": self.x0, "y0": self.y0, "x1": self.x1, "y1": self.y1, "kind": self.kind}

    def intersection(self, x0: float, y0: float, x1: float, y1: float) -> float:
        """Fraction of the given box's area covered by this UI box."""
        ix = max(0.0, min(self.x1, x1) - max(self.x0, x0))
        iy = max(0.0, min(self.y1, y1) - max(self.y0, y0))
        area = max(1e-9, (x1 - x0) * (y1 - y0))
        return (ix * iy) / area


PLATFORM_ZONES: dict[str, list[Box]] = {
    "tiktok": [
        Box("Top tabs (Following / For You)", 0.00, 0.00, 1.00, 0.085, "header"),
        Box("Action rail (avatar, like, comment, save, share)", 0.855, 0.355, 1.00, 0.865, "ui"),
        Box("Username + caption block", 0.00, 0.765, 0.80, 0.915, "caption"),
        Box("Sound ticker + nav bar", 0.00, 0.915, 1.00, 1.00, "ticker"),
    ],
    "reels": [
        Box("Header (Reels, camera)", 0.00, 0.00, 1.00, 0.075, "header"),
        Box("Action rail (like, comment, share, more)", 0.85, 0.50, 1.00, 0.885, "ui"),
        Box("Username + caption block", 0.00, 0.79, 0.82, 0.915, "caption"),
        Box("Audio ticker + nav bar", 0.00, 0.915, 1.00, 1.00, "ticker"),
    ],
}

# The audit's generic "central safe zone": excludes bottom 25 %, right 15 % and the
# top header strip, which is the union of both platforms' worst cases.
AUDIT_SAFE_ZONE = Box("Central safe zone", 0.0, 0.085, 0.85, 0.75, "safe")


def zones(platform: str) -> list[Box]:
    key = platform.lower()
    if key in {"instagram", "ig", "reel"}:
        key = "reels"
    if key not in PLATFORM_ZONES:
        raise KeyError(f"Unknown platform {platform!r}; expected one of {sorted(PLATFORM_ZONES)}")
    return PLATFORM_ZONES[key]


def in_safe_zone(x0: float, y0: float, x1: float, y1: float, tolerance: float = 0.02) -> bool:
    z = AUDIT_SAFE_ZONE
    return x0 >= z.x0 - tolerance and y0 >= z.y0 - tolerance and x1 <= z.x1 + tolerance and y1 <= z.y1 + tolerance


def obstructions(x0: float, y0: float, x1: float, y1: float, platform: str, min_cover: float = 0.15) -> list[dict]:
    hits = []
    for box in zones(platform):
        cover = box.intersection(x0, y0, x1, y1)
        if cover >= min_cover:
            hits.append({"zone": box.label, "kind": box.kind, "covered": round(cover, 3)})
    return hits


def all_zones() -> dict:
    return {
        "audit_safe_zone": AUDIT_SAFE_ZONE.as_dict(),
        "platforms": {name: [b.as_dict() for b in boxes] for name, boxes in PLATFORM_ZONES.items()},
    }
