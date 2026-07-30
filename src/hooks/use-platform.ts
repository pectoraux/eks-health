"use client";

import { useEffect, useState, useCallback } from "react";

export interface PlatformSnapshot {
  kernel: unknown; identity: unknown; programs: unknown; health: unknown;
  technicians: unknown; competitions: unknown; missions: unknown;
  developer: unknown; marketplace: unknown; research: unknown;
}

export interface ApiResult<T> {
  ok: boolean;
  data?: T;
  error?: { code: string; message?: string; userMessage?: string };
  meta?: { kernel?: string; identity?: string; at?: string };
}

/** Fetch the full platform snapshot (kernel + identity). */
export function usePlatformSnapshot(refreshMs = 0) {
  const [data, setData] = useState<PlatformSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetch_ = useCallback(async () => {
    try {
      const res = await fetch("/api/platform/snapshot", { cache: "no-store" });
      const json: ApiResult<PlatformSnapshot> = await res.json();
      if (json.ok && json.data) {
        setData(json.data);
        setError(null);
      } else {
        setError(json.error?.userMessage ?? json.error?.message ?? "Failed to load platform");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetch_();
    if (refreshMs > 0) {
      const id = setInterval(fetch_, refreshMs);
      return () => clearInterval(id);
    }
  }, [fetch_, refreshMs]);

  return { data, loading, error, refresh: fetch_ };
}

/** Generic API call helper. body is optional (for GET-style POSTs). */
export async function apiPost<TOut>(
  path: string,
  body?: unknown,
  method: "POST" | "PUT" | "DELETE" = "POST",
): Promise<ApiResult<TOut>> {
  try {
    const res = await fetch(path, {
      method,
      headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return (await res.json()) as ApiResult<TOut>;
  } catch (e) {
    return { ok: false, error: { code: "network", message: e instanceof Error ? e.message : "Network error" } };
  }
}
