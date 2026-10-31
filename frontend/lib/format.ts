export const fmtNum = (v: number | null | undefined, digits = 1) =>
  v === null || v === undefined || Number.isNaN(v) ? "—" : v.toFixed(digits);

export const fmtInt = (v: number | null | undefined) =>
  v === null || v === undefined ? "—" : Math.round(v).toLocaleString();

export const fmtCompact = (v: number | null | undefined) =>
  v === null || v === undefined
    ? "—"
    : new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(v);

export const fmtSec = (v: number | null | undefined, digits = 2) => (v === null || v === undefined ? "—" : `${v.toFixed(digits)}s`);

export const fmtMs = (v: number | null | undefined) => (v === null || v === undefined ? "—" : `${Math.round(v)} ms`);

export const fmtBytes = (b: number) =>
  b > 1e9 ? `${(b / 1e9).toFixed(2)} GB` : b > 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${(b / 1e3).toFixed(0)} KB`;

export const fmtDate = (iso: string) => {
  const d = new Date(iso.endsWith("Z") || iso.includes("+") ? iso : `${iso}Z`);
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
};

/** 0–100 score → tone used for color coding. */
export const scoreTone = (v: number | null | undefined): "good" | "warn" | "bad" | "none" =>
  v === null || v === undefined ? "none" : v >= 70 ? "good" : v >= 45 ? "warn" : "bad";
