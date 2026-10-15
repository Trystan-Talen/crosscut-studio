import { useCallback, useEffect, useRef, useState } from "react";

export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !(init.body instanceof FormData))
    headers.set("Content-Type", "application/json");
  const response = await fetch(`/api${path}`, {
    ...init,
    headers,
    credentials: "same-origin",
  });
  const value = (await response.json().catch(() => null)) as {
    error?: { code?: string; message?: string; details?: unknown };
  } | null;
  if (!response.ok) {
    if (
      response.status === 401 &&
      !path.startsWith("/auth") &&
      !(path === "/me/password" && value?.error?.code === "INVALID_CREDENTIALS")
    )
      window.dispatchEvent(new Event("session-expired"));
    throw new ApiError(
      value?.error?.code ?? String(response.status),
      value?.error?.message ?? "请求未完成，请稍后重试。",
      value?.error?.details,
    );
  }
  return value as T;
}
export const post = <T>(path: string, body: unknown = {}) =>
  api<T>(path, { method: "POST", body: JSON.stringify(body) });
export const patch = <T>(path: string, body: unknown) =>
  api<T>(path, { method: "PATCH", body: JSON.stringify(body) });
export const remove = <T>(path: string) => api<T>(path, { method: "DELETE" });
export function queryString(
  values: Record<string, string | number | boolean | undefined>,
) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values))
    if (value !== undefined && value !== "") params.set(key, String(value));
  return params.toString();
}
export function useQuery<T>(path: string | null, initial: T, interval = 0) {
  const [data, setData] = useState<T>(initial);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const previousPath = useRef(path);
  const refresh = useCallback(() => setRevision((v) => v + 1), []);
  useEffect(() => {
    if (previousPath.current !== path) {
      setData(initial);
      previousPath.current = path;
    }
    if (!path) {
      setLoading(false);
      return;
    }
    let active = true;
    const controller = new AbortController();
    setLoading(true);
    async function load() {
      try {
        const result = await api<T>(path!, { signal: controller.signal });
        if (active) {
          setData(result);
          setError("");
        }
      } catch (e) {
        if (active && !controller.signal.aborted) setError(message(e));
      } finally {
        if (active) setLoading(false);
      }
    }
    void load();
    const timer = interval
      ? window.setInterval(() => {
          if (document.visibilityState === "visible") void load();
        }, interval)
      : undefined;
    return () => {
      active = false;
      controller.abort();
      if (timer) clearInterval(timer);
    };
  }, [path, revision, interval]);
  return { data, setData, error, loading, refresh };
}
export function message(error: unknown): string {
  return error instanceof Error ? error.message : "操作未完成，请重试。";
}
export function navigate(
  page: string,
  params: Record<string, string | undefined> = {},
) {
  window.location.hash = `${page}${Object.keys(params).length ? `?${queryString(params)}` : ""}`;
}
export function useRoute() {
  const read = () => {
    const [page, query] = window.location.hash.slice(1).split("?");
    return { page: page || "home", params: new URLSearchParams(query) };
  };
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const update = () => setRoute(read());
    window.addEventListener("hashchange", update);
    return () => window.removeEventListener("hashchange", update);
  }, []);
  return route;
}
export const bytes = (value: number) =>
  value <= 0
    ? "0 B"
    : value >= 1024 ** 3
      ? `${(value / 1024 ** 3).toFixed(1)} GB`
      : value >= 1024 ** 2
        ? `${(value / 1024 ** 2).toFixed(1)} MB`
        : `${Math.max(1, Math.round(value / 1024))} KB`;
export const date = (value: string) =>
  new Intl.DateTimeFormat("zh-CN", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
export const duration = (value: number | null) =>
  value == null
    ? ""
    : `${Math.floor(value / 60)}:${String(Math.floor(value % 60)).padStart(2, "0")}`;
