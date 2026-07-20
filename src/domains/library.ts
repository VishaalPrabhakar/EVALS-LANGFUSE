/**
 * ============================================================================
 * THE LIBRARY MODEL
 * ============================================================================
 *
 * This module implements the central product decision: questions are owned at
 * the AGENT level (the library), and suites are SELECTIONS over them.
 *
 * Read `src/domain/langfuse.ts` first — it explains why Langfuse cannot do
 * this natively and how we work around it. Short version:
 *
 *   - One Langfuse Dataset per agent holds every question exactly once.
 *   - Suite membership lives in `DatasetItem.metadata.suites: string[]`.
 *   - Suites are DERIVED by scanning that field. No suite record exists.
 *
 * The invariant this buys us: question text exists in exactly one row, so two
 * suites can never disagree about what a correct answer is. Drift is
 * structurally impossible rather than merely discouraged.
 * ============================================================================
 */

import type { Question, Suite } from './model';

/** Product cap. See docs/DECISIONS.md ADR-005 for why 100. */
export const QUESTION_CAP = 100;

/** Show the cap counter in a warning colour at/above this fraction. */
export const CAP_WARN_AT = 0.85;

/**
 * Build the suite list by scanning every question's membership.
 *
 * Suites are derived, not stored, which has one important consequence:
 * REMOVING THE LAST QUESTION FROM A SUITE MAKES THE SUITE VANISH. That is
 * usually wrong — a user who empties a suite to rebuild it did not intend to
 * delete it. `knownSuites` preserves such suites with a count of 0 so the UI
 * can show an empty-suite state. See docs/EDGE_CASES.md #4.
 *
 * @param questions   All questions in the library (archived ones are ignored).
 * @param knownSuites Suite names to always include even at zero members.
 */
export function deriveSuites(questions: Question[], knownSuites: string[] = []): Suite[] {
  const counts = new Map<string, number>();

  for (const name of knownSuites) {
    if (name.trim()) counts.set(name, 0);
  }

  for (const q of questions) {
    // Archived questions do not run, so they must not inflate suite counts.
    // Getting this wrong shows "6 questions" next to a suite that runs 5.
    if (q.archived) continue;
    for (const s of q.suites) {
      counts.set(s, (counts.get(s) ?? 0) + 1);
    }
  }

  return [...counts.entries()]
    .map(([name, questionCount]) => ({ name, questionCount }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Questions that will actually execute when the given suite is run. */
export function questionsInSuite(questions: Question[], suite: string): Question[] {
  return questions.filter((q) => !q.archived && q.suites.includes(suite));
}

/**
 * Questions in no suite at all.
 *
 * This state cannot occur under suite-ownership but is new and important
 * under the library model: a question can exist, look fine in the table, and
 * never run. Silent no-ops are the worst failure mode for an evals tool, so
 * the library view flags these in amber and the coverage panel lists them.
 */
export function orphanQuestions(questions: Question[]): Question[] {
  return questions.filter((q) => !q.archived && q.suites.length === 0);
}

/**
 * Compute the metadata patch for toggling suite membership.
 *
 * Returns the NEW suites array. The caller writes it back via
 * `PATCH /dataset-items/:id`. Membership is a metadata edit on a single row —
 * never a copy — which is what makes drift impossible.
 *
 * Idempotent: adding twice is a no-op, removing an absent suite is a no-op.
 */
export function toggleMembership(current: string[], suite: string, include: boolean): string[] {
  const set = new Set(current);
  if (include) set.add(suite);
  else set.delete(suite);
  return [...set].sort();
}

/**
 * Rename a suite across the whole library.
 *
 * Because suites are derived from strings, a rename is an N-row metadata
 * update. It is NOT atomic — if the backend fails partway, some questions
 * carry the old name and some the new, and the UI will show two suites.
 *
 * The caller must handle partial failure. `src/api/suites.ts::renameSuite`
 * reports which ids succeeded so the UI can offer a retry on the remainder.
 * This is the main operational cost of deriving suites from metadata, and it
 * is documented in docs/DECISIONS.md ADR-003 as an accepted trade.
 */
export function planRename(
  questions: Question[],
  from: string,
  to: string,
): Array<{ id: string; suites: string[] }> {
  if (!to.trim() || from === to) return [];
  return questions
    .filter((q) => q.suites.includes(from))
    .map((q) => ({
      id: q.id,
      suites: [...new Set(q.suites.map((s) => (s === from ? to : s)))].sort(),
    }));
}

/**
 * Plan for deleting a suite. Removes the name from every member.
 * Questions themselves are untouched — deleting a suite must never delete
 * questions, or a user reorganising their tests would lose work.
 */
export function planDeleteSuite(
  questions: Question[],
  suite: string,
): Array<{ id: string; suites: string[] }> {
  return questions
    .filter((q) => q.suites.includes(suite))
    .map((q) => ({ id: q.id, suites: q.suites.filter((s) => s !== suite) }));
}

/**
 * Which suites lose coverage if this question is archived.
 * Drives the confirmation dialog: archiving the only Safety test should say
 * so loudly rather than silently reducing that suite to zero.
 */
export function suitesAffectedByArchive(
  questions: Question[],
  questionId: string,
): Array<{ suite: string; remaining: number }> {
  const target = questions.find((q) => q.id === questionId);
  if (!target) return [];
  return target.suites.map((suite) => ({
    suite,
    remaining: questionsInSuite(questions, suite).filter((q) => q.id !== questionId).length,
  }));
}

/** Cap state for the library counter. */
export function capState(activeCount: number): {
  atCap: boolean;
  near: boolean;
  remaining: number;
} {
  return {
    atCap: activeCount >= QUESTION_CAP,
    near: activeCount >= QUESTION_CAP * CAP_WARN_AT,
    remaining: Math.max(0, QUESTION_CAP - activeCount),
  };
}

/**
 * Detect near-duplicate questions.
 *
 * Under the library model a true duplicate should be impossible, but users
 * can still hand-write two questions that mean the same thing. Surfacing this
 * at write time is cheap insurance.
 *
 * Uses token-overlap (Jaccard) rather than edit distance because questions
 * are sentences: "How long to return an item?" and "What is the return
 * window?" are near-identical in meaning and far apart in characters.
 * Jaccard on lowercased word sets catches the former; nothing cheap catches
 * the latter, and we accept that.
 */
export function findSimilar(
  questions: Question[],
  prompt: string,
  threshold = 0.6,
  excludeId?: string,
): Question[] {
  const target = tokenize(prompt);
  if (target.size === 0) return [];
  return questions
    .filter((q) => !q.archived && q.id !== excludeId)
    .map((q) => ({ q, score: jaccard(target, tokenize(q.prompt)) }))
    .filter((x) => x.score >= threshold)
    .sort((a, b) => b.score - a.score)
    .map((x) => x.q);
}

/** Lowercase word set, stopwords removed. Exported for tests. */
export function tokenize(s: string): Set<string> {
  const STOP = new Set([
    'a', 'an', 'the', 'is', 'are', 'do', 'does', 'i', 'my', 'to', 'of', 'for',
    'and', 'or', 'in', 'on', 'it', 'you', 'your', 'what', 'how', 'can', 'me',
  ]);
  return new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 1 && !STOP.has(w)),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}
