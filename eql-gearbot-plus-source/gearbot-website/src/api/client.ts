// If VITE_API_URL isn't set: in dev, assume the API is on its usual local
// port (eq-gear-bot running separately on 3001); in a production build,
// default to '' (relative URLs), which is correct when eq-gear-bot is
// serving this built site as static files from its own process — the
// common case on a host like Wispbyte that gives you one port per app.
const API_URL = (import.meta.env.VITE_API_URL as string | undefined) ??
  (import.meta.env.DEV ? 'http://localhost:3001' : '');

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...options,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });

  let body: any = null;
  try {
    body = await res.json();
  } catch {
    // No JSON body (e.g. 204) — fine.
  }

  if (!res.ok) {
    throw new ApiError(body?.error || res.statusText, res.status);
  }
  return body as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, data?: unknown) =>
    request<T>(path, { method: 'POST', body: data !== undefined ? JSON.stringify(data) : undefined }),
  del: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
  loginUrl: () => `${API_URL}/auth/login`
};
