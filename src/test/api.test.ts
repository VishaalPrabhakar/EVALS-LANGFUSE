/**
 * ============================================================================
 * API LAYER EDGE CASES
 * ============================================================================
 * Numbered to match docs/EDGE_CASES.md.
 * ============================================================================
 */

import { describe, expect, it, vi } from 'vitest';
import { ApiClient, ApiError, fetchAllPages } from '../api/client';
import { QuestionsApi } from '../api/questions';
import { makeLibrary, page, toLangfuseItem } from './fixtures';

function clientWith(fetchImpl: typeof fetch, maxAttempts = 1) {
  return new ApiClient({ baseUrl: 'http://t.local/api', fetchImpl, maxAttempts, timeoutMs: 500 });
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('EDGE 19 — HTTP error taxonomy drives different UI treatment', () => {
  it.each([
    [401, 'auth', false],
    [403, 'auth', false],
    [404, 'notfound', false],
    [409, 'conflict', false],
    [429, 'ratelimit', true],
    [500, 'server', true],
    [503, 'server', true],
    [400, 'client', false],
  ])('maps %i to %s (retryable: %s)', async (status, kind, retryable) => {
    const c = clientWith((async () => jsonResponse({}, status)) as typeof fetch);
    const err = await c.get('/x').catch((e) => e as ApiError);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).kind).toBe(kind);
    // Retryability decides whether the UI shows a retry button at all —
    // offering one for a 400 is a dead action.
    expect((err as ApiError).retryable).toBe(retryable);
  });

  it('gives every error kind a plain user-facing message', () => {
    for (const kind of ['network', 'auth', 'notfound', 'conflict', 'ratelimit', 'server', 'parse'] as const) {
      const msg = new ApiError(kind, 'internal detail').userMessage;
      expect(msg.length).toBeGreaterThan(10);
      // Must not leak internals to the end user.
      expect(msg).not.toContain('internal detail');
    }
  });
});

describe('EDGE 20 — malformed and empty responses', () => {
  it('raises a parse error for non-JSON with a 200', async () => {
    const c = clientWith((async () => new Response('<html>oops</html>', { status: 200 })) as typeof fetch);
    const err = await c.get('/x').catch((e) => e as ApiError);
    expect((err as ApiError).kind).toBe('parse');
  });

  it('treats 204 No Content as success, not an error', async () => {
    // DELETE and PATCH legitimately return no body.
    const c = clientWith((async () => new Response(null, { status: 204 })) as typeof fetch);
    await expect(c.delete('/x')).resolves.toBeUndefined();
  });

  it('treats an empty 200 body as success', async () => {
    const c = clientWith((async () => new Response('', { status: 200 })) as typeof fetch);
    await expect(c.get('/x')).resolves.toBeUndefined();
  });
});

describe('EDGE 21 — retry behaviour', () => {
  it('retries retryable failures and eventually succeeds', async () => {
    let calls = 0;
    const impl = (async () => {
      calls++;
      return calls < 3 ? jsonResponse({}, 503) : jsonResponse({ ok: true });
    }) as typeof fetch;
    const c = new ApiClient({ baseUrl: 'http://t.local', fetchImpl: impl, maxAttempts: 3 });
    await expect(c.get('/x')).resolves.toEqual({ ok: true });
    expect(calls).toBe(3);
  });

  it('does NOT retry non-retryable failures', async () => {
    // Retrying a 400 wastes time and can double-write on a POST.
    let calls = 0;
    const impl = (async () => {
      calls++;
      return jsonResponse({}, 400);
    }) as typeof fetch;
    const c = new ApiClient({ baseUrl: 'http://t.local', fetchImpl: impl, maxAttempts: 3 });
    await c.get('/x').catch(() => {});
    expect(calls).toBe(1);
  });

  it('gives up after maxAttempts and surfaces the error', async () => {
    let calls = 0;
    const impl = (async () => {
      calls++;
      return jsonResponse({}, 500);
    }) as typeof fetch;
    const c = new ApiClient({ baseUrl: 'http://t.local', fetchImpl: impl, maxAttempts: 2 });
    const err = await c.get('/x').catch((e) => e as ApiError);
    expect(calls).toBe(2);
    expect((err as ApiError).kind).toBe('server');
  });

  it('converts a thrown network failure into an ApiError', async () => {
    const impl = (async () => {
      throw new TypeError('Failed to fetch');
    }) as typeof fetch;
    const c = clientWith(impl);
    const err = await c.get('/x').catch((e) => e as ApiError);
    expect((err as ApiError).kind).toBe('network');
  });
});

describe('EDGE 22 — URL and query construction', () => {
  it('omits empty, null and undefined params rather than sending blanks', async () => {
    let seen = '';
    const impl = (async (url: RequestInfo | URL) => {
      seen = String(url);
      return jsonResponse({});
    }) as typeof fetch;
    await clientWith(impl).get('/items', { a: 1, b: undefined, c: null, d: '' });
    expect(seen).toContain('a=1');
    expect(seen).not.toContain('b=');
    expect(seen).not.toContain('c=');
    expect(seen).not.toContain('d=');
  });

  it('repeats the key for array params, matching Langfuse list filters', async () => {
    let seen = '';
    const impl = (async (url: RequestInfo | URL) => {
      seen = String(url);
      return jsonResponse({});
    }) as typeof fetch;
    await clientWith(impl).get('/items', { tag: ['a', 'b'] });
    expect(seen).toContain('tag=a');
    expect(seen).toContain('tag=b');
  });

  it('normalises a trailing slash on baseUrl', async () => {
    let seen = '';
    const impl = (async (url: RequestInfo | URL) => {
      seen = String(url);
      return jsonResponse({});
    }) as typeof fetch;
    const c = new ApiClient({ baseUrl: 'http://t.local/api/', fetchImpl: impl, maxAttempts: 1 });
    await c.get('/items');
    expect(seen).toBe('http://t.local/api/items');
  });

  it('escapes ids containing URL-unsafe characters', async () => {
    // Langfuse ids are usually safe, but a user-supplied suite name is not.
    let seen = '';
    const impl = (async (url: RequestInfo | URL) => {
      seen = String(url);
      return jsonResponse(toLangfuseItem(makeLibrary()[0]));
    }) as typeof fetch;
    const api = new QuestionsApi(clientWith(impl), 'ds');
    await api.get('id with spaces/and-slash');
    expect(seen).toContain('id%20with%20spaces%2Fand-slash');
  });
});

describe('EDGE 23 — pagination', () => {
  it('stops on an empty page even when totalPages lies', async () => {
    // Some Langfuse versions report a stale totalPages. Without the empty
    // check this loops to maxPages on every load.
    const fetchPage = vi.fn(async (p: number) =>
      p === 1 ? { data: [1, 2], meta: { totalPages: 99 } } : { data: [], meta: { totalPages: 99 } },
    );
    const all = await fetchAllPages(fetchPage);
    expect(all).toEqual([1, 2]);
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });

  it('respects maxPages as a runaway guard', async () => {
    const fetchPage = vi.fn(async () => ({ data: [1], meta: { totalPages: 9999 } }));
    const all = await fetchAllPages(fetchPage, 3);
    expect(all).toHaveLength(3);
    expect(fetchPage).toHaveBeenCalledTimes(3);
  });

  it('stops when the reported totalPages is reached', async () => {
    const fetchPage = vi.fn(async (p: number) => ({ data: [p], meta: { totalPages: 2 } }));
    await fetchAllPages(fetchPage);
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });
});

describe('EDGE 24 — questions API library semantics', () => {
  it('filters archived items out by default', async () => {
    const lib = makeLibrary();
    const impl = (async () => jsonResponse(page(lib.map(toLangfuseItem)))) as typeof fetch;
    const api = new QuestionsApi(clientWith(impl), 'ds');
    const active = await api.list();
    expect(active.some((q) => q.archived)).toBe(false);
    expect(active).toHaveLength(lib.length - 1);
  });

  it('includes archived items when asked', async () => {
    const lib = makeLibrary();
    const impl = (async () => jsonResponse(page(lib.map(toLangfuseItem)))) as typeof fetch;
    const api = new QuestionsApi(clientWith(impl), 'ds');
    expect(await api.list(true)).toHaveLength(lib.length);
  });

  it('archives via status rather than deleting — history stays readable', async () => {
    let method = '';
    let body: unknown;
    const impl = (async (_u: RequestInfo | URL, init?: RequestInit) => {
      method = init?.method ?? '';
      body = init?.body ? JSON.parse(String(init.body)) : undefined;
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    await new QuestionsApi(clientWith(impl), 'ds').archive('q1');
    expect(method).toBe('PATCH');
    expect(body).toEqual({ status: 'ARCHIVED' });
  });

  it('bulk membership reports partial failure per id', async () => {
    // Silent partial success is the worst outcome: the user cannot tell what
    // their suite actually contains.
    const lib = makeLibrary();
    const impl = (async (url: RequestInfo | URL, init?: RequestInit) => {
      const u = String(url);
      if (init?.method === 'POST') {
        const parsed = JSON.parse(String(init.body)) as { id?: string };
        if (parsed.id === 'q2') return jsonResponse({ error: 'boom' }, 500);
        return jsonResponse(toLangfuseItem(lib[0]));
      }
      const id = u.split('/').pop() ?? '';
      const found = lib.find((q) => q.id === id) ?? lib[0];
      return jsonResponse(toLangfuseItem(found));
    }) as typeof fetch;

    const api = new QuestionsApi(clientWith(impl), 'ds');
    const res = await api.setSuiteMembershipBulk([
      { id: 'q1', suites: ['A'] },
      { id: 'q2', suites: ['A'] },
      { id: 'q3', suites: ['A'] },
    ]);
    expect(res.ok).toEqual(['q1', 'q3']);
    expect(res.failed.map((f) => f.id)).toEqual(['q2']);
  });

  it('reports progress during a bulk write', async () => {
    const lib = makeLibrary();
    const impl = (async () => jsonResponse(toLangfuseItem(lib[0]))) as typeof fetch;
    const api = new QuestionsApi(clientWith(impl), 'ds');
    const seen: Array<[number, number]> = [];
    await api.setSuiteMembershipBulk(
      [{ id: 'q1', suites: [] }, { id: 'q2', suites: [] }],
      (d, t) => seen.push([d, t]),
    );
    expect(seen).toEqual([[1, 2], [2, 2]]);
  });

  it('membership updates preserve name, criteria and tags', async () => {
    // A membership toggle must not blank the question content — an early bug
    // that would silently destroy criteria on every suite edit.
    const lib = makeLibrary();
    let written: Record<string, unknown> | undefined;
    const impl = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') {
        written = JSON.parse(String(init.body)) as Record<string, unknown>;
        return jsonResponse(toLangfuseItem(lib[0]));
      }
      return jsonResponse(toLangfuseItem(lib[0]));
    }) as typeof fetch;

    await new QuestionsApi(clientWith(impl), 'ds').setSuiteMembership('q1', 'Safety', true);
    const meta = written?.metadata as Record<string, unknown>;
    expect(meta.name).toBe('Refund window');
    expect((written?.expectedOutput as Record<string, string>).criteria).toContain('30 days');
    expect(meta.suites).toContain('Safety');
    expect(meta.suites).toContain('Smoke');
  });
});
