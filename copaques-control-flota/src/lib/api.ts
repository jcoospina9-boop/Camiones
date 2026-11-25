let authToken: string | null = null;

export function setAuthToken(token: string | null): void {
  authToken = token;
}

export function getAuthToken(): string | null {
  return authToken;
}

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export async function apiFetch<T>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const headers = new Headers(options.headers);
  headers.set('X-Requested-With', 'XMLHttpRequest');
  if (!headers.has('Content-Type') && options.body && typeof options.body === 'string') {
    headers.set('Content-Type', 'application/json');
  }
  if (authToken) {
    headers.set('Authorization', `Bearer ${authToken}`);
  }

  const res = await fetch(path, {
    credentials: 'same-origin',
    ...options,
    headers,
  });

  if (!res.ok) {
    let message = `Error HTTP ${res.status}`;
    try {
      const errData = (await res.json()) as { error?: string };
      if (errData.error) message = errData.error;
    } catch {
      // ignore non-json error bodies
    }
    throw new ApiError(message, res.status);
  }

  return (await res.json()) as T;
}

export async function apiDownload(path: string, filename: string): Promise<void> {
  const headers = new Headers({ 'X-Requested-With': 'XMLHttpRequest' });
  if (authToken) {
    headers.set('Authorization', `Bearer ${authToken}`);
  }
  const res = await fetch(path, { credentials: 'same-origin', headers });
  if (!res.ok) {
    throw new ApiError('No se pudo descargar el archivo de respaldo.', res.status);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
