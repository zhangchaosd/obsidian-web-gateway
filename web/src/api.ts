export type Revision = { mtimeMs: number; hash: string };
export type VaultFile = { path: string; content: string; revision: Revision };
export type TreeEntry = { name: string; path: string; type: "directory" | "markdown" | "asset"; children?: TreeEntry[] };
export type SystemInfo = {
  version: string;
  vault: { name: string };
  features: { readOnly: boolean; search: boolean; backlinks: boolean };
  authRequired: boolean;
};
export type SearchResult = { path: string; score: number; matches: { line: number; snippet: string }[] };
export type Backlink = { path: string; references: { line: number; context: string }[] };

let csrfToken = sessionStorage.getItem("owg-csrf") ?? "";

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public body?: unknown) {
    super(message);
  }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const method = (init.method ?? "GET").toUpperCase();
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  if (!["GET", "HEAD", "OPTIONS"].includes(method) && csrfToken) headers.set("x-csrf-token", csrfToken);
  const response = await fetch(path, { ...init, headers, credentials: "same-origin" });
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: string; message?: string };
    throw new ApiError(response.status, body.error ?? "request_failed", body.message ?? response.statusText, body);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export async function login(password: string): Promise<void> {
  const result = await api<{ csrfToken: string }>("/api/v1/auth/login", {
    method: "POST",
    body: JSON.stringify({ password })
  });
  csrfToken = result.csrfToken;
  sessionStorage.setItem("owg-csrf", csrfToken);
}

export async function restoreSession(): Promise<void> {
  const result = await api<{ csrfToken: string }>("/api/v1/auth/session");
  csrfToken = result.csrfToken;
  sessionStorage.setItem("owg-csrf", csrfToken);
}

export function clearSession(): void {
  csrfToken = "";
  sessionStorage.removeItem("owg-csrf");
}

export const q = (value: string) => encodeURIComponent(value);
