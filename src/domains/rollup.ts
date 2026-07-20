/**
 * ============================================================================
 * PER-SUITE ROLLUP
 * ============================================================================
 *
 * Langfuse aggregates scores per DATASET. Because our library model puts every
 * question in one dataset (see langfuse.ts), Langfuse's native aggregate is
 * library-wide and cannot answer "how is the Smoke suite doing?".
 *
 * So we compute suite aggregates client-side from run results. This is the
 * accepted cost of the library model — documented in docs/DECISIONS.md ADR-003.
 *
 * Volume is bounded by the 100-question cap, so client-side aggregation is
 * cheap. If the cap is ever raised past ~1000, move this to the backend.
 * ============================================================================
 */

import type { Outcome, Run, RunResult, Suite } from './model';

export interface SuiteStats {
  suite: string;
  passed: number;
  failed: number;
  errored: number;
  total: number;
  /** 0..1. Errors are EXCLUDED from the denominator — see note below. */
  passRate: number;
  /** True when nothing in this suite has a conclusive result. */
  inconclusive: boolean;
}

/**
 * Aggregate one run's results by suite.
 *
 * ERROR HANDLING: a question whose score could not be interpreted is counted
 * in `errored` and excluded from the pass-rate denominator. Counting an
 * unreadable score as a failure would show a red suite for an infrastructure
 * problem, sending the user to debug a prompt that is fine. Counting it as a
 * pass would hide real failures. Excluding it, and surfacing the error count
 * separately, is the only honest option. See docs/EDGE_CASES.md #14.
 */
export function statsBySuite(run: Run): SuiteStats[] {
  const bySuite = new Map<string, RunResult[]>();

  for (const r of run.results) {
    // A result can belong to several suites; it counts in each.
    // A result in no suite still needs to appear somewhere, so it is filed
    // under the sentinel below rather than vanishing from the rollup.
    const keys = r.suites.length ? r.suites : [UNASSIGNED];
    for (const s of keys) {
      const arr = bySuite.get(s) ?? [];
      arr.push(r);
      bySuite.set(s, arr);
    }
  }

  return [...bySuite.entries()]
    .map(([suite, results]) => toStats(suite, results))
    .sort((a, b) => a.suite.localeCompare(b.suite));
}

/** Sentinel suite name for results whose question is in no suite. */
export const UNASSIGNED = '(not in a suite)';

function toStats(suite: string, results: RunResult[]): SuiteStats {
  const count = (o: Outcome) => results.filter((r) => r.outcome === o).length;
  const passed = count('passed');
  const failed = count('failed');
  const errored = count('error');
  const conclusive = passed + failed;
  return {
    suite,
    passed,
    failed,
    errored,
    total: results.length,
    passRate: conclusive === 0 ? 0 : passed / conclusive,
    inconclusive: conclusive === 0,
  };
}

/** Whole-run totals, using the same error-exclusion rule as above. */
export function overallStats(run: Run): SuiteStats {
  return toStats('__all__', run.results);
}

/**
 * Attach the most recent run's numbers to each derived suite, for the agent
 * home list. Suites with no run yet return `lastRun: undefined`, which the UI
 * renders as "Never run" rather than a misleading 0%.
 */
export function withLastRun(suites: Suite[], latestRun: Run | undefined): Suite[] {
  if (!latestRun) return suites;
  const stats = new Map(statsBySuite(latestRun).map((s) => [s.suite, s]));
  return suites.map((s) => {
    const st = stats.get(s.name);
    if (!st) return s;
    return {
      ...s,
      lastRun: {
        runId: latestRun.id,
        at: latestRun.createdAt,
        passed: st.passed,
        failed: st.failed,
      },
    };
  });
}

/** Format a pass rate for display. Returns '—' when inconclusive. */
export function formatRate(stats: SuiteStats): string {
  if (stats.inconclusive) return '—';
  return `${Math.round(stats.passRate * 100)}%`;
}
