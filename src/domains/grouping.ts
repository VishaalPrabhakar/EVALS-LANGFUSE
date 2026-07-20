/**
 * ============================================================================
 * ROOT-CAUSE FAILURE GROUPING
 * ============================================================================
 *
 * Turns a flat list of failures into clusters that share one underlying
 * cause, so the user sees "2 problems" instead of "30 failures".
 *
 * WHY THIS MATTERS: with a 100-question cap, a bad prompt change can fail 30
 * tests at once. Thirty rows with thirty identical "Apply fix" buttons is
 * unusable. One row saying "no scope boundary — 30 tests" with one fix is
 * actionable. This is the highest-value transform in the app.
 *
 * ---------------------------------------------------------------------------
 * ⚠ THIS IS THE RISKIEST ASSUMPTION IN THE PRODUCT
 * ---------------------------------------------------------------------------
 *
 * Grouping quality depends entirely on the LLM judge writing consistent
 * `Score.comment` text. If your judge produces free-form prose that varies
 * per call, clustering degrades and the results screen becomes a flat list
 * with extra chrome — worse than no grouping.
 *
 * MITIGATIONS BUILT IN HERE:
 *
 *   1. PREFERRED PATH — the judge emits a structured `causeId` in the score
 *      comment as a JSON prefix, e.g.
 *          {"causeId":"missing-scope-boundary","fix":"Add a scope rule…"}
 *          followed by free prose.
 *      `parseJudgeComment()` extracts it. Grouping is then exact and
 *      confidence is 1.0. RECOMMEND YOUR BACKEND DO THIS.
 *
 *   2. FALLBACK PATH — no structured field, so we cluster on comment text
 *      similarity. Works acceptably when the judge is consistent; confidence
 *      is reported and shown in the UI.
 *
 *   3. SAFETY FLOOR — below CONFIDENCE_FLOOR we DO NOT GROUP. Every failure
 *      becomes its own single-item group and the UI renders a flat list.
 *      A wrong grouping is worse than none: it tells the user two unrelated
 *      bugs are one bug and hides the second behind a collapsed row.
 *
 * Validate against real judge output before trusting the clusters — see
 * docs/DECISIONS.md ADR-006.
 * ============================================================================
 */

import type { FailureGroup, RunResult } from './model';
import { tokenize } from './library';

/** Below this similarity we refuse to group. See mitigation 3 above. */
export const CONFIDENCE_FLOOR = 0.45;

/** Structured payload we hope the judge emits at the head of Score.comment. */
export interface JudgeComment {
  /** Stable identifier for the underlying cause. Enables exact grouping. */
  causeId?: string;
  /** Human title for the cause. */
  cause?: string;
  /** Suggested remediation, shown once per group. */
  fix?: string;
  /** Remaining free-text reasoning. */
  prose: string;
}

/**
 * Parse a judge comment that may or may not carry structured data.
 *
 * Accepts:
 *   - A leading JSON object followed by prose.
 *   - A fenced ```json block anywhere in the comment.
 *   - Plain prose (returns `{ prose }` only).
 *
 * Never throws. Malformed JSON degrades to plain prose, because a judge
 * emitting bad JSON must not blank the results screen.
 */
export function parseJudgeComment(comment: string | undefined): JudgeComment {
  if (!comment) return { prose: '' };
  const text = comment.trim();

  // Fenced block form.
  const fence = text.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
  if (fence) {
    const parsed = safeParse(fence[1]);
    if (parsed) {
      return { ...parsed, prose: text.replace(fence[0], '').trim() };
    }
  }

  // Leading-object form. Scan for the matching brace rather than regex-ing,
  // so nested objects in the payload do not truncate the match.
  if (text.startsWith('{')) {
    const end = matchBrace(text);
    if (end > 0) {
      const parsed = safeParse(text.slice(0, end + 1));
      if (parsed) {
        return { ...parsed, prose: text.slice(end + 1).trim() };
      }
    }
  }

  return { prose: text };
}

function safeParse(s: string): Omit<JudgeComment, 'prose'> | null {
  try {
    const o = JSON.parse(s) as Record<string, unknown>;
    if (typeof o !== 'object' || o === null) return null;
    return {
      causeId: typeof o.causeId === 'string' ? o.causeId : undefined,
      cause: typeof o.cause === 'string' ? o.cause : undefined,
      fix: typeof o.fix === 'string' ? o.fix : undefined,
    };
  } catch {
    return null;
  }
}

/** Index of the brace closing the object that starts at index 0. -1 if none. */
function matchBrace(s: string): number {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (esc) { esc = false; continue; }
    if (c === '\\') { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Cluster failures into root-cause groups.
 *
 * Strategy, in priority order:
 *   1. Exact grouping on `causeId` when the judge supplies it (confidence 1).
 *   2. Text-similarity clustering on judge prose (confidence = mean overlap).
 *   3. No grouping at all when confidence would fall below the floor.
 *
 * Deterministic: same input always yields the same output, including group
 * ordering (largest first, then alphabetical). Tests depend on this.
 *
 * @param failures Results with outcome 'failed'. Others are ignored defensively.
 */
export function groupFailures(failures: RunResult[]): FailureGroup[] {
  const fails = failures.filter((r) => r.outcome === 'failed');
  if (fails.length === 0) return [];

  const parsed = fails.map((r) => ({ result: r, judge: parseJudgeComment(r.judgeComment) }));

  // --- Path 1: structured causeId ---------------------------------------
  const structured = parsed.filter((p) => p.judge.causeId);
  if (structured.length === fails.length) {
    const byId = new Map<string, typeof parsed>();
    for (const p of parsed) {
      const id = p.judge.causeId as string;
      const arr = byId.get(id) ?? [];
      arr.push(p);
      byId.set(id, arr);
    }
    return finalize(
      [...byId.entries()].map(([id, members]) => ({
        id,
        cause: members[0].judge.cause ?? humanize(id),
        fix: members[0].judge.fix ?? '',
        results: members.map((m) => m.result),
        confidence: 1,
      })),
    );
  }

  // --- Path 2: text similarity ------------------------------------------
  // Single-link agglomerative clustering. O(n²), fine at n<=100.
  const tokensets = parsed.map((p) => tokenize(p.judge.prose || p.result.criteria));
  const clusters: number[][] = parsed.map((_, i) => [i]);
  const merged = new Set<number>();
  const scores: number[] = [];

  for (let i = 0; i < clusters.length; i++) {
    if (merged.has(i)) continue;
    for (let j = i + 1; j < clusters.length; j++) {
      if (merged.has(j)) continue;
      const sim = overlap(tokensets[i], tokensets[j]);
      if (sim >= CONFIDENCE_FLOOR) {
        clusters[i].push(...clusters[j]);
        merged.add(j);
        scores.push(sim);
      }
    }
  }

  const live = clusters.filter((_, i) => !merged.has(i));
  const meanConfidence = scores.length
    ? scores.reduce((a, b) => a + b, 0) / scores.length
    : 0;

  // --- Path 3: safety floor ---------------------------------------------
  // If we merged nothing, or merged with weak evidence, fall back to one
  // group per failure. The UI reads this as a flat list.
  if (live.length === fails.length || (scores.length > 0 && meanConfidence < CONFIDENCE_FLOOR)) {
    return finalize(
      parsed.map((p, i) => ({
        id: `ungrouped-${i}`,
        cause: p.judge.cause ?? p.result.questionName,
        fix: p.judge.fix ?? '',
        results: [p.result],
        confidence: 0,
      })),
    );
  }

  return finalize(
    live.map((idxs, n) => {
      const members = idxs.map((i) => parsed[i]);
      const withCause = members.find((m) => m.judge.cause);
      const withFix = members.find((m) => m.judge.fix);
      return {
        id: `cluster-${n}`,
        cause: withCause?.judge.cause ?? summarize(members.map((m) => m.judge.prose)),
        fix: withFix?.judge.fix ?? '',
        results: members.map((m) => m.result),
        confidence: meanConfidence,
      };
    }),
  );
}

/** Attach derived suite spans and apply deterministic ordering. */
function finalize(
  groups: Array<Omit<FailureGroup, 'suites'>>,
): FailureGroup[] {
  return groups
    .map((g) => ({
      ...g,
      suites: [...new Set(g.results.flatMap((r) => r.suites))].sort(),
    }))
    .sort((a, b) => b.results.length - a.results.length || a.cause.localeCompare(b.cause));
}

function overlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / Math.min(a.size, b.size);
}

/** Best-effort human title when the judge gave no explicit cause. */
function summarize(proses: string[]): string {
  const first = proses.find((p) => p.trim());
  if (!first) return 'Related failures';
  const sentence = first.split(/(?<=[.!?])\s/)[0];
  return sentence.length > 80 ? `${sentence.slice(0, 77)}…` : sentence;
}

/** "missing-scope-boundary" -> "Missing scope boundary" */
function humanize(id: string): string {
  const s = id.replace(/[-_]+/g, ' ').trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}
