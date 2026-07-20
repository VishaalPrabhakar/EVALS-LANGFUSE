# Production Readiness

An honest account of what this codebase does and does not cover before a real
deployment.

The test suite (149 tests) verifies **correctness**. It does not verify
**operability**. Those are different things, and this document is about the
second.

**Nothing here is a defect in the existing code.** These are scope boundaries.
The point of writing them down is that the alternative — discovering them at
deploy time — is worse.

---

## Severity key

| Level | Meaning |
|---|---|
| 🔴 **Blocking** | Do not deploy to production without this |
| 🟠 **Important** | Ship without it if you must; schedule it immediately |
| 🟡 **Deferred** | Legitimate to postpone; revisit when scale or usage changes |

**If your platform already provides CI, observability, and auth at the org
level, most of the 🔴 items are someone else's layer.** Check before building
duplicates. The rest of this document still applies.

---

## 🔴 Blocking

### 1. Continuous integration

**Gap.** 149 tests that only run when someone remembers are not a safety net.
Nothing prevents a merge that breaks them.

**Provided.** `.github/workflows/ci.yml` runs typecheck, lint, tests with
coverage, and build on every push and pull request.

**To do**
- Enable the workflow (rename if you are not on GitHub Actions)
- Make the check required for merge in branch protection
- Decide whether coverage thresholds block or warn — see item 2

---

### 2. Coverage measurement

**Gap.** `docs/EDGE_CASES.md` claims thorough coverage. Nothing measured it, so
the claim would degrade silently as the code grew.

**Provided.** `npm run test:coverage` reports and enforces. Thresholds in
`vite.config.ts` are set to the **measured baseline**, slightly below actual,
so CI fails on regression rather than on the status quo.

**Measured 2026-07 (149 tests):**

| Metric | Actual | Threshold |
|---|---|---|
| Lines | 78.3% | 78% |
| Statements | 76.8% | 76% |
| Functions | 70.7% | 70% |
| Branches | 68.2% | 68% |

**Where the gaps actually are**, highest value first:

| File | Coverage | What is untested |
|---|---|---|
| `hooks/useEvals.ts` | 45% | No direct tests; only exercised via routes |
| `routes/Compare.tsx` | 54% | Only empty and guard states covered |
| `routes/SuiteEditor.tsx` | 55% | Save and partial-failure paths |
| `domain/rollup.ts` | 69% | `withLastRun`, `formatRate` |
| `domain/grouping.ts` | 75% | Similarity-clustering path (structured path is covered) |

`src/domain/` overall sits at 84%, and `library.ts` at 97%. The pure layer is
in good shape; the gaps are concentrated in React code that needs rendering to
exercise.

**To do**
- Write direct tests for `useEvals.ts` — highest ratio of risk to effort
- Cover the suite editor's save path, including partial failure
- Ratchet the thresholds up as each lands. They should only ever move up

⚠ Coverage measures execution, not assertion quality. A test that runs code
without asserting anything counts. Treat it as a floor, not a goal.

---

### 3. Error telemetry

**Gap.** `ErrorBoundary` calls `console.error`. In production that is a silent
failure — nobody sees it, and there is no way to know how often it happens.

**Where to wire it.** `src/App.tsx::ErrorBoundary.componentDidCatch` already
accepts an `onError` callback. That is the seam.

```tsx
<ErrorBoundary onError={(error, info) => {
  Sentry.captureException(error, { extra: { componentStack: info.componentStack } });
}}>
```

**Also worth capturing**
- `ApiError` instances with `kind`, `status`, and endpoint — but **not** the
  request body, which may contain agent prompts
- Failed run triggers
- `CapExceededError`, which is a product signal (users hitting 100) rather
  than a bug

**Do not log.** Question text, criteria, agent outputs, judge comments. All of
it is customer content and some of it is sensitive.

---

### 4. Authentication and session handling

**Gap.** `ApiError.userMessage` for `kind: 'auth'` reads "Your session has
expired. Sign in again to continue." Nothing implements signing in again.

**To do**
- Decide where auth lives — almost certainly the host application, not here
- On a 401/403, the host should redirect to login rather than showing a
  message the user cannot act on
- If tokens are short-lived, add refresh handling in `ApiClient.once` before
  the error is thrown
- Preserve the user's in-progress work across a re-auth, particularly unsaved
  suite selections in the suite editor

**Related.** `INTEGRATION.md` §1 states the Langfuse secret must never reach
the browser. Verify that in your deployment; it is the one security property
this frontend cannot enforce for itself.

---

### 5. Environment validation

**Gap.** A missing `VITE_DATASET_ID` fails at runtime with a confusing error
deep in a network call, not at startup with a clear one.

**Provided.** `src/config.ts` exports `loadConfig()`, which validates required
variables and throws a readable error listing exactly what is missing.

**To do**
- Call it in `src/main.tsx` instead of reading `import.meta.env` inline
- Add a smoke check to your deploy pipeline: build with the target env and
  confirm startup

---

## 🟠 Important

### 6. Linting is installed but never runs

`oxlint` is a dev dependency and no pipeline invokes it. The CI workflow now
does. Consider adding `eslint-plugin-jsx-a11y` if you want static
accessibility checks alongside the runtime ones.

### 7. No end-to-end tests

Every test mocks HTTP. The real integration — actual Langfuse, actual run
execution, actual judge output — is unverified by this repository.

**Minimum worth having**, in rough priority:

1. Create a question → appears in the library
2. Add it to a suite → suite count increments
3. Trigger a run → results appear with real scores
4. Archive a question → disappears from the suite, stays in past runs
5. Compare two runs where a criteria changed → lands in the *changed* table

Item 5 is the one to write first. It exercises `hashAtRun` end to end, and
drift detection is the feature most likely to break silently against a real
backend.

**Not provided here** because E2E setup depends on your environment. Playwright
against a seeded Langfuse project is the usual shape.

### 8. Bundle size is unmonitored

Current: 322 KB raw, 99 KB gzipped. Acceptable, but nothing stops it growing.

**To do**
- Add a size budget to CI (`size-limit` or similar)
- Consider route-level `React.lazy` — `Compare` and `RunResults` are the
  heaviest and least frequently visited
- Watch `@tanstack/react-query`, which is the largest single dependency

### 9. Accessibility beyond accessible names

Tests enforce that every control has a name and that dialogs are marked
correctly. Not covered:

- **Colour contrast.** Verify the token palette against WCAG AA. `--ink-3`
  (`#7e8d87`) on `--paper` is the most likely failure — it is used for hint
  text throughout
- **Keyboard traps.** The archive dialog uses native `<dialog>`, which handles
  focus, but verify tab order in the suite editor's long checkbox list
- **Screen reader passes** on the results view, where nested `<details>`
  elements can be confusing
- **Reduced motion** is handled in CSS; confirm the run spinner respects it

**To do**
- Add `@axe-core/react` in development
- Run one manual pass with a real screen reader on the results view

### 10. Rate limiting and backoff at scale

`ApiClient` retries with jitter, and bulk membership writes are sequential.
Untested: what happens when 20 users trigger runs simultaneously against the
same Langfuse project.

**To do**
- Confirm Langfuse's rate limits for your plan
- Consider a request queue if bulk operations become common
- The 100-question cap bounds the worst case, but concurrent users multiply it

---

## 🟡 Deferred

### 11. Internationalisation

Strings are inline. Extraction is mechanical — `docs/SPEC.md` §Required copy
strings already catalogues most of them — but was out of scope. Note that
several tests assert on exact copy; extracting strings will require updating
them together.

### 12. Virtualization

Unnecessary at the 100-question cap. Required if the cap is raised past ~1000,
along with server-side filtering and server-side failure grouping (which is
O(n²)). See `docs/ARCHITECTURE.md` §Scaling limits.

### 13. Real-time run updates

Polling every 3 seconds rather than SSE, because polling requires nothing from
the backend. Swap in SSE by replacing `refetchInterval` in
`hooks/useEvals.ts::useRunProgress` — nothing else knows how progress arrives.

### 14. Offline and flaky-network handling

React Query caches, but there is no offline queue and no optimistic UI for
mutations. Acceptable for an internal tool on a stable network; revisit if
usage patterns differ.

---

## What no test in this repo can tell you

Two risks are invisible to the test suite because they depend on data it does
not have.

### The judge's output must actually cluster

Root-cause grouping is the most valuable transform in the UI and its riskiest
assumption. If your LLM judge writes free-form prose that varies per call, the
similarity fallback degrades and the confidence floor kicks in — leaving a flat
list with extra chrome.

**Validate before trusting it.** Run your existing eval data through the judge
and check that the same underlying problem produces the same `causeId` across
runs. If it does not, fix the judge prompt before tuning the UI.

📖 `docs/DECISIONS.md` ADR-006, `docs/INTEGRATION.md` §5

### Cache read-through timing

If Langfuse's Valkey/Redis layer queues score writes, a poll immediately after
a run item completes may return a missing score — which renders as "Not
scored". Honest, but transient and confusing mid-run.

**To do**
- Confirm whether reads go through the cache or to the primary store
- If lag is material, read through to the primary for in-flight runs
- Match the 3s poll interval to your worker's actual write cadence

📖 `docs/INTEGRATION.md` §6

---

## Pre-deploy checklist

**Blocking**
- [ ] CI runs typecheck, lint, tests, and build on every PR
- [ ] Coverage baseline recorded; thresholds set to the real number
- [ ] Error telemetry wired to `ErrorBoundary` and `ApiError`
- [ ] Auth handling: 401/403 redirects to login, not a dead message
- [ ] `loadConfig()` called at startup; deploy smoke check in place
- [ ] Langfuse secret confirmed server-side only — never in the browser bundle

**Important**
- [ ] At least the drift-detection E2E test written and passing
- [ ] Bundle size budget in CI
- [ ] Colour contrast verified against WCAG AA
- [ ] One manual screen-reader pass on the results view
- [ ] Langfuse rate limits confirmed for your plan

**Validate with real data**
- [ ] Judge emits stable `causeId` values across runs
- [ ] Cache read-through timing confirmed; poll interval matched
- [ ] One full run executed end to end against real Langfuse

**Know your limits**
- [ ] Team aware the 100-question cap is a product decision (ADR-005), and
      that raising it past ~1000 requires virtualization plus server-side
      filtering and grouping
