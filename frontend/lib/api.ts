"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Job } from "./types";

export const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000").replace(/\/$/, "");

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function parse<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = await res.json();
      detail = typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail ?? body);
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(res.status, detail || `HTTP ${res.status}`);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export async function apiGet<T>(path: string): Promise<T> {
  return parse<T>(await fetch(`${API_URL}${path}`, { cache: "no-store" }));
}

export async function apiSend<T>(path: string, method: "POST" | "DELETE" | "PUT", body?: unknown): Promise<T> {
  return parse<T>(
    await fetch(`${API_URL}${path}`, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
}

export async function apiUpload<T>(path: string, form: FormData): Promise<T> {
  return parse<T>(await fetch(`${API_URL}${path}`, { method: "POST", body: form }));
}

export const mediaUrl = (path: string) => `${API_URL}${path}`;

/** Polls a job until it finishes. Rejects with the job's error message on failure. */
export async function waitForJob<R>(
  jobId: string,
  onUpdate?: (job: Job<R>) => void,
  signal?: AbortSignal,
): Promise<R> {
  let delay = 600;
  for (;;) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const job = await apiGet<Job<R>>(`/api/jobs/${jobId}`);
    onUpdate?.(job);
    if (job.status === "done") return job.result;
    if (job.status === "error") throw new ApiError(500, job.error ?? "Job failed");
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(2000, delay + 200);
  }
}

/** Runs a queued backend job and exposes its live progress. */
export function useJob<R>() {
  const [job, setJob] = useState<Job<R> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => () => abort.current?.abort(), []);

  const run = useCallback(async (start: () => Promise<{ job_id: string }>): Promise<R | null> => {
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    setRunning(true);
    setError(null);
    setJob(null);
    try {
      const { job_id } = await start();
      return await waitForJob<R>(job_id, setJob, controller.signal);
    } catch (e) {
      if ((e as Error).name !== "AbortError") setError((e as Error).message);
      return null;
    } finally {
      if (abort.current === controller) setRunning(false);
    }
  }, []);

  return { job, error, running, run, setError };
}

/** Simple GET-with-state hook; call reload() after mutations. */
export function useApi<T>(path: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const reload = useCallback(async () => {
    if (!path) {
      setData(null);
      return;
    }
    setLoading(true);
    try {
      setData(await apiGet<T>(path));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [path]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { data, error, loading, reload, setData };
}
