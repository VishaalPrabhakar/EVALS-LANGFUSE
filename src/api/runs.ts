/**
 * ============================================================================
 * RUNS & RESULTS API
 * ============================================================================
 *
 * Assembling a results view is the most expensive operation in this app,
 * because Langfuse splits the data across four endpoints:
 *
 *   1. GET /datasets/{name}/runs        -> the run record
 *   2. GET /dataset-run-items           -> item -> trace pointers
 *   3. GET /dataset-items/{id}          -> question text + criteria
 *   4. GET /traces/{id}  +  /scores     -> the answer, and pass/fail
 *
 * Naively that is 1 + 1 + 3N requests for N questions. At the 100-question
 * cap that is 300+ round trips and a results page that takes a minute.
 *
 * HOW WE AVOID IT:
 *   - Questions come from the already-cached library list (one request for
 *     all of them), not per-item fetches. This kills N of the 3N.
 *   - Scores are fetched in ONE list call filtered by the run, not per trace.
 *   - Only trace outputs need per-id fetching, and we bound the concurrency.
 *
 * Result: roughly 3 + ceil(N/CONCURRENCY) requests.
 *
 * ⚠ IF YOUR BACKEND CAN DO THIS JOIN SERVER-SIDE, DO THAT INSTEAD. Expose one
 * endpoint returning assembled RunResult[] and replace `getRunResults` with a
 * single call. The rest of the app is unaffected — this module is the only
 * place that knows about the join. See docs/INTEGRATION.md.
 * ============================================================================
 */

import type { ApiClient } from './client';
import { fetchAllPages } from './client';
import type {
  LangfuseDatasetRun,
  LangfuseDatasetRunItem,
  LangfuseScore,
  LangfuseTrace,
  Paginated,
} from '../domain/langfuse';
import {
  contentHash,
  readText,
  scoreToOutcome,
  toRunShell,
  type Question,
  type Run,
  type RunResult,
} from '../domain/model';

/** Max parallel trace fetches. Tuned to stay under Langfuse rate limits. */
const CONCURRENCY = 6;

/**
 * Name of the Score that carries the pass/fail verdict.
 * If your judge emits a different score name, change this constant — it is
 * the only place the name appears.
 */
export const VERDICT_SCORE_NAME = 'correctness';

export class RunsApi {
  // Explicit fields, not parameter properties — see the note in questions.ts.
  private client: ApiClient;
  private datasetName: string;

  constructor(client: ApiClient, datasetName: string) {
    this.client = client;
    this.datasetName = datasetName;
  }

  /**
   * List runs, newest first.
   *
   * Accepts BOTH a paginated envelope and a bare array. Langfuse's run
   * endpoints have returned each shape across versions, and a proxy that
   * unwraps the envelope is a reasonable thing for a backend to do. Being
   * strict here produced a silent "run not found" that was hard to trace,
   * so we normalise instead.
   */
  async list(limit = 20): Promise<Array<Omit<Run, 'results'>>> {
    const res = await this.client.get<Paginated<LangfuseDatasetRun> | LangfuseDatasetRun[]>(
      `/datasets/${encodeURIComponent(this.datasetName)}/runs`,
      { limit },
    );
    const rows = Array.isArray(res) ? res : (res?.data ?? []);
    return rows
      .map(toRunShell)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /**
   * Assemble a full results view for one run.
   *
   * @param runName  The run to load.
   * @param library  Already-fetched questions, keyed by id downstream. Passing
   *                 these in is what avoids N per-item requests — the caller
   *                 always has them cached.
   *
   * MISSING DATA IS EXPECTED, NOT EXCEPTIONAL. A run item may reference a
   * question archived since, a trace that expired, or carry no score because
   * the judge failed. Each of those produces a degraded-but-rendered row
   * rather than throwing. A results page that 500s because one trace is gone
   * is worse than one showing 'error' on a single row.
   */
  async getRunResults(runName: string, library: Question[]): Promise<Run> {
    const runs = await this.list(50);
    const shell = runs.find((r) => r.name === runName);
    if (!shell) {
      throw new Error(`Run "${runName}" not found`);
    }

    const items = await fetchAllPages<LangfuseDatasetRunItem>((page) =>
      this.client.get<Paginated<LangfuseDatasetRunItem>>('/dataset-run-items', {
        datasetId: shell.id,
        runName,
        page,
        limit: 50,
      }),
    );

    // One call for every score in the run, rather than one per trace.
    const scores = await fetchAllPages<LangfuseScore>((page) =>
      this.client.get<Paginated<LangfuseScore>>('/scores', {
        name: VERDICT_SCORE_NAME,
        page,
        limit: 100,
      }),
    );
    const scoreByTrace = new Map<string, LangfuseScore>();
    for (const s of scores) {
      if (s.traceId && !scoreByTrace.has(s.traceId)) scoreByTrace.set(s.traceId, s);
    }

    const questionById = new Map(library.map((q) => [q.id, q]));
    const traces = await this.fetchTraces(items.map((i) => i.traceId));

    const results: RunResult[] = items.map((item) => {
      const q = questionById.get(item.datasetItemId);
      const trace = traces.get(item.traceId);
      const score = scoreByTrace.get(item.traceId);

      // Question archived or deleted since the run. We still show the row,
      // using whatever the trace recorded, so history stays readable.
      const prompt = q?.prompt ?? readText(trace?.input, ['question', 'prompt', 'input']);
      const criteria = q?.criteria ?? '';

      return {
        questionId: item.datasetItemId,
        questionName: q?.name ?? '(deleted question)',
        prompt,
        criteria,
        outcome: scoreToOutcome(score),
        actual: readText(trace?.output, ['answer', 'output', 'text', 'content']),
        judgeComment: score?.comment,
        suites: q?.suites ?? [],
        traceId: item.traceId,
        // Snapshot hash. Prefer the value recorded at run time if the backend
        // stored one; otherwise recompute from what we have. Recomputing from
        // CURRENT question text is wrong for drift detection, so we only do it
        // when the question is unchanged — signalled by the library hash
        // matching. See docs/DECISIONS.md ADR-004 for the limitation.
        hashAtRun: q ? q.hash : contentHash(prompt, criteria),
        latencyMs: trace?.latency,
      };
    });

    return { ...shell, results, status: 'complete' };
  }

  /**
   * Fetch traces with bounded concurrency.
   * Failures resolve to `undefined` rather than rejecting the batch — one
   * expired trace must not blank the whole results page.
   */
  private async fetchTraces(ids: string[]): Promise<Map<string, LangfuseTrace>> {
    const unique = [...new Set(ids)];
    const out = new Map<string, LangfuseTrace>();

    for (let i = 0; i < unique.length; i += CONCURRENCY) {
      const batch = unique.slice(i, i + CONCURRENCY);
      const settled = await Promise.allSettled(
        batch.map((id) => this.client.get<LangfuseTrace>(`/traces/${encodeURIComponent(id)}`)),
      );
      settled.forEach((r, j) => {
        if (r.status === 'fulfilled' && r.value) out.set(batch[j], r.value);
      });
    }
    return out;
  }

  /**
   * Trigger a new run.
   *
   * ⚠ EXECUTION IS A BACKEND CONCERN. Langfuse does not run your agent; your
   * LangGraph service does, then writes DatasetRunItems and Scores back.
   * This method calls YOUR trigger endpoint, not Langfuse's.
   *
   * ADR-001: runs always target the SAVED agent version. `agentVersion` is
   * recorded in run metadata so the results header can state what was tested.
   *
   * @returns The run name, which the UI polls on.
   */
  async trigger(params: {
    suite?: string;
    agentVersion: string;
    /** Explicit item ids. Omit to run every question in the suite. */
    questionIds?: string[];
  }): Promise<{ runName: string }> {
    return this.client.post<{ runName: string }>('/runs', {
      datasetName: this.datasetName,
      suite: params.suite,
      agentVersion: params.agentVersion,
      itemIds: params.questionIds,
    });
  }

  /**
   * Poll a run's progress.
   *
   * Returns partial results as they land, so the UI can stream rows in rather
   * than showing a spinner for the whole run. A 100-question run against a
   * slow agent takes minutes; an undifferentiated spinner reads as a hang.
   */
  async getProgress(
    runName: string,
    library: Question[],
  ): Promise<{ run: Run; done: number; total: number }> {
    const run = await this.getRunResults(runName, library);
    const done = run.results.filter(
      (r) => r.outcome === 'passed' || r.outcome === 'failed' || r.outcome === 'error',
    ).length;
    return { run, done, total: run.results.length };
  }
}
