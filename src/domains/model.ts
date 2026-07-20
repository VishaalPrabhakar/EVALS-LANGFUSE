/**
 * ============================================================================
 * UI DOMAIN MODEL
 * ============================================================================
 *
 * These are the shapes the React components consume. They are DERIVED from
 * the Langfuse wire types in `./langfuse.ts` — never fetched directly.
 *
 * The translation boundary is deliberate. Langfuse stores `input` and
 * `expectedOutput` as arbitrary JSON, and stores our suite membership inside
 * a metadata blob. Rather than let every component do defensive parsing, all
 * of that unwrapping happens exactly once, here, in `toQuestion()`.
 *
 * IF YOUR BACKEND STORES A DIFFERENT SHAPE: change `readText()` and
 * `toQuestion()` below. Nothing else in the codebase reaches into raw
 * Langfuse JSON.
 * ============================================================================
 */

import type {
  LangfuseDatasetItem,
  LangfuseDatasetRun,
  LangfuseScore,
} from './langfuse';

/** Test outcome for a single question within a run. */
export type Outcome = 'passed' | 'failed' | 'running' | 'queued' | 'error';

/**
 * A test question as the UI thinks about it.
 * Flat, all-strings, no optional JSON — safe to render without guards.
 */
export interface Question {
  id: string;
  /** Human label. Falls back to a truncated question if metadata.name is absent. */
  name: string;
  /** What the user asks the agent. */
  prompt: string;
  /** What a good answer must contain. May be empty — that is a valid state. */
  criteria: string;
  /**
   * Names of suites this question belongs to.
   * EMPTY ARRAY IS MEANINGFUL: an orphan question never runs. The library
   * view flags this in amber. See docs/EDGE_CASES.md #7.
   */
  suites: string[];
  /** Free-form tags from metadata.tags. Used by the library filter. */
  tags: string[];
  archived: boolean;
  updatedAt?: string;
  /**
   * Content hash used to detect edits between runs.
   * See `contentHash()` below and docs/DECISIONS.md ADR-004.
   */
  hash: string;
}

/**
 * A suite — a named selection of questions.
 *
 * IMPORTANT: this is a DERIVED object. There is no suite record in Langfuse.
 * Suites are computed by scanning every question's `metadata.suites` and
 * grouping. See `src/domain/library.ts::deriveSuites`.
 */
export interface Suite {
  name: string;
  description?: string;
  /** Number of ACTIVE questions currently selecting this suite. */
  questionCount: number;
  lastRun?: {
    runId: string;
    at: string;
    passed: number;
    failed: number;
  };
}

/** One question's result within a run. */
export interface RunResult {
  questionId: string;
  questionName: string;
  prompt: string;
  criteria: string;
  outcome: Outcome;
  /** The agent's actual answer. Empty while running/queued. */
  actual: string;
  /** LLM judge reasoning, from Score.comment. Drives root-cause grouping. */
  judgeComment?: string;
  /** Which suites contained this question AT RUN TIME (snapshotted). */
  suites: string[];
  traceId?: string;
  /** Content hash at run time. Compared against current to detect drift. */
  hashAtRun?: string;
  latencyMs?: number;
}

/** A completed or in-flight run. */
export interface Run {
  id: string;
  name: string;
  /** Suite this run targeted. `undefined` means all suites. */
  suite?: string;
  /** Saved agent version this ran against. See ADR-001: runs target SAVED. */
  agentVersion?: string;
  createdAt: string;
  results: RunResult[];
  status: 'running' | 'complete' | 'failed';
}

/**
 * A cluster of failures sharing one underlying cause.
 * Produced by `src/domain/grouping.ts`. This is the highest-value transform
 * in the app: it turns 30 flat failures into 2 actionable problems.
 */
export interface FailureGroup {
  id: string;
  /** Short human title, e.g. "No scope boundary in the system prompt". */
  cause: string;
  /** The suggested remediation, surfaced once per group rather than per test. */
  fix: string;
  /** Failing results attributed to this cause. Never empty. */
  results: RunResult[];
  /** Distinct suites touched. Used for the "spans N suites" affordance. */
  suites: string[];
  /** 0..1 clustering confidence. Below CONFIDENCE_FLOOR we do not group. */
  confidence: number;
}

// ---------------------------------------------------------------------------
// Translation helpers
// ---------------------------------------------------------------------------

/**
 * Pull a display string out of Langfuse's arbitrary-JSON fields.
 *
 * Handles the three shapes we see in practice:
 *   "some text"                  -> "some text"
 *   { question: "some text" }    -> "some text"   (via `keys`)
 *   { foo: 1 }                   -> '{"foo":1}'   (last-resort stringify)
 *
 * Returns '' for null/undefined so callers never need a guard.
 *
 * @param value Raw value from a Langfuse JSON field.
 * @param keys  Preferred object keys to look for, in priority order.
 */
export function readText(value: unknown, keys: string[] = []): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;

    // A key we expected, holding a non-empty string: use it.
    for (const k of keys) {
      const v = obj[k];
      if (typeof v === 'string' && v.trim()) return v;
    }

    // A key we expected, holding an EMPTY string: that is a real, intentional
    // empty value — return '' so the UI can render "No criteria set".
    //
    // Without this branch we fall through to JSON.stringify and the user sees
    // the literal text {"criteria":""} in the table. That was a real bug; the
    // regression test lives in domain.test.ts under EDGE 10.
    for (const k of keys) {
      if (typeof obj[k] === 'string') return '';
    }

    // Common Langfuse convention for chat-style inputs.
    if (Array.isArray(obj.messages)) {
      const last = obj.messages[obj.messages.length - 1] as Record<string, unknown> | undefined;
      if (last && typeof last.content === 'string') return last.content;
    }

    // Genuinely unrecognised shape. Stringify rather than silently dropping
    // data the user may need in order to debug their own pipeline.
    try {
      return JSON.stringify(value);
    } catch {
      return '';
    }
  }
  return '';
}

/**
 * Stable content hash for drift detection.
 *
 * WHY: runs snapshot the question set. When comparing two runs, we must
 * distinguish "the agent got worse" from "someone edited the criteria".
 * Comparing hashes tells us which. See docs/DECISIONS.md ADR-004 and the
 * comparison route.
 *
 * This is FNV-1a — not cryptographic, just a fast stable digest. Collisions
 * are irrelevant here: a false "unchanged" on a 32-bit hash is vanishingly
 * unlikely and the consequence is a misleading comparison row, not data loss.
 *
 * NOTE: only prompt + criteria are hashed. Renaming a question or moving it
 * between suites does NOT invalidate historical comparisons, which is correct
 * — neither changes what the agent was scored against.
 */
export function contentHash(prompt: string, criteria: string): string {
  const s = `${prompt}\u0000${criteria}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** Read a string array out of a metadata blob, tolerating junk. */
function readStringArray(meta: Record<string, unknown> | undefined, key: string): string[] {
  const raw = meta?.[key];
  if (!Array.isArray(raw)) return [];
  return raw.filter((x): x is string => typeof x === 'string' && x.trim().length > 0);
}

/**
 * Convert a raw Langfuse DatasetItem into the UI's Question shape.
 *
 * This is the single translation point. Every assumption about how question
 * data is stored lives here and nowhere else.
 */
export function toQuestion(item: LangfuseDatasetItem): Question {
  const meta = item.metadata ?? {};
  const prompt = readText(item.input, ['question', 'prompt', 'text', 'input']);
  const criteria = readText(item.expectedOutput, ['criteria', 'expected', 'answer', 'output']);

  // Name falls back to a truncated prompt so the table never renders a blank
  // first column. Empty-name questions are a real state — the AI generator
  // sometimes omits it. See docs/EDGE_CASES.md #12.
  const rawName = typeof meta.name === 'string' ? meta.name.trim() : '';
  const name = rawName || (prompt ? truncate(prompt, 48) : 'Untitled question');

  return {
    id: item.id,
    name,
    prompt,
    criteria,
    suites: readStringArray(meta, 'suites'),
    tags: readStringArray(meta, 'tags'),
    archived: item.status === 'ARCHIVED',
    updatedAt: item.updatedAt,
    hash: contentHash(prompt, criteria),
  };
}

/**
 * Truncate on a word boundary where possible, with an ellipsis.
 *
 * Cuts at the last COMPLETE word within `max`, so no partial word survives.
 * Falls back to a hard cut when the first word is itself longer than `max`
 * (a URL or an unbroken token), because returning an ellipsis alone would be
 * useless.
 */
export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const sp = cut.lastIndexOf(' ');
  // Require the boundary to retain something meaningful; otherwise hard-cut.
  const body = sp > 0 ? cut.slice(0, sp) : cut;
  return `${body.trimEnd()}…`;
}

/**
 * Interpret a Langfuse Score as a pass/fail outcome.
 *
 * Langfuse scores are deliberately unconstrained, so we accept several
 * conventions rather than forcing the backend to emit one:
 *
 *   BOOLEAN     -> 1 / true  = pass
 *   NUMERIC     -> >= threshold = pass (default 0.5, configurable)
 *   CATEGORICAL -> 'pass'|'correct'|'yes'|'true' = pass (case-insensitive)
 *
 * Returns 'error' for a score we cannot interpret rather than silently
 * defaulting to failed — a misread score that reads as a failure would send
 * users chasing a bug that isn't there. See docs/EDGE_CASES.md #14.
 */
export function scoreToOutcome(score: LangfuseScore | undefined, threshold = 0.5): Outcome {
  if (!score) return 'error';
  const { value, dataType } = score;

  if (dataType === 'BOOLEAN' || typeof value === 'boolean') {
    return Number(value) === 1 ? 'passed' : 'failed';
  }
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return 'error';
    return value >= threshold ? 'passed' : 'failed';
  }
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    if (['pass', 'passed', 'correct', 'yes', 'true', 'good'].includes(v)) return 'passed';
    if (['fail', 'failed', 'incorrect', 'no', 'false', 'bad'].includes(v)) return 'failed';
    const n = Number(v);
    if (!Number.isNaN(n)) return n >= threshold ? 'passed' : 'failed';
    return 'error';
  }
  return 'error';
}

/** Convert a Langfuse run record to our Run shell (results filled separately). */
export function toRunShell(run: LangfuseDatasetRun): Omit<Run, 'results'> {
  const meta = run.metadata ?? {};
  return {
    id: run.id,
    name: run.name,
    suite: typeof meta.suite === 'string' ? meta.suite : undefined,
    agentVersion: typeof meta.agentVersion === 'string' ? meta.agentVersion : undefined,
    createdAt: run.createdAt ?? new Date().toISOString(),
    status: 'complete',
  };
}
