/**
 * ============================================================================
 * DOMAIN EDGE CASES
 * ============================================================================
 *
 * Each test is numbered to match docs/EDGE_CASES.md. If you change behaviour,
 * update both. These are the cases that produced real design decisions — they
 * are not coverage padding.
 * ============================================================================
 */

import { describe, expect, it } from 'vitest';
import {
  capState,
  deriveSuites,
  findSimilar,
  orphanQuestions,
  planDeleteSuite,
  planRename,
  QUESTION_CAP,
  questionsInSuite,
  suitesAffectedByArchive,
  toggleMembership,
} from '../domain/library';
import { contentHash, readText, scoreToOutcome, toQuestion, truncate } from '../domain/model';
import { groupFailures, parseJudgeComment } from '../domain/grouping';
import { compareRuns } from '../domain/compare';
import { overallStats, statsBySuite, UNASSIGNED } from '../domain/rollup';
import { makeLibrary, makeQuestion, makeResult, makeRun } from './fixtures';

// ---------------------------------------------------------------------------
// LIBRARY MODEL
// ---------------------------------------------------------------------------

describe('EDGE 1 — archived questions must not inflate suite counts', () => {
  it('excludes archived items from derived suite counts', () => {
    // The library fixture has an ARCHIVED question in "Smoke". If archived
    // items counted, Smoke would show 3 while only 2 actually run — the UI
    // would promise more coverage than exists.
    const suites = deriveSuites(makeLibrary());
    const smoke = suites.find((s) => s.name === 'Smoke');
    expect(smoke?.questionCount).toBe(2);
  });

  it('excludes archived items from questionsInSuite', () => {
    expect(questionsInSuite(makeLibrary(), 'Smoke').map((q) => q.id)).toEqual(['q1', 'q2']);
  });
});

describe('EDGE 2 — the question cap', () => {
  it('reports at-cap exactly at the limit, not one past it', () => {
    expect(capState(QUESTION_CAP - 1).atCap).toBe(false);
    expect(capState(QUESTION_CAP).atCap).toBe(true);
    expect(capState(QUESTION_CAP).remaining).toBe(0);
  });

  it('never reports negative remaining when over cap', () => {
    // Over-cap can happen if the backend allowed writes we did not.
    expect(capState(QUESTION_CAP + 50).remaining).toBe(0);
  });

  it('warns before the cap so it is not a surprise', () => {
    expect(capState(85).near).toBe(true);
    expect(capState(84).near).toBe(false);
  });
});

describe('EDGE 3 — orphan questions (new failure mode under the library model)', () => {
  it('finds questions in no suite', () => {
    expect(orphanQuestions(makeLibrary()).map((q) => q.id)).toEqual(['q4']);
  });

  it('does not report archived questions as orphans', () => {
    // An archived question in no suite is not an actionable gap — it is not
    // meant to run. Reporting it would train users to ignore the warning.
    const lib = [makeQuestion({ id: 'a', suites: [], archived: true })];
    expect(orphanQuestions(lib)).toHaveLength(0);
  });
});

describe('EDGE 4 — a suite emptied of all questions must not vanish', () => {
  it('keeps a known suite at zero members', () => {
    const suites = deriveSuites([makeQuestion({ suites: [] })], ['Smoke']);
    expect(suites.find((s) => s.name === 'Smoke')?.questionCount).toBe(0);
  });

  it('deduplicates when a known suite also has members', () => {
    const suites = deriveSuites([makeQuestion({ suites: ['Smoke'] })], ['Smoke']);
    expect(suites.filter((s) => s.name === 'Smoke')).toHaveLength(1);
    expect(suites[0].questionCount).toBe(1);
  });

  it('ignores blank known suite names', () => {
    expect(deriveSuites([], ['', '  '])).toHaveLength(0);
  });
});

describe('EDGE 5 — membership toggling is idempotent', () => {
  it('adding twice does not duplicate', () => {
    let s = toggleMembership(['Smoke'], 'Safety', true);
    s = toggleMembership(s, 'Safety', true);
    expect(s).toEqual(['Safety', 'Smoke']);
  });

  it('removing an absent suite is a no-op', () => {
    expect(toggleMembership(['Smoke'], 'Nope', false)).toEqual(['Smoke']);
  });

  it('output is sorted so writes are stable and diffable', () => {
    expect(toggleMembership(['Zeta', 'Alpha'], 'Mid', true)).toEqual(['Alpha', 'Mid', 'Zeta']);
  });
});

describe('EDGE 6 — suite rename is a non-atomic multi-row write', () => {
  it('plans an update for every member', () => {
    const plan = planRename(makeLibrary(), 'Smoke', 'Quick');
    // q1 and q2 are in Smoke; q6 is archived but still carries membership and
    // must be renamed too, or restoring it would resurrect a dead suite name.
    expect(plan.map((p) => p.id).sort()).toEqual(['q1', 'q2', 'q6']);
    expect(plan[0].suites).not.toContain('Smoke');
    expect(plan[0].suites).toContain('Quick');
  });

  it('refuses a rename to an empty name', () => {
    expect(planRename(makeLibrary(), 'Smoke', '   ')).toEqual([]);
  });

  it('refuses a no-op rename', () => {
    expect(planRename(makeLibrary(), 'Smoke', 'Smoke')).toEqual([]);
  });

  it('merges cleanly when renaming onto an existing suite name', () => {
    // Renaming Smoke -> Safety for q2, which is already in Safety, must not
    // produce a duplicate entry.
    const plan = planRename(makeLibrary(), 'Smoke', 'Safety');
    const q2 = plan.find((p) => p.id === 'q2');
    expect(q2?.suites.filter((s) => s === 'Safety')).toHaveLength(1);
  });
});

describe('EDGE 7 — deleting a suite must never delete questions', () => {
  it('only strips membership', () => {
    const plan = planDeleteSuite(makeLibrary(), 'Smoke');
    expect(plan.every((p) => !p.suites.includes('Smoke'))).toBe(true);
    // q1 keeps its other suite.
    expect(plan.find((p) => p.id === 'q1')?.suites).toEqual(['Full regression']);
  });
});

describe('EDGE 8 — archiving the last test in a suite', () => {
  it('reports which suites would be emptied', () => {
    const lib = [makeQuestion({ id: 'only', suites: ['Safety'] })];
    const affected = suitesAffectedByArchive(lib, 'only');
    expect(affected).toEqual([{ suite: 'Safety', remaining: 0 }]);
  });

  it('returns empty for an unknown question rather than throwing', () => {
    expect(suitesAffectedByArchive(makeLibrary(), 'nope')).toEqual([]);
  });
});

describe('EDGE 9 — near-duplicate detection', () => {
  it('matches semantically similar phrasing despite different words', () => {
    const lib = [makeQuestion({ id: 'a', prompt: 'How long do I have to return an item?' })];
    const hits = findSimilar(lib, 'How long do I have to return an item');
    expect(hits.map((h) => h.id)).toContain('a');
  });

  it('does not match unrelated questions', () => {
    const lib = [makeQuestion({ id: 'a', prompt: 'What does the Pro plan cost?' })];
    expect(findSimilar(lib, 'How do I reset my password?')).toHaveLength(0);
  });

  it('excludes the question being edited from its own duplicate check', () => {
    const lib = [makeQuestion({ id: 'a', prompt: 'Refund policy details please' })];
    expect(findSimilar(lib, 'Refund policy details please', 0.6, 'a')).toHaveLength(0);
  });

  it('handles an empty prompt without dividing by zero', () => {
    expect(findSimilar(makeLibrary(), '')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// PARSING & TRANSLATION
// ---------------------------------------------------------------------------

describe('EDGE 10 — Langfuse arbitrary-JSON fields', () => {
  it('reads a bare string', () => {
    expect(readText('hello')).toBe('hello');
  });

  it('reads a keyed object', () => {
    expect(readText({ question: 'hi' }, ['question'])).toBe('hi');
  });

  it('falls back through multiple keys in priority order', () => {
    expect(readText({ prompt: 'second' }, ['question', 'prompt'])).toBe('second');
  });

  it('reads the last message of a chat-shaped input', () => {
    expect(
      readText({ messages: [{ content: 'first' }, { content: 'last' }] }, ['question']),
    ).toBe('last');
  });

  it('returns empty string for null rather than throwing', () => {
    expect(readText(null)).toBe('');
    expect(readText(undefined)).toBe('');
  });

  it('stringifies an unrecognised object instead of losing the data', () => {
    expect(readText({ weird: 1 }, ['question'])).toBe('{"weird":1}');
  });

  it('ignores blank string values when choosing a key', () => {
    expect(readText({ question: '   ', prompt: 'real' }, ['question', 'prompt'])).toBe('real');
  });

  it('REGRESSION: an intentionally empty field returns "", not stringified JSON', () => {
    // Real bug found in testing: an empty criteria rendered in the library
    // table as the literal text {"criteria":""} because the empty string is
    // falsy and we fell through to JSON.stringify.
    expect(readText({ criteria: '' }, ['criteria'])).toBe('');
    expect(readText({ question: '' }, ['question'])).toBe('');
  });

  it('still stringifies genuinely unrecognised shapes', () => {
    // The fix above must not swallow data from a shape we do not understand.
    expect(readText({ somethingElse: 5 }, ['criteria'])).toBe('{"somethingElse":5}');
  });
});

describe('EDGE 11 — question conversion tolerates missing fields', () => {
  it('synthesises a name when metadata.name is absent', () => {
    const q = toQuestion({ id: 'x', datasetId: 'd', input: { question: 'Some long question here' } });
    expect(q.name).toBe('Some long question here');
  });

  it('falls back to a placeholder when there is no text at all', () => {
    const q = toQuestion({ id: 'x', datasetId: 'd' });
    expect(q.name).toBe('Untitled question');
    expect(q.prompt).toBe('');
    expect(q.criteria).toBe('');
  });

  it('survives junk in metadata.suites', () => {
    // A non-array, or an array of non-strings, must not crash the library view.
    const q = toQuestion({
      id: 'x',
      datasetId: 'd',
      metadata: { suites: 'not-an-array' as unknown as string[] },
    });
    expect(q.suites).toEqual([]);

    const q2 = toQuestion({
      id: 'y',
      datasetId: 'd',
      metadata: { suites: [1, null, 'Real', ''] as unknown as string[] },
    });
    expect(q2.suites).toEqual(['Real']);
  });

  it('marks ARCHIVED status correctly', () => {
    expect(toQuestion({ id: 'x', datasetId: 'd', status: 'ARCHIVED' }).archived).toBe(true);
    expect(toQuestion({ id: 'x', datasetId: 'd' }).archived).toBe(false);
  });
});

describe('EDGE 12 — content hashing for drift detection', () => {
  it('is stable across calls', () => {
    expect(contentHash('a', 'b')).toBe(contentHash('a', 'b'));
  });

  it('changes when criteria change', () => {
    expect(contentHash('q', 'old')).not.toBe(contentHash('q', 'new'));
  });

  it('cannot be fooled by moving text across the field boundary', () => {
    // Without a separator, ('ab','c') and ('a','bc') would collide and a real
    // edit would read as unchanged.
    expect(contentHash('ab', 'c')).not.toBe(contentHash('a', 'bc'));
  });

  it('handles empty strings', () => {
    expect(contentHash('', '')).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe('EDGE 13 — truncation', () => {
  it('leaves short strings alone', () => {
    expect(truncate('short', 20)).toBe('short');
  });

  it('breaks on a word boundary when one is available', () => {
    expect(truncate('hello wonderful world', 12)).toBe('hello…');
  });

  it('hard-cuts when there is no usable boundary', () => {
    expect(truncate('aaaaaaaaaaaaaaaaaaaa', 5)).toBe('aaaaa…');
  });
});

describe('EDGE 14 — score interpretation must not turn infra errors into failures', () => {
  it('reads boolean scores', () => {
    expect(scoreToOutcome({ id: '1', name: 'c', value: 1, dataType: 'BOOLEAN' })).toBe('passed');
    expect(scoreToOutcome({ id: '1', name: 'c', value: 0, dataType: 'BOOLEAN' })).toBe('failed');
  });

  it('reads numeric scores against the threshold', () => {
    expect(scoreToOutcome({ id: '1', name: 'c', value: 0.9 })).toBe('passed');
    expect(scoreToOutcome({ id: '1', name: 'c', value: 0.2 })).toBe('failed');
    expect(scoreToOutcome({ id: '1', name: 'c', value: 0.5 })).toBe('passed'); // inclusive
  });

  it('reads categorical scores case-insensitively', () => {
    expect(scoreToOutcome({ id: '1', name: 'c', value: 'PASS' })).toBe('passed');
    expect(scoreToOutcome({ id: '1', name: 'c', value: 'incorrect' })).toBe('failed');
  });

  it('returns error, NOT failed, for a missing score', () => {
    // This is the important one. A missing score means the judge did not run.
    // Reporting it as a failure sends the user debugging a working prompt.
    expect(scoreToOutcome(undefined)).toBe('error');
  });

  it('returns error for an uninterpretable value', () => {
    expect(scoreToOutcome({ id: '1', name: 'c', value: 'banana' })).toBe('error');
    expect(scoreToOutcome({ id: '1', name: 'c', value: Number.NaN })).toBe('error');
  });
});

// ---------------------------------------------------------------------------
// ROOT-CAUSE GROUPING
// ---------------------------------------------------------------------------

describe('EDGE 15 — judge comment parsing', () => {
  it('parses a leading JSON object followed by prose', () => {
    const r = parseJudgeComment('{"causeId":"scope","fix":"Add a rule"} The agent joked.');
    expect(r.causeId).toBe('scope');
    expect(r.fix).toBe('Add a rule');
    expect(r.prose).toBe('The agent joked.');
  });

  it('parses a fenced json block', () => {
    const r = parseJudgeComment('Reasoning here.\n```json\n{"causeId":"x"}\n```');
    expect(r.causeId).toBe('x');
  });

  it('handles nested objects without truncating', () => {
    const r = parseJudgeComment('{"causeId":"a","meta":{"n":{"deep":1}}} tail');
    expect(r.causeId).toBe('a');
    expect(r.prose).toBe('tail');
  });

  it('handles braces inside strings', () => {
    const r = parseJudgeComment('{"causeId":"a","fix":"use {curly} braces"} tail');
    expect(r.fix).toBe('use {curly} braces');
    expect(r.prose).toBe('tail');
  });

  it('degrades to plain prose on malformed JSON rather than throwing', () => {
    const r = parseJudgeComment('{not valid json} still useful text');
    expect(r.causeId).toBeUndefined();
    expect(r.prose).toContain('still useful');
  });

  it('handles an undefined comment', () => {
    expect(parseJudgeComment(undefined).prose).toBe('');
  });
});

describe('EDGE 16 — failure grouping', () => {
  it('groups exactly on causeId when every failure has one', () => {
    const groups = groupFailures([
      makeResult({ questionId: 'a', judgeComment: '{"causeId":"scope","cause":"No scope rule","fix":"Add one"}' }),
      makeResult({ questionId: 'b', judgeComment: '{"causeId":"scope"}' }),
      makeResult({ questionId: 'c', judgeComment: '{"causeId":"tool","cause":"Tool misuse"}' }),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0].results).toHaveLength(2);
    expect(groups[0].confidence).toBe(1);
    // The fix from any member propagates to the group.
    expect(groups[0].fix).toBe('Add one');
  });

  it('spans suites — one cause appearing in several suites is ONE group', () => {
    const groups = groupFailures([
      makeResult({ questionId: 'a', suites: ['Smoke'], judgeComment: '{"causeId":"scope"}' }),
      makeResult({ questionId: 'b', suites: ['Safety'], judgeComment: '{"causeId":"scope"}' }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].suites).toEqual(['Safety', 'Smoke']);
  });

  it('returns empty for no failures', () => {
    expect(groupFailures([])).toEqual([]);
    expect(groupFailures([makeResult({ outcome: 'passed' })])).toEqual([]);
  });

  it('ignores non-failed results defensively', () => {
    const groups = groupFailures([
      makeResult({ questionId: 'a', outcome: 'failed', judgeComment: '{"causeId":"x"}' }),
      makeResult({ questionId: 'b', outcome: 'passed' }),
      makeResult({ questionId: 'c', outcome: 'error' }),
    ]);
    expect(groups.flatMap((g) => g.results)).toHaveLength(1);
  });

  it('does NOT group when similarity is below the confidence floor', () => {
    // Two unrelated failures. Grouping them would tell the user two separate
    // bugs are one bug and hide the second behind a collapsed row.
    const groups = groupFailures([
      makeResult({ questionId: 'a', judgeComment: 'The agent revealed configuration details' }),
      makeResult({ questionId: 'b', judgeComment: 'Latency exceeded the budget entirely' }),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups.every((g) => g.confidence === 0)).toBe(true);
  });

  it('is deterministic — same input, same group order', () => {
    const input = [
      makeResult({ questionId: 'a', judgeComment: '{"causeId":"z"}' }),
      makeResult({ questionId: 'b', judgeComment: '{"causeId":"a"}' }),
      makeResult({ questionId: 'c', judgeComment: '{"causeId":"a"}' }),
    ];
    const one = groupFailures(input).map((g) => g.id);
    const two = groupFailures(input).map((g) => g.id);
    expect(one).toEqual(two);
    // Largest group first.
    expect(one[0]).toBe('a');
  });

  it('humanises a causeId when the judge gave no display title', () => {
    const groups = groupFailures([makeResult({ judgeComment: '{"causeId":"missing-scope-boundary"}' })]);
    expect(groups[0].cause).toBe('Missing scope boundary');
  });
});

// ---------------------------------------------------------------------------
// COMPARISON & DRIFT
// ---------------------------------------------------------------------------

describe('EDGE 17 — comparison separates drift from regression', () => {
  it('classifies an unchanged question as comparable', () => {
    const before = makeRun({ results: [makeResult({ questionId: 'q', outcome: 'passed' })] });
    const after = makeRun({ results: [makeResult({ questionId: 'q', outcome: 'failed' })] });
    const c = compareRuns(before, after);
    expect(c.comparable).toHaveLength(1);
    expect(c.comparable[0].movement).toBe('broke');
    expect(c.summary.broke).toBe(1);
  });

  it('classifies an edited question as changed, NOT as a regression', () => {
    // This is the core of ADR-004. A tightened criteria must not read as the
    // agent getting worse.
    const before = makeRun({
      results: [makeResult({ questionId: 'q', criteria: 'Offers handoff', outcome: 'passed' })],
    });
    const after = makeRun({
      results: [
        makeResult({ questionId: 'q', criteria: 'Offers handoff AND collects a summary', outcome: 'failed' }),
      ],
    });
    const c = compareRuns(before, after);
    expect(c.comparable).toHaveLength(0);
    expect(c.changed).toHaveLength(1);
    expect(c.changed[0].changeNote).toBe('Criteria edited');
    // The regression is counted as unattributable, not as a real break.
    expect(c.summary.broke).toBe(0);
    expect(c.summary.unattributable).toBe(1);
  });

  it('treats a missing hash as changed, the conservative direction', () => {
    const before = makeRun({ results: [makeResult({ questionId: 'q', hashAtRun: undefined })] });
    const after = makeRun({ results: [makeResult({ questionId: 'q' })] });
    const c = compareRuns(before, after);
    expect(c.changed).toHaveLength(1);
    expect(c.changed[0].changeNote).toContain('No snapshot');
  });

  it('reports added and removed questions rather than dropping them', () => {
    const before = makeRun({ results: [makeResult({ questionId: 'gone' })] });
    const after = makeRun({ results: [makeResult({ questionId: 'new' })] });
    const c = compareRuns(before, after);
    expect(c.removed.map((r) => r.questionId)).toEqual(['gone']);
    expect(c.added.map((r) => r.questionId)).toEqual(['new']);
  });

  it('handles two empty runs', () => {
    const c = compareRuns(makeRun({ results: [] }), makeRun({ results: [] }));
    expect(c.comparable).toEqual([]);
    expect(c.summary.broke).toBe(0);
  });

  it('marks error outcomes as unknown movement, not as a fix or a break', () => {
    const before = makeRun({ results: [makeResult({ questionId: 'q', outcome: 'failed' })] });
    const after = makeRun({ results: [makeResult({ questionId: 'q', outcome: 'error' })] });
    const c = compareRuns(before, after);
    expect(c.comparable[0].movement).toBe('unknown');
  });

  it('detects a prompt edit distinctly from a criteria edit', () => {
    const before = makeRun({ results: [makeResult({ questionId: 'q', prompt: 'Old wording' })] });
    const after = makeRun({ results: [makeResult({ questionId: 'q', prompt: 'New wording' })] });
    expect(compareRuns(before, after).changed[0].changeNote).toBe('Question wording edited');
  });
});

// ---------------------------------------------------------------------------
// ROLLUP
// ---------------------------------------------------------------------------

describe('EDGE 18 — per-suite rollup', () => {
  it('counts a question in every suite it belongs to', () => {
    const run = makeRun({
      results: [makeResult({ questionId: 'a', suites: ['Smoke', 'Safety'], outcome: 'passed' })],
    });
    const stats = statsBySuite(run);
    expect(stats.map((s) => s.suite)).toEqual(['Safety', 'Smoke']);
    expect(stats.every((s) => s.passed === 1)).toBe(true);
  });

  it('files suite-less results under a sentinel instead of losing them', () => {
    const run = makeRun({ results: [makeResult({ suites: [] })] });
    expect(statsBySuite(run)[0].suite).toBe(UNASSIGNED);
  });

  it('EXCLUDES unscored results from the pass-rate denominator', () => {
    // 1 passed, 1 failed, 1 unscored => 50%, not 33%. Counting the error as a
    // failure would show a red suite for an infrastructure problem.
    const run = makeRun({
      results: [
        makeResult({ questionId: 'a', outcome: 'passed', suites: ['S'] }),
        makeResult({ questionId: 'b', outcome: 'failed', suites: ['S'] }),
        makeResult({ questionId: 'c', outcome: 'error', suites: ['S'] }),
      ],
    });
    const s = statsBySuite(run)[0];
    expect(s.passRate).toBe(0.5);
    expect(s.errored).toBe(1);
    expect(s.total).toBe(3);
  });

  it('reports inconclusive rather than 0% when nothing was scored', () => {
    // 0% and "we could not score anything" look identical otherwise, and the
    // first one sends the user panicking.
    const run = makeRun({ results: [makeResult({ outcome: 'error', suites: ['S'] })] });
    const s = statsBySuite(run)[0];
    expect(s.inconclusive).toBe(true);
    expect(s.passRate).toBe(0);
  });

  it('handles a run with no results', () => {
    const s = overallStats(makeRun({ results: [] }));
    expect(s.total).toBe(0);
    expect(s.inconclusive).toBe(true);
  });
});
