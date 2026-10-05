let sessionToken = "";

export function setSessionToken(token: string) {
  sessionToken = token || "";
}

export function authHeaders(extra?: HeadersInit): Headers {
  const headers = new Headers(extra || undefined);
  if (sessionToken) headers.set("Authorization", `Bearer ${sessionToken}`);
  return headers;
}

export async function initApiSession(): Promise<void> {
  const electron = (window as Window & { electron?: { getSessionToken?: () => Promise<string> } }).electron;
  if (electron?.getSessionToken) {
    sessionToken = await electron.getSessionToken();
  }
  if (!sessionToken) return;
  const res = await fetch("/api/session", { method: "POST", headers: authHeaders() });
  if (!res.ok) {
    throw new Error("The local server rejected the session token.");
  }
}

export async function apiFetch(url: string, options: RequestInit = {}): Promise<any> {
  const headers = authHeaders(options.headers);
  const res = await fetch(url, { ...options, headers });
  if (!res.ok) {
    let errorMessage = `Server error (${res.status})`;
    try {
      const text = await res.text();
      if (text.startsWith("{") || text.startsWith("[")) {
        const json = JSON.parse(text);
        errorMessage = json.error || errorMessage;
      } else if (text) {
        errorMessage = text.slice(0, 300);
      }
    } catch {
      // keep the status message
    }
    const error = new Error(errorMessage) as Error & { status?: number };
    error.status = res.status;
    throw error;
  }
  const contentType = res.headers.get("content-type") || "";
  if (contentType.includes("application/json")) return res.json();
  return res.text();
}
