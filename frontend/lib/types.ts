// Shapes returned by the ATPE API (backend/main.py). Only fields the dashboard reads are typed.

export type Severity = "high" | "medium" | "low";

export interface Flag {
  code: string;
  severity: Severity;
  message: string;
  at_s: number | null;
}

export interface Recommendation {
  severity: Severity;
  area: string;
  message: string;
  at_s: number | null;
}

export interface TimelineBin {
  t: number;
  motion_px_s: number;
  motion_velocity: number;
  audio_db: number;
  audio_energy: number;
  risk: number;
  speaking: boolean;
  pause: boolean;
  stagnant: boolean;
  cut: boolean;
}

export interface Zone {
  start_s: number;
  end_s: number;
  duration_s: number;
  peak_risk?: number;
  reasons?: string[];
}

export interface Word {
  word: string;
  start: number;
  end: number;
  probability: number;
}

export interface TextDetection {
  text: string;
  conf: number;
  box: [number, number, number, number];
  height_ratio: number;
  contrast: number;
  in_safe_zone?: boolean;
  obstructed_by?: { zone: string; kind: string; covered: number }[] | Record<string, { zone: string }[]>;
}

export interface NicheDelta {
  available: boolean;
  sample_size: number;
  score: number | null;
  metrics: {
    metric: string;
    label: string;
    draft: number | null;
    target: number | null;
    direction: "lower" | "higher" | "match";
    unit: string;
    pass: boolean | null;
    gap: number | null;
    message: string;
  }[];
  messages: string[];
}

export interface AuditReport {
  media: {
    width: number;
    height: number;
    fps: number;
    duration_s: number;
    analyzed_duration_s: number;
    has_audio: boolean;
    aspect: number;
    format_tags: Record<string, string>;
  };
  hook: {
    score: number;
    components: { visual: number | null; audio: number | null; text: number | null };
    visual: Record<string, unknown> & { mean_flow_px_s: number; first_frame_luma: number; cuts_in_hook: number[] };
    audio: { onset_latency_ms: number | null; dead_air_ms: number | null; first_word_s: number | null };
    text: { frames: { t: number; score: number; best: TextDetection | null; count: number }[]; ran: boolean };
    flags: Flag[];
  };
  pacing: {
    cuts: number[];
    motion_shifts: number[];
    cut_count: number;
    cuts_per_minute: number;
    avg_shot_length_s: number;
    longest_shot_s: number;
    stagnation_zones: Zone[];
    stagnation_seconds: number;
    speech: {
      words: number;
      wpm: number | null;
      articulation_wpm: number | null;
      pauses: (Zone & { after_word: string })[];
      wpm_curve: { t: number; wpm: number }[];
    };
  };
  loop: {
    score: number;
    components: Record<string, number | null>;
    recommendation: {
      trim_start_ms: number;
      trim_end_ms: number;
      new_start_s: number;
      new_end_s: number;
      new_duration_s: number;
      projected_score: number;
      reason: string;
    };
    ending: { last_sentence?: string; first_sentence?: string; ends_open?: boolean; cut_mid_word?: boolean };
  };
  timeline: TimelineBin[];
  swipe_risk_zones: Zone[];
  recommendations: Recommendation[];
  transcript: { language: string | null; text: string; words: Word[] };
  ocr: { t: number; detections: TextDetection[] }[];
  analysis?: { asr: boolean; ocr: boolean; warnings: { code: string; message: string }[] };
  niche_delta?: NicheDelta;
}

export interface AuditSummary {
  id: number;
  created_at: string;
  filename: string;
  duration_s: number;
  hook_score: number;
  loop_score: number;
  swipe_risk_zones: number;
}

export interface Audit extends AuditSummary {
  report: AuditReport;
}

export interface Job<R = Record<string, unknown>> {
  id: string;
  kind: string;
  status: "queued" | "running" | "done" | "error";
  progress: number;
  stage: string;
  result: R;
  error: string | null;
}

export interface Box {
  label: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  kind: string;
}

export interface SafeZones {
  audit_safe_zone: Box;
  platforms: Record<"tiktok" | "reels", Box[]>;
}

export interface TemplateSummary {
  id: number;
  created_at: string;
  name: string;
  niche: string | null;
  source_url: string | null;
  platform: string | null;
  duration_s: number;
  cuts_per_minute: number;
  avg_shot_length_s: number;
  hook_text: string;
  payoff_s: number | null;
  wpm: number | null;
  source_stats: Record<string, unknown>;
}

export interface Benchmark {
  audit: AuditSummary;
  template: TemplateSummary;
  comparison: {
    template_match_score: number;
    metrics: { metric: string; draft: number | null; template: number | null; gap: number | null }[];
    energy_correlation: number | null;
    motion_correlation: number | null;
    overlay: {
      x: number;
      draft_energy_db: number | null;
      template_energy_db: number | null;
      draft_motion: number | null;
      template_motion: number | null;
    }[];
    cadence: { draft_relative: number[]; template_relative: number[] };
    actions: string[];
  };
}

export interface ExportResult {
  export_id: number;
  output_name: string;
  size_bytes: number;
  trim: { start_s: number; end_s: number; removed_head_ms: number; removed_tail_ms: number };
  loudness: {
    target_lufs: number;
    input_lufs: number | null;
    output_lufs: number | null;
    input_true_peak: number | null;
    output_true_peak: number | null;
  };
  encode: { width: number; height: number; fps: number; source_fps: number; fit: string; bitrate: number; duration_s: number };
  metadata: {
    input: { fingerprint_tags: Record<string, string>; stream_fingerprint_tags: Record<string, string>[]; extra_streams: string[] };
    output: { format_tags: Record<string, string> };
  };
}

export interface CopyResult {
  primary_keyword: string;
  keywords: { phrase: string; score: number; volume: number | null; on_screen: boolean }[];
  tiktok: { caption: string; primary_keyword_index: number; keyword_in_first_50: boolean; length: number };
  instagram: {
    first_line_hook: string;
    hook_variants: string[];
    caption: string;
    alt_text: string;
    hashtags: string[];
  };
  share_triggers: {
    on_screen_hooks: { text: string; trigger: string; why: string }[];
    pinned_comments: { text: string; trigger: string; why: string }[];
    payoff_phrase: string | null;
  };
}

// ---- Outlier radar ---------------------------------------------------------------

export interface ScoredPost {
  video_id: string;
  webpage_url: string;
  title: string | null;
  timestamp: number | null;
  duration: number | null;
  views: number | null;
  views_estimated: boolean;
  likes: number | null;
  comments: number | null;
  reposts: number | null;
  baseline: number | null;
  trimmed_mean: number | null;
  median: number | null;
  outlier_score: number | null;
  engagement_velocity: number | null;
  is_outlier: boolean;
  blueprint_id: number | null;
  decompile_error: string | null;
}

export interface Blueprint {
  id: number;
  created_at: string;
  creator_handle: string;
  platform: string;
  niche: string | null;
  video_id: string;
  webpage_url: string;
  title: string | null;
  posted_at: string | null;
  views: number;
  views_estimated: boolean;
  likes: number | null;
  comments: number | null;
  reposts: number | null;
  baseline: number;
  outlier_score: number;
  engagement_velocity: number;
  duration_sec: number | null;
  total_cuts: number;
  cuts_per_minute: number;
  avg_shot_length_sec: number;
  first_cut_timestamp_sec: number | null;
  max_static_gap_sec: number;
  hook_optical_flow_score: number;
  audio_onset_latency_ms: number | null;
  speaking_wpm: number | null;
  hook_transcript_3s: string;
  telemetry?: {
    cut_timestamps_sec: number[];
    rms_energy_curve_100ms: { t: number; db: number }[];
    full_transcript: string;
    hook_flow_curve: { t: number; magnitude: number }[];
  };
}

export interface CreatorScan {
  scan_id: number;
  creator_handle: string;
  platform: string;
  profile_url: string;
  last_n: number;
  outlier_threshold: number;
  creator_baseline: number;
  posts: ScoredPost[];
  blueprints: Blueprint[];
  warnings: string[];
}

export interface GoldenTargets {
  sample_size: number;
  niche: string | null;
  targets: {
    target_cuts_per_minute: number | null;
    target_avg_shot_length_sec: number | null;
    target_first_cut_before_sec: number | null;
    target_max_audio_latency_ms: number | null;
    target_hook_optical_flow: number | null;
    target_speaking_wpm: number | null;
  };
  spread: Record<string, { p25: number | null; p75: number | null; n: number }>;
}
