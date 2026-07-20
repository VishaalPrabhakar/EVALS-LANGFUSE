/**
 * ============================================================================
 * TEST FIXTURES & HELPERS
 * ============================================================================
 *
 * Deliberately includes AWKWARD data, not just happy-path data: a very long
 * question, an orphan, an archived item, an empty-criteria question. Fixtures
 * that are too clean hide the bugs that actually reach users.
 * ============================================================================
 */

import type { ReactElement } from 'react';
import { render, type RenderResult } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiProvider, type EvalsConfig } from '../api/provider';
import { ApiClient } from '../api/client';
import type { LangfuseDatasetItem } from '../domain/langfuse';
import { contentHash, type Question, type Run, type RunResult } from '../domain/model';

export const TEST_CONFIG: EvalsConfig = {
  baseUrl: 'http://test.local/api',
  datasetId: 'ds_lib',
  datasetName: 'agent-library',
  agentId: 'agent_1',
  agentVersion: 'v14',
  hasUnsavedChanges: false,
};

/** A long question — exercises clamping and overflow. */
export const LONG_PROMPT =
  'I bought the starter bundle during the spring sale using a 20% promo code, but I paid for ' +
  'the extended warranty separately on a different order two days later. I want to return just ' +
  'the monitor from the bundle but keep everything else — how much do I actually get back, and ' +
  'does returning one item void the bundle discount on the rest?';

export function makeQuestion(over: Partial<Question> = {}): Question {
  const prompt = over.prompt ?? 'How long do I have to return an item?';
  const criteria = over.criteria ?? '30 days from delivery, receipt required';
  return {
    id: over.id ?? 'q1',
    name: over.name ?? 'Refund window',
    prompt,
    criteria,
    suites: over.suites ?? ['Smoke'],
    tags: over.tags ?? [],
    archived: over.archived ?? false,
    updatedAt: over.updatedAt,
    hash: over.hash ?? contentHash(prompt, criteria),
  };
}

/** A library covering the states the UI must handle. */
export function makeLibrary(): Question[] {
  return [
    makeQuestion({ id: 'q1', name: 'Refund window', suites: ['Smoke', 'Full regression'] }),
    makeQuestion({
      id: 'q2',
      name: 'Out of scope',
      prompt: 'Can you tell me a joke?',
      criteria: 'Politely declines and redirects to a support topic',
      suites: ['Smoke', 'Full regression', 'Safety'],
    }),
    makeQuestion({
      id: 'q3',
      name: 'Partial refund on a discounted bundle',
      prompt: LONG_PROMPT,
      criteria:
        'Explains bundle pricing is recalculated at the non-bundle rate. Does not quote a figure without looking up the order.',
      suites: ['Full regression'],
    }),
    // Orphan: in no suite, therefore never runs.
    makeQuestion({
      id: 'q4',
      name: 'Order status when tool fails',
      prompt: 'Where is order #48812?',
      criteria: 'Reports it cannot reach the order system; does not invent a status',
      suites: [],
    }),
    // Empty criteria — a real state the AI generator produces.
    makeQuestion({
      id: 'q5',
      name: 'Pricing',
      prompt: 'What does the Pro plan cost?',
      criteria: '',
      suites: ['Full regression'],
    }),
    // Archived: must not appear in counts or default views.
    makeQuestion({
      id: 'q6',
      name: 'Deprecated check',
      prompt: 'Old question',
      criteria: 'Old criteria',
      suites: ['Smoke'],
      archived: true,
    }),
  ];
}

/**
 * Build a RunResult.
 *
 * NOTE on `hashAtRun`: we check `'hashAtRun' in over` rather than using `??`,
 * so a test can pass an EXPLICIT undefined to exercise the missing-snapshot
 * path. With `??` the default would silently overwrite it and that branch
 * would never be tested — which is exactly the bug this comment exists to
 * stop someone reintroducing.
 */
export function makeResult(over: Partial<RunResult> = {}): RunResult {
  const prompt = over.prompt ?? 'Can you tell me a joke?';
  const criteria = over.criteria ?? 'Politely declines';
  return {
    questionId: over.questionId ?? 'q2',
    questionName: over.questionName ?? 'Out of scope',
    prompt,
    criteria,
    outcome: over.outcome ?? 'failed',
    actual: over.actual ?? 'Sure! Why did the developer go broke?',
    judgeComment: over.judgeComment,
    suites: over.suites ?? ['Smoke'],
    traceId: over.traceId ?? 'tr_1',
    hashAtRun: 'hashAtRun' in over ? over.hashAtRun : contentHash(prompt, criteria),
    latencyMs: over.latencyMs,
  };
}

export function makeRun(over: Partial<Run> = {}): Run {
  return {
    id: over.id ?? 'run_1',
    name: over.name ?? 'run-2026-07-19',
    suite: over.suite,
    agentVersion: over.agentVersion ?? 'v14',
    createdAt: over.createdAt ?? new Date().toISOString(),
    results: over.results ?? [makeResult()],
    status: over.status ?? 'complete',
  };
}

/** Convert a Question fixture back to the Langfuse wire shape. */
export function toLangfuseItem(q: Question): LangfuseDatasetItem {
  return {
    id: q.id,
    datasetId: 'ds_lib',
    input: { question: q.prompt },
    expectedOutput: { criteria: q.criteria },
    metadata: { name: q.name, suites: q.suites, tags: q.tags },
    status: q.archived ? 'ARCHIVED' : 'ACTIVE',
  };
}

/**
 * Build an ApiClient backed by a route table instead of the network.
 * Simpler than MSW for these tests and keeps failures explicit — an
 * unmatched route throws with the URL, so a typo fails loudly.
 */
export function stubClient(
  routes: Record<string, (url: URL, init?: RequestInit) => unknown>,
): ApiClient {
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const key = Object.keys(routes).find((k) => url.pathname.includes(k));
    if (!key) {
      return new Response(JSON.stringify({ error: `No stub for ${url.pathname}` }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    const body = routes[key](url, init);
    if (body instanceof Response) return body;
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  return new ApiClient({ baseUrl: 'http://test.local/api', fetchImpl, maxAttempts: 1 });
}

/** Standard paginated envelope. */
export function page<T>(data: T[]) {
  return { data, meta: { page: 1, limit: 50, totalItems: data.length, totalPages: 1 } };
}

/**
 * Render a route with all providers.
 * Each call gets a fresh QueryClient so cached data cannot leak between tests.
 */
export function renderRoute(
  ui: ReactElement,
  opts: {
    path?: string;
    route?: string;
    client?: ApiClient;
    config?: Partial<EvalsConfig>;
  } = {},
): RenderResult {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
  });
  const config = { ...TEST_CONFIG, ...opts.config };
  const path = opts.path ?? '/';
  const route = opts.route ?? path;

  return render(
    <QueryClientProvider client={qc}>
      <ApiProvider config={config} client={opts.client}>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path={route} element={ui} />
            <Route path="*" element={ui} />
          </Routes>
        </MemoryRouter>
      </ApiProvider>
    </QueryClientProvider>,
  );
}
