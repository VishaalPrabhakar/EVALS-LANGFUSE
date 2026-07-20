/**
 * ============================================================================
 * HTTP CLIENT
 * ============================================================================
 *
 * Thin wrapper over fetch for the Langfuse public API.
 *
 * DEPLOYMENT NOTE — READ BEFORE WIRING THIS UP:
 * Langfuse authenticates with HTTP Basic using a public/secret key pair. The
 * SECRET KEY MUST NEVER REACH THE BROWSER. In production, point `baseUrl` at
 * your own backend, which proxies to Langfuse and injects credentials
 * server-side. The `authToken` option here exists for local development
 * against a throwaway project only.
 *
 * See docs/INTEGRATION.md for the proxy contract.
 * ============================================================================
 */

/** Error categories the UI reacts to differently. */
export type ApiErrorKind =
  | 'network'      // no response — offline, DNS, CORS
  | 'auth'         // 401/403 — bad or missing credentials
  | 'notfound'     // 404
  | 'conflict'     // 409 — concurrent edit
  | 'ratelimit'    // 429
  | 'server'       // 5xx
  | 'client'       // other 4xx
  | 'parse';       // 2xx with an unreadable body

export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  readonly status?: number;
  readonly body?: unknown;
  /** Whether a retry could plausibly succeed. Drives the UI's retry button. */
  readonly retryable: boolean;

  constructor(kind: ApiErrorKind, message: string, status?: number, body?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.kind = kind;
    this.status = status;
    this.body = body;
    this.retryable = kind === 'network' || kind === 'ratelimit' || kind === 'server';
  }

  /**
   * User-facing message. Deliberately plain and actionable — never surfaces
   * a raw status code or stack to the end user.
   */
  get userMessage(): string {
    switch (this.kind) {
      case 'network':
        return "Can't reach the evaluation service. Check your connection and try again.";
      case 'auth':
        return 'Your session has expired. Sign in again to continue.';
      case 'notfound':
        return "That item no longer exists. It may have been deleted in another tab.";
      case 'conflict':
        return 'Someone else changed this while you were editing. Reload to see the latest.';
      case 'ratelimit':
        return 'Too many requests. Waiting a moment before retrying.';
      case 'server':
        return 'The evaluation service had a problem. This is usually temporary.';
      case 'parse':
        return 'The evaluation service returned something unexpected.';
      default:
        return 'That request could not be completed.';
    }
  }
}

export interface ClientConfig {
  /** Base URL of your backend proxy, e.g. '/api/evals'. No trailing slash. */
  baseUrl: string;
  /** DEV ONLY. See the deployment note above. */
  authToken?: string;
  /** Total attempts for retryable failures. 1 disables retry. */
  maxAttempts?: number;
  /** Per-request timeout in ms. */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

const DEFAULTS = { maxAttempts: 3, timeoutMs: 30_000 };

export class ApiClient {
  private cfg: Required<Omit<ClientConfig, 'authToken'>> & { authToken?: string };

  constructor(cfg: ClientConfig) {
    this.cfg = {
      maxAttempts: DEFAULTS.maxAttempts,
      timeoutMs: DEFAULTS.timeoutMs,
      fetchImpl: cfg.fetchImpl ?? globalThis.fetch.bind(globalThis),
      ...cfg,
      baseUrl: cfg.baseUrl.replace(/\/+$/, ''),
    };
  }

  get<T>(path: string, params?: Record<string, unknown>): Promise<T> {
    return this.request<T>('GET', path, undefined, params);
  }
  post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>('POST', path, body);
  }
  patch<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>('PATCH', path, body);
  }
  delete<T>(path: string): Promise<T> {
    return this.request<T>('DELETE', path);
  }

  /**
   * Perform a request with timeout and bounded retry.
   *
   * Retries use exponential backoff with jitter. Jitter matters: without it,
   * a page that fires several parallel requests will retry them in lockstep
   * and hammer a recovering server.
   *
   * Only retryable kinds are retried. A 400 will never succeed on retry, and
   * retrying a POST that already succeeded server-side could double-write.
   */
  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    params?: Record<string, unknown>,
  ): Promise<T> {
    const url = this.buildUrl(path, params);
    let lastErr: ApiError | undefined;

    for (let attempt = 1; attempt <= this.cfg.maxAttempts; attempt++) {
      try {
        return await this.once<T>(method, url, body);
      } catch (e) {
        const err = e instanceof ApiError ? e : new ApiError('network', String(e));
        lastErr = err;
        if (!err.retryable || attempt === this.cfg.maxAttempts) throw err;
        const backoff = Math.min(1000 * 2 ** (attempt - 1), 8000);
        const jitter = Math.random() * 250;
        await sleep(backoff + jitter);
      }
    }
    throw lastErr ?? new ApiError('network', 'Request failed');
  }

  private async once<T>(method: string, url: string, body?: unknown): Promise<T> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.cfg.timeoutMs);

    try {
      const headers: Record<string, string> = { Accept: 'application/json' };
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      if (this.cfg.authToken) headers.Authorization = `Basic ${this.cfg.authToken}`;

      const res = await this.cfg.fetchImpl(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctrl.signal,
      });

      if (!res.ok) throw await this.toError(res);

      // 204 and empty bodies are legitimate for DELETE/PATCH.
      if (res.status === 204) return undefined as T;
      const text = await res.text();
      if (!text) return undefined as T;
      try {
        return JSON.parse(text) as T;
      } catch {
        throw new ApiError('parse', 'Response was not valid JSON', res.status, text.slice(0, 200));
      }
    } catch (e) {
      if (e instanceof ApiError) throw e;
      if (e instanceof DOMException && e.name === 'AbortError') {
        throw new ApiError('network', `Request timed out after ${this.cfg.timeoutMs}ms`);
      }
      throw new ApiError('network', String(e));
    } finally {
      clearTimeout(timer);
    }
  }

  private async toError(res: Response): Promise<ApiError> {
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      body = undefined;
    }
    const kind: ApiErrorKind =
      res.status === 401 || res.status === 403 ? 'auth'
      : res.status === 404 ? 'notfound'
      : res.status === 409 ? 'conflict'
      : res.status === 429 ? 'ratelimit'
      : res.status >= 500 ? 'server'
      : 'client';
    return new ApiError(kind, `${method(res)} failed with ${res.status}`, res.status, body);
  }

  private buildUrl(path: string, params?: Record<string, unknown>): string {
    const p = path.startsWith('/') ? path : `/${path}`;
    if (!params) return `${this.cfg.baseUrl}${p}`;
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null || v === '') continue;
      // Arrays repeat the key, matching Langfuse's list-filter convention.
      if (Array.isArray(v)) v.forEach((x) => qs.append(k, String(x)));
      else qs.set(k, String(v));
    }
    const s = qs.toString();
    return `${this.cfg.baseUrl}${p}${s ? `?${s}` : ''}`;
  }
}

function method(res: Response): string {
  return res.url ? `Request to ${new URL(res.url).pathname}` : 'Request';
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Fetch every page of a paginated Langfuse list endpoint.
 *
 * Guarded against runaway loops: stops at `maxPages` and returns what it has
 * rather than spinning forever if the server reports an inconsistent
 * totalPages. Also stops on an empty page, which some Langfuse versions
 * return instead of a correct totalPages.
 */
export async function fetchAllPages<T>(
  fetchPage: (page: number) => Promise<{ data: T[]; meta?: { totalPages?: number } }>,
  maxPages = 20,
): Promise<T[]> {
  const out: T[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const res = await fetchPage(page);
    if (!res.data?.length) break;
    out.push(...res.data);
    const total = res.meta?.totalPages;
    if (typeof total === 'number' && page >= total) break;
  }
  return out;
}
