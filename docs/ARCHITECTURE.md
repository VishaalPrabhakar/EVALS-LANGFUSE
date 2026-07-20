# Architecture

Orientation for someone — human or model — reading this codebase cold.

## Reading order

Read these four files, in order, before changing anything:

1. **`src/domain/langfuse.ts`** — the wire types, and a long header comment
   explaining how our product concepts map onto Langfuse's data model. It also
   documents the one place they conflict, which explains an entire module.
2. **`src/domain/library.ts`** — the library model. The central product
   decision lives here.
3. **`docs/DECISIONS.md`** — nine ADRs. Most structural behaviour exists
   because the obvious alternative fails in a non-obvious way.
4. **`docs/INTEGRATION.md`** — what the backend must provide.

Then `docs/EDGE_CASES.md` maps all 149 tests to the cases they cover.

---

## Layer diagram

```
routes/          AgentHome · Library · SuiteEditor · RunResults · Compare
   │             React components. No business logic, no raw JSON.
   ▼
hooks/           useEvals.ts
   │             React Query wrappers. Business rules needing cache state
   │             (the 100 cap) live here.
   ▼
api/             client.ts · questions.ts · runs.ts · provider.tsx
   │             HTTP, error taxonomy, retry, pagination, the results join.
   ▼
domain/          langfuse.ts · model.ts · library.ts
                 grouping.ts · compare.ts · rollup.ts
                 Pure functions. No React, no fetch. All tested directly.
```

**The rule that matters:** dependencies point downward only. `domain/` imports
nothing from `api/`, `hooks/` or `routes/`. That is what makes the domain layer
testable without mounting anything, and why 72 of the 149 tests run in
milliseconds.

---

## Where the logic actually lives

| Concern | File | Why there |
|---|---|---|
| Suite derivation | `domain/library.ts` | Suites are computed from question metadata, not stored |
| Translation from Langfuse JSON | `domain/model.ts::toQuestion` | **The only place** that assumes a JSON shape |
| The 100-question cap | `hooks/useEvals.ts` | Needs the current cache count; API layer can't see it |
| Root-cause grouping | `domain/grouping.ts` | Pure, and the riskiest assumption — isolated for testing |
| Drift detection | `domain/compare.ts` | Pure hash comparison |
| Per-suite aggregates | `domain/rollup.ts` | Langfuse aggregates library-wide; we need per-suite |
| The four-way results join | `api/runs.ts` | **The only place** that knows the join exists |

Two files are marked "the only place" for a reason. If you need to change how
question data is stored, change `toQuestion` and nothing else. If your backend
grows a server-side join endpoint, replace `getRunResults` and nothing else.

---

## The one thing to understand about Langfuse

Langfuse enforces that a `DatasetItem` belongs to exactly one `Dataset`. Our
product model says a question belongs to *many* suites without being copied.
These conflict.

Resolution: **one Dataset per agent is the library**, and suite membership
lives in `DatasetItem.metadata.suites: string[]`. Suites are derived by
scanning that array. No suite record exists anywhere.

The invariant this buys: question text exists in exactly one row, so two suites
can never disagree about what a correct answer is. Drift is structurally
impossible rather than merely discouraged.

Full argument in ADR-002 and ADR-003.

---

## State management

- **Server state** — React Query. Query keys are centralised in `hooks/useEvals.ts::qk`
  so invalidation cannot drift from fetching.
- **Local UI state** — `useState`. Suite selection is held locally until save,
  so a user can make several changes and write once.
- **Persisted** — `localStorage` holds known suite names, so a suite emptied of
  all questions does not vanish (EDGE_CASES #4). All access is try/catch;
  private browsing degrades gracefully rather than crashing.

There is no global store. At this size it would be ceremony.

**Retry note:** `ApiClient` retries transient failures with backoff, and React
Query is configured with `retry: false`. Letting both retry multiplies attempts
and makes a dead backend take nine tries to surface an error.

---

## Error handling philosophy

Three distinct paths, deliberately:

1. **`ApiError`** carries a `kind` and a `retryable` flag. The kind decides the
   user-facing message; `retryable` decides whether a retry button appears at
   all. Offering retry on a 400 is a dead action.
2. **Per-route error states** with working retry, for query failures. Better
   than a full-page fallback because the rest of the page stays usable.
3. **`ErrorBoundary`** for render-time crashes only — genuine programming
   errors. It deliberately does *not* catch async failures.

**Missing data is expected, not exceptional.** A results view may reference an
archived question, an expired trace, or a missing score. Each produces a
degraded-but-rendered row. A results page that 500s because one trace is gone
is worse than one showing "Not scored" on a single row.

---

## Testing strategy

149 tests, three files:

- **`domain.test.ts`** (72) — pure functions, no rendering. Fast, and where
  most edge cases live.
- **`api.test.ts`** (29) — HTTP behaviour against a stubbed fetch. Covers the
  error taxonomy, retry, pagination, and partial-failure reporting.
- **`routes.test.tsx`** (36) — rendering and navigation via Testing Library.
  Every empty, error and boundary state.

Fixtures in `test/fixtures.tsx` deliberately include awkward data: a 60-word
question, an orphan, an archived item, an empty-criteria question. Fixtures
that are too clean hide the bugs that reach users.

Two tests are load-bearing rather than descriptive:

- *"has NO copy affordance"* asserts the **absence** of a copy button in the
  suite editor. That absence is what enforces the library model. If it fails,
  ADR-002 has been broken.
- *"REGRESSION: an intentionally empty field returns '', not stringified JSON"*
  guards a real bug where empty criteria rendered as literal `{"criteria":""}`.

### Bugs found by these tests during development

1. Empty criteria rendered as the literal string `{"criteria":""}` — `readText`
   fell through to `JSON.stringify` because the empty string is falsy.
2. `RunsApi.list` broke when the runs endpoint returned a bare array instead of
   a paginated envelope, producing a silent "run not found".
3. `truncate` left partial words mid-token.

All three would have reached users.

---

## Adding a route

1. Create the component in `src/routes/`.
2. Register it in `App.tsx::EvalsRoutes`.
3. Handle four states explicitly: loading, error, **empty**, and populated. The
   empty state is the one that gets skipped and the one users hit first.
4. Add tests covering all four.

## Adding a domain rule

1. Write the pure function in `src/domain/`.
2. Test it directly — no rendering.
3. Only then wire it into a hook or component.

If a rule needs React to be testable, it is in the wrong layer.

---

## Scaling limits

Current design assumes the 100-question cap (ADR-005). Raising it past ~1000
requires three changes:

| Concern | Current | Needed beyond ~1000 |
|---|---|---|
| Library table | Full render | Virtualization |
| Filtering | Client-side | Server-side |
| Failure grouping | O(n²) clustering | Server-side |

The agent home is unaffected at any scale — it lists suites, not questions
(ADR-007). That is the structural reason the cap is sufficient.
