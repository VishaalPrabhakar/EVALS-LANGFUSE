# SPEC — exact shapes and behaviour

Reference companion to `BUILD_PLAN.md`. Every type, signature, and required
copy string. Where behaviour is subtle, the rule is stated as an assertion you
can turn directly into a test.

---

## Types

### `Outcome`

```ts
type Outcome = 'passed' | 'failed' | 'running' | 'queued' | 'error';
```

`'error'` means the score could not be interpreted. It is **not** a failure.

### `Question`

```ts
interface Question {
  id: string;
  name: string;        // falls back to truncated prompt, then 'Untitled question'
  prompt: string;      // '' is valid
  criteria: string;    // '' is valid and meaningful — renders "No criteria set"
  suites: string[];    // [] means the question NEVER RUNS (orphan)
  tags: string[];
  archived: boolean;
  updatedAt?: string;
  hash: string;        // contentHash(prompt, criteria)
}
```

### `Suite`

Derived, never stored.

```ts
interface Suite {
  name: string;
  description?: string;
  questionCount: number;   // ACTIVE members only
  lastRun?: { runId: string; at: string; passed: number; failed: number };
}
```

### `RunResult`

```ts
interface RunResult {
  questionId: string;
  questionName: string;
  prompt: string;
  criteria: string;
  outcome: Outcome;
  actual: string;          // '' while running/queued
  judgeComment?: string;   // drives grouping
  suites: string[];        // membership AT RUN TIME
  traceId?: string;
  hashAtRun?: string;      // undefined => treat as changed
  latencyMs?: number;
}
```

### `Run`

```ts
interface Run {
  id: string;
  name: string;
  suite?: string;          // undefined = all suites
  agentVersion?: string;
  createdAt: string;
  results: RunResult[];
  status: 'running' | 'complete' | 'failed';
}
```

### `FailureGroup`

```ts
interface FailureGroup {
  id: string;
  cause: string;           // human title
  fix: string;             // '' if the judge gave none
  results: RunResult[];    // never empty
  suites: string[];        // distinct suites spanned, sorted
  confidence: number;      // 0..1; 0 means grouping was refused
}
```

---

## Function contracts

### `readText(value: unknown, keys?: string[]): string`

| Input | Output |
|---|---|
| `null` / `undefined` | `''` |
| `'hello'` | `'hello'` |
| `42` | `'42'` |
| `{question:'hi'}` with `['question']` | `'hi'` |
| `{question:'  ', prompt:'real'}` with `['question','prompt']` | `'real'` |
| **`{criteria:''}` with `['criteria']`** | **`''`** ← branch 2 |
| `{messages:[{content:'a'},{content:'b'}]}` | `'b'` |
| `{other:1}` with `['criteria']` | `'{"other":1}'` |

### `contentHash(prompt: string, criteria: string): string`

8-char lowercase hex. FNV-1a over `` `${prompt}\u0000${criteria}` ``.

```ts
contentHash('a','b') === contentHash('a','b')      // stable
contentHash('q','old') !== contentHash('q','new')  // sensitive
contentHash('ab','c') !== contentHash('a','bc')    // separator required
```

### `truncate(s: string, max: number): string`

Cuts at the last complete word within `max`; hard-cuts if the first word is
longer than `max`.

```ts
truncate('short', 20)                 // 'short'
truncate('hello wonderful world', 12) // 'hello…'
truncate('aaaaaaaaaaaaaaaaaaaa', 5)   // 'aaaaa…'
```

### `scoreToOutcome(score?: LangfuseScore, threshold = 0.5): Outcome`

| Score | Result |
|---|---|
| `undefined` | `'error'` |
| `{value:1, dataType:'BOOLEAN'}` | `'passed'` |
| `{value:0, dataType:'BOOLEAN'}` | `'failed'` |
| `{value:0.9}` | `'passed'` |
| `{value:0.5}` | `'passed'` (inclusive) |
| `{value:0.2}` | `'failed'` |
| `{value:'PASS'}` | `'passed'` |
| `{value:'incorrect'}` | `'failed'` |
| `{value:'banana'}` | `'error'` |
| `{value:NaN}` | `'error'` |

Accepted pass strings: `pass`, `passed`, `correct`, `yes`, `true`, `good`.
Accepted fail strings: `fail`, `failed`, `incorrect`, `no`, `false`, `bad`.

### `deriveSuites(questions: Question[], knownSuites?: string[]): Suite[]`

- Skips archived questions when counting.
- Includes `knownSuites` at count 0.
- Ignores blank names.
- Deduplicates.
- Sorted by name.

### `toggleMembership(current: string[], suite: string, include: boolean): string[]`

Idempotent. Always returns a sorted array.

### `capState(activeCount: number)`

```ts
{ atCap: activeCount >= 100,
  near:  activeCount >= 85,
  remaining: Math.max(0, 100 - activeCount) }
```

### `parseJudgeComment(comment?: string): JudgeComment`

Returns `{ causeId?, cause?, fix?, prose }`. Never throws.

| Input | Result |
|---|---|
| `undefined` | `{prose:''}` |
| `'{"causeId":"x"} tail'` | `{causeId:'x', prose:'tail'}` |
| ` ```json\n{"causeId":"x"}\n``` ` | `{causeId:'x', ...}` |
| `'{"causeId":"a","meta":{"n":{"d":1}}} tail'` | `{causeId:'a', prose:'tail'}` |
| `'{"fix":"use {curly}"} tail'` | `{fix:'use {curly}', prose:'tail'}` |
| `'{not json} text'` | `{prose:'{not json} text'}` |

### `groupFailures(failures: RunResult[]): FailureGroup[]`

1. Filters to `outcome === 'failed'`.
2. If **every** failure has `causeId`, group exactly on it, confidence `1`.
3. Otherwise cluster on token overlap of prose.
4. If nothing merged **or** mean confidence `< 0.45`, return one group per
   failure with confidence `0`.
5. Sort by `results.length` descending, then `cause` ascending.

`humanize('missing-scope-boundary')` → `'Missing scope boundary'`.

### `compareRuns(before: Run, after: Run): Comparison`

Match on `questionId`.

| Condition | Bucket |
|---|---|
| In `after` only | `added` |
| In `before` only | `removed` |
| Both, hashes equal and both present | `comparable` |
| Both, hashes differ or either missing | `changed` |

`Movement`: `'fixed'`, `'broke'`, `'still-failing'`, `'still-passing'`,
`'unknown'`. Any `'error'` outcome on either side → `'unknown'`.

**Summary counts `broke` from `comparable` only.** A `'broke'` inside
`changed` counts as `unattributable`.

`changeNote` values:

| Condition | Note |
|---|---|
| Hash missing | `'No snapshot recorded for one of these runs — treated as not comparable'` |
| Prompt and criteria both differ | `'Question and criteria both edited'` |
| Prompt only | `'Question wording edited'` |
| Criteria only | `'Criteria edited'` |
| Hashes differ, text matches | `'Definition changed'` |

### `statsBySuite(run: Run): SuiteStats[]`

```ts
interface SuiteStats {
  suite: string; passed: number; failed: number; errored: number;
  total: number; passRate: number; inconclusive: boolean;
}
```

- A result counts in **every** suite it belongs to.
- Suite-less results file under `UNASSIGNED = '(not in a suite)'`.
- `passRate = passed / (passed + failed)` — **errors excluded**.
- `inconclusive = (passed + failed) === 0`, and `passRate` is then `0`.
- Sorted by suite name.

---

## Required copy strings

Tests assert on these. Reword only if you also update the tests.

### Agent home

| Context | String |
|---|---|
| Page title | `Evals` |
| Subtitle | `Check your agent still answers correctly before you deploy.` |
| First-run title | `Write your first test question` |
| First-run body | `A test question is something a real user would ask, plus what a good answer must include. Run them any time to catch regressions before you deploy.` |
| Primary action | `Generate questions with AI` |
| Secondary action | `Write one myself` |
| Stale draft | `You have unsaved changes. Tests run against the last saved version — save first to test your edits.` |
| Empty suite pill | `Empty` |
| Never run | `Never run` |
| Orphan gap | `Not in any suite — this never runs` |

### Library

| Context | String |
|---|---|
| Title | `Question library` |
| Subtitle | `Every question for this agent. Suites select from here — a question is stored once.` |
| Cap counter | `{n} / 100 questions` |
| At cap | `You've reached the 100-question limit. Suites are capped to keep runs fast. Archive questions you no longer use to make room.` |
| Empty criteria | `No criteria set` |
| Orphan badge | `Not in a suite` |
| Orphan tooltip | `Not in any suite — this question never runs` |
| Filter miss | `No questions match` |
| Filter miss body | `Try a different search term, or clear the filters to see everything.` |
| Footer | `Editing a question changes it everywhere it's used. The Used in column shows where before you edit.` |
| Archive dialog | `Archive this question?` |
| Archive body | `It stops running and disappears from suites, but stays readable in past runs. You can restore it any time.` |
| Last-in-suite warning | `This is the last question in {suite}. That suite will have nothing to run.` |

### Suite editor

| Context | String |
|---|---|
| Subtitle | `Pick which questions this suite includes.` |
| Selection count | `✓ {n} of {total} questions selected` |
| Per-run count | `{n} per run` |
| Empty suite | `This suite has no questions. It may have been emptied, or every question in it was archived. Tick questions below to rebuild it.` |
| No library | `No questions to select` |
| No library body | `Write questions in the library first, then come back to group them into a suite.` |
| Footer | `Unticking removes the question from this suite. It stays in the library and in any other suite that uses it.` |
| Delete note | `Questions stay in the library.` |
| Partial failure | `{n} of {total} changes didn't save. The suite is partially updated. Retry to finish.` |

### Run results

| Context | String |
|---|---|
| Section title | `What's broken` |
| Note format | `{n} failures · {m} causes` |
| Fix heading | `Suggested fix` |
| Apply button | `Apply to system prompt` |
| Applied state | `Applied` |
| Expected column | `A good answer includes` |
| Actual column | `Your agent said` |
| No answer | `No answer recorded` |
| Passing summary | `{n} passing tests` |
| All passed | `Everything passed` |
| All passed body | `No failures in this run. Compare against an earlier run to confirm nothing regressed.` |
| Empty run | `This run has no results` |
| Empty run body | `The run was created but nothing was executed. The suite may have been empty, or the run may still be starting.` |
| Unscored banner | `{n} questions couldn't be scored. These are excluded from the pass rate — they're an evaluation problem, not an agent failure.` |
| Low confidence | `Showing failures individually — there wasn't enough signal to group them by cause.` |
| Progress | `Running — {done} of {total} complete. Results appear as each question finishes.` |

### Compare

| Context | String |
|---|---|
| Title | `Compare runs` |
| Subtitle | `See what changed between two runs — and what isn't comparable.` |
| Too few runs | `Nothing to compare yet` |
| Too few body | `Comparison needs at least two runs. Run your suite again after making a change, then come back.` |
| No selection | `Pick two runs` |
| Same run | `Those are the same run` |
| Same run body | `Pick two different runs to see what changed between them.` |
| Drift banner | `{n} questions changed between these runs. Their results aren't directly comparable — the criteria the agent was scored against is different now.` |
| Changed section | `Changed since the earlier run` |
| Changed note | `Not directly comparable` |
| Comparable section | `Comparable results` |
| Nothing comparable | `Nothing is comparable` |
| Nothing comparable body | `Every question changed between these two runs, so no result can be attributed to the agent itself.` |
| Suspect regression | `May be the criteria change, not a regression` |
| Removed note | `Not in the later run — archived, or removed from the suite` |

### Error messages (`ApiError.userMessage`)

| Kind | Message |
|---|---|
| `network` | `Can't reach the evaluation service. Check your connection and try again.` |
| `auth` | `Your session has expired. Sign in again to continue.` |
| `notfound` | `That item no longer exists. It may have been deleted in another tab.` |
| `conflict` | `Someone else changed this while you were editing. Reload to see the latest.` |
| `ratelimit` | `Too many requests. Waiting a moment before retrying.` |
| `server` | `The evaluation service had a problem. This is usually temporary.` |
| `parse` | `The evaluation service returned something unexpected.` |

---

## Accessibility requirements

Enforced by test, not review.

- Every interactive control has an accessible name (`aria-label` or text).
- Suite editor checkboxes: `aria-label="Include {question name}"`.
- Errors use `role="alert"`; status banners use `role="status"`.
- The archive dialog has `role="dialog"`, `aria-modal="true"`, and
  `aria-labelledby`.
- Expand toggles carry `aria-expanded`.
- The cap counter is `aria-live="polite"`.
- `ScoreBar` has `role="img"` and a descriptive `aria-label`.
- Loading regions use `aria-busy="true"` plus a `.sr-only` "Loading…".

---

## Styles

Both stylesheets are reproduced verbatim in the shipped repository:

- `src/styles/tokens.css` — design tokens, reset, reduced-motion,
  focus-visible, `.sr-only`
- `src/styles/app.css` — component styles, flat single-class selectors

Copy them as-is. Class names are referenced by the route components and by
some tests.

Key classes: `.card`, `.card-h`, `.card-b`, `.btn`, `.btn-primary`,
`.btn-ghost`, `.btn-sm`, `.pill`, `.pill-pass`, `.pill-fail`, `.pill-warn`,
`.pill-ai`, `.pill-neutral`, `.banner`, `.banner-warn`, `.banner-error`,
`.banner-info`, `.tbl`, `.clamp`, `.more`, `.filters`, `.cap-counter`,
`.suite-row`, `.score`, `.track`, `.cause`, `.cause-h`, `.fix`, `.inst`,
`.diff`, `.box`, `.empty`, `.cov`, `.used-in`, `.selbar`, `.runtoast`.
