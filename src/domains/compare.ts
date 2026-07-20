/**
 * ============================================================================
 * RUN COMPARISON & DRIFT DETECTION
 * ============================================================================
 *
 * The problem this solves: a user compares today's run to last week's and
 * sees "Escalation: passed -> failed". Two very different things cause that:
 *
 *   (a) The agent genuinely regressed.            <- act on this
 *   (b) Someone tightened the criteria.           <- do NOT act on this
 *
 * Conflating them destroys trust in the tool. A false regression sends
 * someone debugging a prompt that is fine.
 *
 * We distinguish them with the content hash captured at run time
 * (`RunResult.hashAtRun`, produced by `contentHash()` in model.ts). If the
 * hash differs between runs, the question was edited and the two results are
 * NOT comparable. The UI renders those in a separate, clearly-labelled table.
 *
 * See docs/DECISIONS.md ADR-004.
 * ============================================================================
 */

import type { Run, RunResult } from './model';

/** How a single question's outcome moved between two runs. */
export type Movement = 'fixed' | 'broke' | 'still-failing' | 'still-passing' | 'unknown';

export interface ComparisonRow {
  questionId: string;
  questionName: string;
  before?: RunResult;
  after?: RunResult;
  movement: Movement;
  /** True when the question text/criteria changed between the two runs. */
  changed: boolean;
  /** Human description of the edit, when we can characterise it. */
  changeNote?: string;
}

export interface Comparison {
  /** Questions whose definition was stable — these results are comparable. */
  comparable: ComparisonRow[];
  /** Questions edited between runs — results are NOT directly comparable. */
  changed: ComparisonRow[];
  /** Present in the later run only. */
  added: ComparisonRow[];
  /** Present in the earlier run only (archived, or removed from the suite). */
  removed: ComparisonRow[];
  summary: {
    fixed: number;
    broke: number;
    stillFailing: number;
    /** Regressions we cannot attribute, because the question changed. */
    unattributable: number;
  };
}

/**
 * Compare two runs.
 *
 * @param before The earlier run.
 * @param after  The later run.
 *
 * Both runs are matched on questionId. A question absent from either side
 * lands in `added` or `removed` rather than being silently dropped — a
 * disappeared test is itself worth showing, since it usually means someone
 * archived it or pulled it from the suite. See docs/EDGE_CASES.md #9.
 */
export function compareRuns(before: Run, after: Run): Comparison {
  const beforeById = new Map(before.results.map((r) => [r.questionId, r]));
  const afterById = new Map(after.results.map((r) => [r.questionId, r]));
  const allIds = new Set([...beforeById.keys(), ...afterById.keys()]);

  const comparable: ComparisonRow[] = [];
  const changed: ComparisonRow[] = [];
  const added: ComparisonRow[] = [];
  const removed: ComparisonRow[] = [];

  for (const id of [...allIds].sort()) {
    const b = beforeById.get(id);
    const a = afterById.get(id);

    if (!b && a) {
      added.push({
        questionId: id,
        questionName: a.questionName,
        after: a,
        movement: 'unknown',
        changed: false,
      });
      continue;
    }
    if (b && !a) {
      removed.push({
        questionId: id,
        questionName: b.questionName,
        before: b,
        movement: 'unknown',
        changed: false,
      });
      continue;
    }
    if (!b || !a) continue; // unreachable, satisfies the type narrowing

    // Hash absent on either side means we cannot prove stability. Treat as
    // changed rather than assuming comparable — the conservative direction,
    // because a false "comparable" produces a false regression.
    const hashesKnown = Boolean(b.hashAtRun && a.hashAtRun);
    const isChanged = !hashesKnown || b.hashAtRun !== a.hashAtRun;

    const row: ComparisonRow = {
      questionId: id,
      questionName: a.questionName,
      before: b,
      after: a,
      movement: movementOf(b, a),
      changed: isChanged,
      changeNote: isChanged ? describeChange(b, a, hashesKnown) : undefined,
    };

    if (isChanged) changed.push(row);
    else comparable.push(row);
  }

  return {
    comparable,
    changed,
    added,
    removed,
    summary: {
      fixed: comparable.filter((r) => r.movement === 'fixed').length,
      broke: comparable.filter((r) => r.movement === 'broke').length,
      stillFailing: comparable.filter((r) => r.movement === 'still-failing').length,
      unattributable: changed.filter((r) => r.movement === 'broke').length,
    },
  };
}

function movementOf(b: RunResult, a: RunResult): Movement {
  const bp = b.outcome === 'passed';
  const ap = a.outcome === 'passed';
  if (b.outcome === 'error' || a.outcome === 'error') return 'unknown';
  if (!bp && ap) return 'fixed';
  if (bp && !ap) return 'broke';
  if (!bp && !ap) return 'still-failing';
  return 'still-passing';
}

/** Characterise what changed, for the drift table's "What changed" column. */
function describeChange(b: RunResult, a: RunResult, hashesKnown: boolean): string {
  if (!hashesKnown) {
    return 'No snapshot recorded for one of these runs — treated as not comparable';
  }
  const promptChanged = b.prompt !== a.prompt;
  const criteriaChanged = b.criteria !== a.criteria;
  if (promptChanged && criteriaChanged) return 'Question and criteria both edited';
  if (promptChanged) return 'Question wording edited';
  if (criteriaChanged) return 'Criteria edited';
  // Hashes differ but visible text matches: whitespace or invisible edit.
  return 'Definition changed';
}

/**
 * True when a regression should be treated as suspect.
 * Used by the UI to caption a "broke" row inside the changed table with an
 * explicit "this may not be a real regression" note.
 */
export function isSuspectRegression(row: ComparisonRow): boolean {
  return row.changed && row.movement === 'broke';
}
