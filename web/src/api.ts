export type Revision = { mtimeMs: number; hash: string };
export type VaultFile = { path: string; content: string; revision: Revision };
export type TreeEntry = { name: string; path: string; type: "directory" | "markdown" | "asset"; children?: TreeEntry[] };
export type SystemInfo = {
  version: string;
  vault: { name: string };
  features: { readOnly: boolean; search: boolean; backlinks: boolean };
  authRequired: boolean;
  auth?: { password: boolean; username: boolean; passkey: boolean };
};
export type UpdateSettings = { schedule: "off" | "daily" | "weekly"; weekday: number; time: string; channel: "stable" | "prerelease" };
export type UpdateStatus = {
  current: string;
  platform: string | null;
  installable: boolean;
  settings: UpdateSettings;
  checkedAt: number | null;
  error: string | null;
  available: boolean;
  latest: { version: string; url: string; notes: string; publishedAt: string; prerelease: boolean } | null;
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

export async function login(username: string | null, password: string, remember = false): Promise<void> {
  const result = await api<{ csrfToken: string }>("/api/v1/auth/login", {
    method: "POST",
    body: JSON.stringify(username === null ? { password, remember } : { username, password, remember })
  });
  csrfToken = result.csrfToken;
  sessionStorage.setItem("owg-csrf", csrfToken);
}

export class PasskeyCancelled extends Error {}

/** Signs in with a passkey registered in bookmarkd (same RP ID). */
export async function passkeyLogin(remember = false): Promise<void> {
  if (!window.PublicKeyCredential || !navigator.credentials) throw new Error("This browser does not support passkeys.");
  const options = await api<{ ceremonyId: string; publicKey: Record<string, unknown> & { challenge: string; allowCredentials?: { id: string }[] } }>("/api/v1/auth/passkey/begin", { method: "POST" });
  const publicKey = {
    ...options.publicKey,
    challenge: fromBase64Url(options.publicKey.challenge),
    allowCredentials: options.publicKey.allowCredentials?.map(item => ({ ...item, id: fromBase64Url(item.id) }))
  } as PublicKeyCredentialRequestOptions;
  let credential: PublicKeyCredential | null;
  try {
    credential = await navigator.credentials.get({ publicKey }) as PublicKeyCredential | null;
  } catch (cause) {
    if (cause instanceof DOMException && (cause.name === "NotAllowedError" || cause.name === "AbortError")) throw new PasskeyCancelled("Passkey sign-in was cancelled.");
    throw cause;
  }
  if (!credential) throw new PasskeyCancelled("Passkey sign-in was cancelled.");
  const response = credential.response as AuthenticatorAssertionResponse;
  const result = await api<{ csrfToken: string }>("/api/v1/auth/passkey/finish", {
    method: "POST",
    body: JSON.stringify({
      ceremonyId: options.ceremonyId,
      remember,
      credential: {
        id: credential.id,
        rawId: toBase64Url(credential.rawId),
        type: credential.type,
        extensions: credential.getClientExtensionResults(),
        response: {
          clientDataJSON: toBase64Url(response.clientDataJSON),
          authenticatorData: toBase64Url(response.authenticatorData),
          signature: toBase64Url(response.signature),
          userHandle: response.userHandle ? toBase64Url(response.userHandle) : null
        }
      }
    })
  });
  csrfToken = result.csrfToken;
  sessionStorage.setItem("owg-csrf", csrfToken);
}

function fromBase64Url(value: string): ArrayBuffer {
  const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(binary, character => character.charCodeAt(0)).buffer;
}

function toBase64Url(value: ArrayBuffer): string {
  let binary = "";
  for (const byte of new Uint8Array(value)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
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
