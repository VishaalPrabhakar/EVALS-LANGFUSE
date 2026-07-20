# BUILD PLAN — read this first

You are rebuilding this application from scratch. This document is an ordered
task list. Work through it top to bottom. Do not skip ahead, and do not
reorder — later steps depend on files created in earlier ones.

**Every step has a verification command.** Run it before moving on. If it
fails, fix it before continuing; a broken foundation compounds.

**When this document and your instinct disagree, follow this document.** Most
choices here look arbitrary and are not — the reasoning is in
`docs/DECISIONS.md`, keyed by ADR number. If a step cites an ADR, read it
before deviating.

---

## Conventions used in this file

| Marker | Meaning |
|---|---|
| ▶ **Do** | The action to take |
| ✅ **Verify** | Command that must pass before you continue |
| ⚠ **Trap** | A mistake that is easy to make here; read before writing code |
| 📖 **Why** | Pointer to the reasoning. Read if you want to change the design |

---

## Phase 0 — Scaffold (15 min)

### Step 0.1 — Create the project

▶ **Do**

```bash
npm create vite@latest agent-evals-frontend -- --template react-ts
cd agent-evals-frontend
npm install
```

✅ **Verify**

```bash
npm run build   # must succeed
```

### Step 0.2 — Install dependencies

▶ **Do**

```bash
npm i react-router-dom @tanstack/react-query
npm i -D vitest @testing-library/react @testing-library/user-event \
         @testing-library/jest-dom jsdom
```

⚠ **Trap** — Do not add a UI framework, a CSS-in-JS library, a state manager,
a date library, or a form library. The app deliberately uses none of these.
Adding them creates conflicts with the plain-CSS token system in Step 1.2.

✅ **Verify**

```bash
node -e "const p=require('./package.json');console.log(Object.keys(p.dependencies))"
# Expect exactly: @tanstack/react-query, react, react-dom, react-router-dom
```

### Step 0.3 — Configure Vitest

▶ **Do** — Replace `vite.config.ts`:

```ts
/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    css: false,
  },
});
```

▶ **Do** — Create `src/test/setup.ts`:

```ts
import '@testing-library/jest-dom/vitest';

// jsdom lacks these; components and routes call them.
if (!window.matchMedia) {
  window.matchMedia = ((q: string) => ({
    matches: false, media: q, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}
window.scrollTo = (() => {}) as typeof window.scrollTo;
```

▶ **Do** — Add scripts to `package.json`:

```json
"test": "vitest run",
"test:watch": "vitest",
"typecheck": "tsc -b --noEmit"
```

### Step 0.4 — Create the directory structure

▶ **Do**

```bash
mkdir -p src/api src/domain src/hooks src/components src/routes src/styles src/test docs
rm -rf src/assets src/App.css src/index.css
```

⚠ **Trap** — `erasableSyntaxOnly` is enabled by default in recent Vite React-TS
templates. It **forbids TypeScript parameter properties**:

```ts
constructor(private client: ApiClient) {}   // ❌ will not compile
```

Use explicit fields everywhere:

```ts
private client: ApiClient;
constructor(client: ApiClient) { this.client = client; }   // ✅
```

This bites in Step 3.2 and 3.3. Writing it correctly the first time saves a
debugging cycle.

✅ **Verify**

```bash
ls src   # api components domain hooks routes styles test
```

---

## Phase 1 — Domain layer (no React, no fetch)

Build this first and test it directly. It is pure logic, and 72 of the app's
149 tests live here. If the domain layer is right, the UI is mostly assembly.

⚠ **Trap** — Nothing in `src/domain/` may import from `src/api/`,
`src/hooks/`, or `src/routes/`. Dependencies point downward only. If you find
yourself needing an import from above, the logic is in the wrong layer.

### Step 1.1 — Langfuse wire types

▶ **Do** — Create `src/domain/langfuse.ts` with these interfaces:

| Interface | Required fields |
|---|---|
| `LangfuseDataset` | `id`, `name`, `description?`, `metadata?`, `createdAt?`, `updatedAt?` |
| `LangfuseDatasetItem` | `id`, `datasetId`, `input?: unknown`, `expectedOutput?: unknown`, `metadata?`, `status?: 'ACTIVE'\|'ARCHIVED'`, `createdAt?`, `updatedAt?` |
| `LangfuseDatasetRun` | `id`, `name`, `description?`, `metadata?`, `datasetId`, `createdAt?` |
| `LangfuseDatasetRunItem` | `id`, `datasetRunId`, `datasetItemId`, `traceId`, `observationId?`, `createdAt?` |
| `LangfuseScore` | `id`, `name`, `value: number\|string`, `dataType?`, `comment?`, `traceId?`, `datasetRunId?`, `createdAt?` |
| `LangfuseTrace` | `id`, `name?`, `input?`, `output?`, `metadata?`, `latency?`, `timestamp?` |
| `Paginated<T>` | `data: T[]`, `meta: { page, limit, totalItems, totalPages }` |

📖 **Why** — `input` and `expectedOutput` are `unknown` because Langfuse
allows arbitrary JSON there. Do not type them as strings; real data varies.

⚠ **Trap — the one thing that shapes the whole app.** Langfuse enforces that a
`DatasetItem` belongs to **exactly one** `Dataset`. Our product model needs a
question to appear in many suites. Resolution:

- One Dataset per agent is the **library**, holding every question once.
- Suite membership lives in `DatasetItem.metadata.suites: string[]`.
- Suites are **derived** by scanning that array. No suite record exists.

Do not create one Dataset per suite. That forces copying, which is the exact
failure the design prevents. 📖 ADR-002, ADR-003.

### Step 1.2 — Design tokens

▶ **Do** — Create `src/styles/tokens.css`. Use semantic names, not literal
colours (`--ok`, not `--green`), so a palette change does not require renaming.

```css
:root{
  --ink:#12211c; --ink-2:#4a5a54; --ink-3:#7e8d87;
  --paper:#fff; --wash:#f7f8f7; --line:#dfe4e1; --line-2:#eef1ef;
  --ok:#0f6b4f; --ok-soft:#e6f2ec;
  --bad:#b3261e; --bad-soft:#fbeceb;
  --warn:#8a5a00; --warn-soft:#fdf3e0; --warn-line:#ecd9ab;
  --ai:#5b3fd6; --ai-soft:#f3efff; --ai-line:#ddd3ff;
  --r:8px; --r-sm:6px;
  --font:ui-sans-serif,-apple-system,'Segoe UI',Inter,system-ui,sans-serif;
  --mono:ui-monospace,SFMono-Regular,Menlo,monospace;
  --fast:120ms;
}
```

Also include: a global reset, `prefers-reduced-motion` handling, a
`:focus-visible` outline, and a `.sr-only` utility. Full file in
`docs/SPEC.md` §Styles.

### Step 1.3 — The UI model and the translation boundary

▶ **Do** — Create `src/domain/model.ts` exporting:

**Types:** `Outcome`, `Question`, `Suite`, `RunResult`, `Run`, `FailureGroup`
(exact shapes in `docs/SPEC.md` §Types).

**Functions:** `readText`, `contentHash`, `toQuestion`, `truncate`,
`scoreToOutcome`, `toRunShell`.

⚠ **Trap — `readText` has three branches and the middle one is easy to miss.**

```
1. A wanted key holding a NON-EMPTY string  -> return it
2. A wanted key holding an EMPTY string     -> return ''      ← easy to miss
3. No wanted key at all                     -> JSON.stringify
```

Skipping branch 2 makes an intentionally-empty criteria render as the literal
text `{"criteria":""}` in the results table. This was a real bug found in
testing. 📖 EDGE_CASES #10.

⚠ **Trap — `contentHash` needs a separator.** Hash
`` `${prompt}\u0000${criteria}` ``, not `prompt + criteria`. Without the null
byte, `('ab','c')` and `('a','bc')` collide, so a real edit reads as unchanged
and drift detection silently fails. 📖 EDGE_CASES #12.

⚠ **Trap — `scoreToOutcome` must return `'error'`, never `'failed'`, for a
missing or uninterpretable score.** A missing score means the judge did not
run. Reporting it as a failure sends users debugging a prompt that is fine.
📖 ADR-009.

✅ **Verify** — Write tests before moving on:

```ts
expect(readText({criteria:''},['criteria'])).toBe('');
expect(readText({other:1},['criteria'])).toBe('{"other":1}');
expect(contentHash('ab','c')).not.toBe(contentHash('a','bc'));
expect(scoreToOutcome(undefined)).toBe('error');
```

### Step 1.4 — The library model

▶ **Do** — Create `src/domain/library.ts` exporting:

| Export | Purpose |
|---|---|
| `QUESTION_CAP = 100` | Product cap 📖 ADR-005 |
| `CAP_WARN_AT = 0.85` | Warn before the limit |
| `deriveSuites(questions, knownSuites)` | Suites from metadata |
| `questionsInSuite(questions, suite)` | Members, excluding archived |
| `orphanQuestions(questions)` | In no suite — these never run |
| `toggleMembership(current, suite, include)` | Idempotent, sorted output |
| `planRename(questions, from, to)` | N-row update plan |
| `planDeleteSuite(questions, suite)` | Strips membership only |
| `suitesAffectedByArchive(questions, id)` | Which suites would empty |
| `capState(activeCount)` | `{atCap, near, remaining}` |
| `findSimilar(questions, prompt, threshold, excludeId)` | Near-duplicates |
| `tokenize(s)` | Lowercase word set, stopwords removed |

⚠ **Trap — archived questions must be excluded from suite counts** but still
carry membership. If they counted, a suite advertises 3 questions while
running 2. 📖 EDGE_CASES #1.

⚠ **Trap — a suite emptied of all questions must not vanish.** Suites are
derived, so removing the last member deletes the suite. Accept a
`knownSuites: string[]` parameter and include those at count 0.
📖 EDGE_CASES #4.

⚠ **Trap — `planDeleteSuite` must never delete questions**, only membership.

⚠ **Trap — `findSimilar` uses token overlap (Jaccard), not edit distance.**
Questions are sentences: "How long to return an item?" and "What is the return
window?" are close in meaning and far apart in characters.

✅ **Verify**

```ts
// archived item in 'Smoke' must not count
expect(deriveSuites(libWithArchived).find(s=>s.name==='Smoke').questionCount).toBe(2);
expect(deriveSuites([], ['Smoke'])[0].questionCount).toBe(0);
expect(toggleMembership(['Zeta','Alpha'],'Mid',true)).toEqual(['Alpha','Mid','Zeta']);
expect(capState(100).atCap).toBe(true);
expect(capState(150).remaining).toBe(0);
```

### Step 1.5 — Root-cause grouping

▶ **Do** — Create `src/domain/grouping.ts` exporting `CONFIDENCE_FLOOR = 0.45`,
`parseJudgeComment`, and `groupFailures`.

This is the highest-value transform in the app and its riskiest assumption.
Implement all three paths:

1. **Structured** — every failure has `causeId` in its parsed comment. Group
   exactly on it. Confidence `1`.
2. **Similarity** — cluster on token overlap of judge prose. Confidence is the
   mean pairwise similarity.
3. **Floor** — if nothing merged, or mean confidence `< CONFIDENCE_FLOOR`,
   return **one group per failure** with confidence `0`. The UI renders this
   as a flat list.

⚠ **Trap — path 3 is not optional.** A wrong grouping tells the user two
unrelated bugs are one bug and hides the second behind a collapsed row.
Refusing to group is the safe failure mode. 📖 ADR-006.

⚠ **Trap — `parseJudgeComment` must brace-match, not regex.** The comment may
contain nested objects and braces inside strings:

```
{"causeId":"a","fix":"use {curly} braces"} trailing prose
```

A naive `/\{.*\}/` truncates this. Walk the string tracking depth, string
state, and escapes. Malformed JSON must degrade to plain prose, never throw.

⚠ **Trap — output must be deterministic.** Sort groups by size descending,
then by cause alphabetically. Tests depend on stable ordering.

✅ **Verify**

```ts
// spans suites: one cause in two suites is ONE group
expect(groupFailures([a_smoke, a_safety])).toHaveLength(1);
// refuses to group unrelated failures
expect(groupFailures([unrelated1, unrelated2])).toHaveLength(2);
// brace matching survives nested braces in strings
expect(parseJudgeComment('{"fix":"use {x}"} tail').prose).toBe('tail');
```

### Step 1.6 — Drift detection

▶ **Do** — Create `src/domain/compare.ts` exporting `Movement`,
`ComparisonRow`, `Comparison`, `compareRuns`, `isSuspectRegression`.

`compareRuns(before, after)` returns four buckets: `comparable`, `changed`,
`added`, `removed`, plus a `summary`.

⚠ **Trap — this is the entire point of the module.** A question whose
`hashAtRun` differs between runs goes in `changed`, **not** `comparable`, and a
pass→fail there counts as `summary.unattributable`, not `summary.broke`.
Without this split, a tightened criteria masquerades as the agent regressing
and sends someone debugging working code. 📖 ADR-004.

⚠ **Trap — a missing hash on either side is treated as `changed`.** The
conservative direction: a false "comparable" produces a false regression.

⚠ **Trap — do not drop added/removed questions.** A test that vanished usually
means someone archived it, which is itself worth showing.

✅ **Verify**

```ts
// edited criteria: pass->fail is NOT a regression
const c = compareRuns(runWithOldCriteria, runWithNewCriteria);
expect(c.summary.broke).toBe(0);
expect(c.summary.unattributable).toBe(1);
```

### Step 1.7 — Per-suite rollup

▶ **Do** — Create `src/domain/rollup.ts` exporting `SuiteStats`, `UNASSIGNED`,
`statsBySuite`, `overallStats`, `withLastRun`, `formatRate`.

⚠ **Trap — errored results are EXCLUDED from the pass-rate denominator.**
1 passed + 1 failed + 1 unscored = **50%**, not 33%. Counting an unreadable
score as a failure shows a red suite for an infrastructure problem.
📖 ADR-009.

⚠ **Trap — when nothing was scored, set `inconclusive: true`** and have the UI
render `—`, not `0%`. Those look identical otherwise and the first causes
unnecessary panic.

✅ **Verify**

```ts
expect(statsBySuite(runWith1Pass1Fail1Error)[0].passRate).toBe(0.5);
expect(statsBySuite(runWithOnlyErrors)[0].inconclusive).toBe(true);
```

### ✅ Phase 1 gate

```bash
npm test -- domain     # expect 74 passing
npm run typecheck      # must be clean
```

Do not proceed until both pass.

---

## Phase 2 — API layer

### Step 2.1 — HTTP client

▶ **Do** — Create `src/api/client.ts` exporting `ApiErrorKind`, `ApiError`,
`ClientConfig`, `ApiClient`, `fetchAllPages`.

`ApiError` carries `kind`, `status`, `retryable`, and a `userMessage` getter.

**Status → kind mapping:**

| Status | kind | retryable |
|---|---|---|
| 401, 403 | `auth` | no |
| 404 | `notfound` | no |
| 409 | `conflict` | no |
| 429 | `ratelimit` | **yes** |
| 5xx | `server` | **yes** |
| other 4xx | `client` | no |
| no response | `network` | **yes** |
| 2xx, bad JSON | `parse` | no |

⚠ **Trap — `retryable` drives whether the UI shows a retry button.** Offering
retry on a 400 is a dead action.

⚠ **Trap — 204 and empty bodies are SUCCESS.** DELETE and PATCH legitimately
return no content. Return `undefined`, do not throw.

⚠ **Trap — retry needs jitter.** Backoff `min(1000 * 2^(n-1), 8000)` plus
`random() * 250`. Without jitter, parallel requests retry in lockstep and
hammer a recovering server.

⚠ **Trap — `fetchAllPages` must stop on an empty page** even when `totalPages`
says otherwise. Some Langfuse versions report a stale count; without this the
loop runs to `maxPages` on every load.

⚠ **Trap — the auth token must never reach the browser in production.** Point
`baseUrl` at your own proxy. The `authToken` option is for local dev only.

✅ **Verify**

```ts
expect(new ApiError('server','x').retryable).toBe(true);
expect(new ApiError('client','x').retryable).toBe(false);
await expect(client.delete('/x')).resolves.toBeUndefined();  // 204
```

### Step 2.2 — Questions API

▶ **Do** — Create `src/api/questions.ts` exporting `QuestionDraft` and
`QuestionsApi` with: `list`, `get`, `create`, `update`, `setSuiteMembership`,
`setSuiteMembershipBulk`, `archive`, `restore`.

**Storage shape:**

```jsonc
{
  "input":          { "question": "<prompt>" },
  "expectedOutput": { "criteria": "<criteria>" },
  "metadata": { "name": "...", "suites": ["Smoke"], "tags": [] },
  "status": "ACTIVE"
}
```

⚠ **Trap — there must be NO copy operation in this file, ever.** Membership is
a metadata edit on one row. The absence of copying is what makes drift
structurally impossible. A test asserts this in Phase 5.

⚠ **Trap — `archive` uses `PATCH {status:'ARCHIVED'}`, never DELETE.**
Historical runs reference items; deleting one makes old comparisons
unreadable. 📖 ADR-008.

⚠ **Trap — `setSuiteMembership` must preserve name, criteria and tags.** It
reads the current item, changes only `suites`, and writes back. Forgetting
this blanks question content on every suite edit.

⚠ **Trap — `setSuiteMembershipBulk` runs writes SEQUENTIALLY** and returns
`{ok: string[], failed: {id,error}[]}`. Parallel bursts trip rate limits, and
silent partial success leaves the user unable to tell what their suite
contains.

⚠ **Trap — cap enforcement does NOT belong here.** It needs the current count,
which lives in the React Query cache. It goes in Phase 3.

### Step 2.3 — Runs API

▶ **Do** — Create `src/api/runs.ts` exporting `VERDICT_SCORE_NAME =
'correctness'` and `RunsApi` with `list`, `getRunResults`, `trigger`,
`getProgress`.

`getRunResults` performs a four-way join:

```
DatasetRunItem.datasetItemId -> Question (from the cached library, NOT refetched)
DatasetRunItem.traceId       -> Trace    (the agent's answer)
DatasetRunItem.traceId       -> Score    (pass/fail + judge comment)
```

⚠ **Trap — do not fetch questions per item.** Accept the already-cached
library as a parameter. Naive implementation is 1 + 1 + 3N requests; at the
100-question cap that is 300+ round trips.

⚠ **Trap — fetch scores in ONE list call** filtered by name, then index by
`traceId`. Not one call per trace.

⚠ **Trap — bound trace concurrency at 6** and use `Promise.allSettled`. One
expired trace must not blank the entire results page.

⚠ **Trap — `list` must accept BOTH a paginated envelope and a bare array.**
Real deployments return each. Being strict here produced a silent
"run not found" that was hard to trace:

```ts
const rows = Array.isArray(res) ? res : (res?.data ?? []);
```

⚠ **Trap — missing data is expected, not exceptional.** An archived question,
an expired trace, or a missing score each produce a degraded-but-rendered row.
Never throw from the join.

### Step 2.4 — API provider

▶ **Do** — Create `src/api/provider.tsx` exporting `EvalsConfig`,
`ApiProvider`, `useApi`.

`EvalsConfig` fields: `baseUrl`, `authToken?`, `datasetId`, `datasetName`,
`agentId`, `agentVersion`, `hasUnsavedChanges?`.

⚠ **Trap — accept an optional `client` prop.** This is the test seam. Without
it, route tests cannot stub HTTP.

### ✅ Phase 2 gate

```bash
npm test -- api        # expect 29 passing
npm run typecheck
```

---

## Phase 3 — Hooks

▶ **Do** — Create `src/hooks/useEvals.ts` exporting `qk` (query keys),
`useQuestions`, `useSuites`, `useCreateQuestion`, `useUpdateQuestion`,
`useArchiveQuestion`, `useRestoreQuestion`, `useSaveSuiteMembership`,
`useRenameSuite`, `useDeleteSuite`, `useRuns`, `useRun`, `useRunProgress`,
`useTriggerRun`, plus `readKnownSuites` / `rememberSuite` / `forgetSuite`
and `CapExceededError`.

⚠ **Trap — enforce the cap HERE**, in `useCreateQuestion`, by reading
`qc.getQueryData(qk.questions(false))`. Throw `CapExceededError` with a
message that tells the user what to do about it.

⚠ **Trap — wrap all `localStorage` access in try/catch.** Private browsing and
quota errors must not crash the home screen. Known suite names persist here so
an emptied suite does not vanish.

⚠ **Trap — `useRunProgress` must stop polling when done.** Use a function
`refetchInterval` returning `false` once `done >= total`, otherwise it polls a
finished run forever.

⚠ **Trap — centralise query keys in `qk`.** Invalidation drifting from
fetching is a class of bug that is painful to diagnose.

✅ **Verify** — Phase 3 has no dedicated tests; it is exercised in Phase 5.
Just confirm `npm run typecheck` is clean.

---

## Phase 4 — UI

### Step 4.1 — Component stylesheet

▶ **Do** — Create `src/styles/app.css`. Keep selectors flat and single-class
(`.card-h`, not `.card .header`) to avoid specificity conflicts. Full
stylesheet in `docs/SPEC.md` §Styles.

### Step 4.2 — Primitives

▶ **Do** — Create `src/components/primitives.tsx` exporting `Card`,
`CardHeader`, `OutcomePill`, `ClampText`, `Banner`, `EmptyState`,
`TableSkeleton`, `ErrorState`, `ScoreBar`.

⚠ **Trap — `OutcomePill` renders `'error'` as "Not scored" in warning
colours**, visually distinct from "Failed". An uninterpretable score is not a
wrong answer.

⚠ **Trap — `ClampText` clamps to TWO lines, not one.** One line truncates most
real questions mid-clause, forcing expansion to read anything and defeating
the scan.

⚠ **Trap — `ErrorState` hides the retry button when `retryable` is false.**

### Step 4.3–4.7 — Routes

Build in this order. Each route must handle **four** states explicitly:
loading, error, **empty**, populated.

⚠ **Trap — the empty state is the one that gets skipped and the one users hit
first.** Every empty state needs exactly one primary action, and it must not
point at another empty screen. That loop is the original design's central flaw.
📖 ADR-007.

| Step | File | Key requirement |
|---|---|---|
| 4.3 | `routes/AgentHome.tsx` | Lists **suites**, never questions 📖 ADR-007 |
| 4.4 | `routes/Library.tsx` | `Used in` column; orphans flagged amber; cap counter |
| 4.5 | `routes/SuiteEditor.tsx` | Checkbox selection; **no copy button** |
| 4.6 | `routes/RunResults.tsx` | Failures grouped; passes collapsed |
| 4.7 | `routes/Compare.tsx` | Changed and comparable in **separate tables** |

Per-route detail, including exact copy strings, is in `docs/SPEC.md` §Routes.

⚠ **Trap (4.3)** — Show the stale-draft banner when
`config.hasUnsavedChanges`. Without it users silently test a version they are
not looking at. 📖 ADR-001.

⚠ **Trap (4.4)** — Empty criteria renders "No criteria set", never a blank
cell. A blank reads as a rendering bug.

⚠ **Trap (4.4)** — Archiving the last question in a suite must warn and name
the suite.

⚠ **Trap (4.5)** — Archived questions are not selectable. Adding one to a
suite would be a dead checkbox.

⚠ **Trap (4.6)** — One "Apply fix" button per **cause**, not per failing test.
That consolidation is the entire point of grouping.

### Step 4.8 — App root

▶ **Do** — Create `src/App.tsx` exporting `ErrorBoundary`, `EvalsRoutes`, and
a default `App`.

⚠ **Trap — set `retry: false` on the QueryClient.** `ApiClient` already
retries. Both retrying multiplies attempts and makes a dead backend take nine
tries to surface an error.

⚠ **Trap — `ErrorBoundary` catches render crashes only**, not query failures.
Those are handled per-route with retry, which is a better experience than a
full-page fallback.

**Routes:**

```
/agents/:agentId/evals                    AgentHome
/agents/:agentId/evals/library            Library
/agents/:agentId/evals/suites/new         SuiteEditor
/agents/:agentId/evals/suites/:suiteName  SuiteEditor
/agents/:agentId/evals/runs/:runName      RunResults
/agents/:agentId/evals/compare?a=&b=      Compare
```

### ✅ Phase 4 gate

```bash
npm run build      # must succeed
npm run dev        # click every route manually
```

---

## Phase 5 — Tests

### Step 5.1 — Fixtures

▶ **Do** — Create `src/test/fixtures.tsx` exporting `TEST_CONFIG`,
`LONG_PROMPT`, `makeQuestion`, `makeLibrary`, `makeResult`, `makeRun`,
`toLangfuseItem`, `stubClient`, `page`, `renderRoute`.

⚠ **Trap — `makeLibrary()` must include the awkward cases**, not just happy
ones: a 60-word question, an orphan (no suites), an archived item, and one
with empty criteria. Clean fixtures hide the bugs that reach users.

⚠ **Trap — `makeResult` must use `'hashAtRun' in over`, not `??`.** With `??`,
an explicit `undefined` gets overwritten by the default and the missing-hash
branch is never actually tested. This was a real bug in the original build.

### Step 5.2–5.4 — Test suites

| File | Count | Covers |
|---|---|---|
| `src/test/domain.test.ts` | 74 | EDGE_CASES 1–18 |
| `src/test/api.test.ts` | 29 | EDGE_CASES 19–24 |
| `src/test/routes.test.tsx` | 34 | EDGE_CASES 25–30 |

Every case is specified in `docs/EDGE_CASES.md` with its expected behaviour.
Work through it in order.

⚠ **Two tests are load-bearing rather than descriptive:**

1. *"has NO copy affordance"* asserts the **absence** of a copy/duplicate
   button in the suite editor. That absence enforces the library model.
2. *"an intentionally empty field returns '', not stringified JSON"* guards
   the `readText` bug from Step 1.3.

### ✅ Phase 5 gate

```bash
npm test           # expect 149 passing
npm run typecheck  # clean
npm run build      # succeeds
```

---

## Phase 6 — Final verification

▶ **Do** — Confirm every item:

- [ ] 149 tests pass
- [ ] `tsc -b --noEmit` clean
- [ ] `npm run build` succeeds
- [ ] No `constructor(private x)` parameter properties anywhere
- [ ] No copy/duplicate affordance in the suite editor
- [ ] `src/domain/` imports nothing from `api/`, `hooks/`, or `routes/`
- [ ] Every route handles loading, error, empty, and populated
- [ ] Every interactive control has an accessible name
- [ ] `readText` returns `''` for an intentionally empty field
- [ ] `scoreToOutcome(undefined)` returns `'error'`, not `'failed'`
- [ ] Errored results excluded from the pass-rate denominator
- [ ] `archive` uses PATCH, never DELETE
- [ ] `retry: false` on the QueryClient
- [ ] Cap enforced in `useCreateQuestion`, not in the API layer

✅ **Final verify**

```bash
rm -rf node_modules && npm install && npm test && npm run build
```

---

## If you are stuck

| Symptom | Likely cause | Fix |
|---|---|---|
| `TS1294` on a constructor | Parameter properties | Explicit fields — Step 0.4 |
| Literal `{"criteria":""}` in the UI | `readText` branch 2 missing | Step 1.3 |
| Drift detection never fires | `contentHash` has no separator | Step 1.3 |
| Suite count off by one | Archived items counted | Step 1.4 |
| Suite vanishes when emptied | `knownSuites` not passed | Step 1.4 |
| Grouping merges unrelated failures | Confidence floor missing | Step 1.5 |
| Results page 500s on one bad trace | Not using `allSettled` | Step 2.3 |
| "Run not found" with a valid run | `list` rejects bare arrays | Step 2.3 |
| Polling never stops | `refetchInterval` not returning `false` | Phase 3 |
| Dead backend takes 9 attempts | QueryClient retry not disabled | Step 4.8 |
| Criteria blanked after a suite edit | Membership write dropped fields | Step 2.2 |
