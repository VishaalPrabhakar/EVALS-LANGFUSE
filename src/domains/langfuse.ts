/**
 * ============================================================================
 * LANGFUSE WIRE TYPES
 * ============================================================================
 *
 * These types mirror the Langfuse public API exactly. They are the *wire*
 * format — what the backend actually returns. Do not add UI-only fields here.
 * UI concepts live in `./model.ts`, which is derived from these.
 *
 * Reference: https://langfuse.com/docs/evaluation/experiments/data-model
 *
 * ---------------------------------------------------------------------------
 * THE CORE MAPPING (read this before touching anything)
 * ---------------------------------------------------------------------------
 *
 *   Product concept   ->  Langfuse object
 *   ---------------------------------------------------------------
 *   Question          ->  DatasetItem   (input / expectedOutput)
 *   Suite             ->  Dataset
 *   Run               ->  DatasetRun + DatasetRunItem[]
 *   Pass / fail       ->  Score attached to the run item's traceId
 *   Fix suggestion    ->  Score.comment (LLM-as-judge reasoning)
 *   Soft delete       ->  DatasetItem.status = 'ARCHIVED'   (native!)
 *   Run snapshot      ->  Dataset versioning by timestamp   (native!)
 *
 * Two of our hardest product requirements — soft delete and immutable run
 * snapshots — are native Langfuse features. We do not reimplement them.
 *
 * ---------------------------------------------------------------------------
 * ⚠ THE ONE MISMATCH — READ THIS, IT EXPLAINS AN ENTIRE MODULE
 * ---------------------------------------------------------------------------
 *
 * Our product decision was a LIBRARY model: questions are owned at the agent
 * level, and a suite is a *selection* over them. One question can appear in
 * many suites without being copied. This was chosen deliberately to prevent
 * drift (see docs/DECISIONS.md, ADR-002).
 *
 * Langfuse does not support this natively. From the API docs:
 *
 *   "Dataset items are upserted on their id. Id needs to be unique
 *    (project-level) and cannot be reused across datasets."
 *
 * A DatasetItem belongs to exactly ONE Dataset. That is suite-ownership —
 * precisely the model we rejected.
 *
 * RESOLUTION (implemented in `src/domain/library.ts`):
 *
 *   1. One Dataset per agent acts as the LIBRARY. It holds every question
 *      exactly once. This is the single source of truth for question content.
 *
 *   2. Suite membership is stored in `DatasetItem.metadata.suites`, a string
 *      array of suite names. Adding a question to a suite is a metadata edit,
 *      not a copy. Question text lives in exactly one row, so it cannot drift.
 *
 *   3. A "suite run" is a DatasetRun over the library dataset that only
 *      executes the items whose metadata lists that suite. Langfuse supports
 *      running a subset of items, so this needs no extra backend work.
 *
 * WHY NOT one Dataset per suite? Because that forces copying the item into
 * each dataset, which reintroduces exactly the drift the library model
 * exists to prevent. Editing "refund window" would then need N writes and
 * could partially fail, leaving two suites disagreeing about correctness.
 *
 * COST OF THIS APPROACH: Langfuse's own UI will show one big dataset rather
 * than three neat ones, and its native per-dataset aggregate score is
 * library-wide rather than per-suite. We compute per-suite aggregates
 * ourselves in `src/domain/rollup.ts`. This is a deliberate trade — see
 * docs/DECISIONS.md ADR-003 for the full argument and the alternative.
 * ============================================================================
 */

/** Dataset item lifecycle. ARCHIVED is Langfuse's native soft delete. */
export type DatasetStatus = 'ACTIVE' | 'ARCHIVED';

/**
 * A Langfuse Dataset. In our mapping this is the per-agent question LIBRARY,
 * not a suite. Exactly one of these exists per agent.
 */
export interface LangfuseDataset {
  id: string;
  name: string;
  description?: string;
  metadata?: Record<string, unknown>;
  /** ISO timestamp. Langfuse bumps this on any item add/update/archive. */
  createdAt?: string;
  updatedAt?: string;
}

/**
 * A single test question.
 *
 * `input` and `expectedOutput` are typed `unknown` on the wire because
 * Langfuse allows arbitrary JSON. We narrow them in `src/domain/model.ts`
 * via `toQuestion()`, which is the ONLY place that should assume a shape.
 * If your backend stores a different shape, change that one function.
 */
export interface LangfuseDatasetItem {
  id: string;
  datasetId: string;
  /** Arbitrary JSON. Our convention: `{ question: string }` or a bare string. */
  input?: unknown;
  /** Arbitrary JSON. Our convention: `{ criteria: string }` or a bare string. */
  expectedOutput?: unknown;
  /**
   * Arbitrary JSON. WE STORE SUITE MEMBERSHIP HERE — see the mismatch note
   * above. Expected shape: `{ suites: string[], name?: string, tags?: string[] }`
   */
  metadata?: Record<string, unknown>;
  status?: DatasetStatus;
  sourceTraceId?: string;
  sourceObservationId?: string;
  createdAt?: string;
  updatedAt?: string;
}

/**
 * One execution of a dataset (or a subset of it) against the agent.
 *
 * We encode which suite was run, and which agent version it ran against,
 * in `metadata`. Langfuse has no first-class "suite" or "agent version"
 * concept, so this is our extension point.
 * Expected shape: `{ suite?: string, agentVersion?: string, datasetVersion?: string }`
 */
export interface LangfuseDatasetRun {
  id: string;
  name: string;
  description?: string;
  metadata?: Record<string, unknown>;
  datasetId: string;
  createdAt?: string;
}

/**
 * Links one DatasetItem to the Trace produced when the agent answered it.
 *
 * NOTE: this object does NOT contain the agent's answer or the pass/fail
 * result. It only holds pointers. To build a results view you need three
 * joins, which is what `src/api/results.ts` does:
 *
 *   DatasetRunItem.datasetItemId -> DatasetItem   (the question + criteria)
 *   DatasetRunItem.traceId       -> Trace          (the agent's actual answer)
 *   DatasetRunItem.traceId       -> Score[]        (pass/fail + judge comment)
 *
 * This N+1 shape is inherent to the Langfuse API. See `src/api/results.ts`
 * for how we batch it.
 */
export interface LangfuseDatasetRunItem {
  id: string;
  datasetRunId: string;
  datasetItemId: string;
  traceId: string;
  observationId?: string;
  createdAt?: string;
}

/** Score value types supported by Langfuse. */
export type ScoreDataType = 'NUMERIC' | 'CATEGORICAL' | 'BOOLEAN';

/**
 * An evaluation result.
 *
 * `comment` is load-bearing for us: it carries the LLM judge's reasoning,
 * which we parse into the "why did this fail" text and cluster on to produce
 * root-cause grouping. See `src/domain/grouping.ts`.
 *
 * A Score attaches to exactly one of traceId / sessionId / datasetRunId.
 * For per-question results we always use traceId.
 */
export interface LangfuseScore {
  id: string;
  name: string;
  value: number | string;
  dataType?: ScoreDataType;
  comment?: string;
  traceId?: string;
  sessionId?: string;
  datasetRunId?: string;
  observationId?: string;
  configId?: string;
  createdAt?: string;
}

/**
 * A Langfuse Trace — one end-to-end agent execution.
 * We only read `output` (the agent's answer) and `latency`. Everything else
 * is available but unused by this frontend.
 */
export interface LangfuseTrace {
  id: string;
  name?: string;
  input?: unknown;
  output?: unknown;
  metadata?: Record<string, unknown>;
  latency?: number;
  timestamp?: string;
}

/** Langfuse list endpoints are paginated with this envelope. */
export interface Paginated<T> {
  data: T[];
  meta: {
    page: number;
    limit: number;
    totalItems: number;
    totalPages: number;
  };
}
