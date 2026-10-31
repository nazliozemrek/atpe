"""Conversion of analysis output (numpy scalars/arrays, tuples, NaN) into plain JSON."""
from __future__ import annotations

import math
from typing import Any

import numpy as np


def to_jsonable(value: Any) -> Any:
    if isinstance(value, dict):
        return {str(k): to_jsonable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [to_jsonable(v) for v in value]
    if isinstance(value, np.ndarray):
        return [to_jsonable(v) for v in value.tolist()]
    if isinstance(value, (np.bool_,)):
        return bool(value)
    if isinstance(value, np.integer):
        return int(value)
    if isinstance(value, (np.floating, float)):
        f = float(value)
        return None if math.isnan(f) or math.isinf(f) else f
    return value


def r(x: float | None, n: int = 3) -> float | None:
    if x is None:
        return None
    f = float(x)
    if math.isnan(f) or math.isinf(f):
        return None
    return round(f, n)
