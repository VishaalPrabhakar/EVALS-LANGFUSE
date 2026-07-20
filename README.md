# Agent Evals — Frontend

Production-grade React + TypeScript frontend for agent evaluation, backed by
[Langfuse](https://langfuse.com) datasets and dataset runs. Built for LangGraph
agents, but the backend contract is generic.

**149 tests passing · clean typecheck · successful build.**

---

## 🤖 Replicating this codebase?

**Read [`START_HERE.md`](START_HERE.md) first**, then follow
[`docs/BUILD_PLAN.md`](docs/BUILD_PLAN.md) step by step. It is an ordered task
list with a verification command after every step, plus the twelve traps that
caused real bugs during the original build.

`MANIFEST.json` is the machine-readable index: file purposes, phase gates,
known traps, and invariants.

---

## Quick start

```bash
npm install
cp .env.example .env    # then fill it in
npm run dev             # http://localhost:5173
npm test                # 149 tests
npm run build
```

---

## Read this first

If you are picking this codebase up cold — including if you are an LLM asked to
extend it — read in this order:

| Doc | What it answers |
|---|---|
| [`START_HERE.md`](START_HERE.md) | Orientation for rebuilding this |
| [`docs/BUILD_PLAN.md`](docs/BUILD_PLAN.md) | Ordered build steps with verification gates |
| [`docs/SPEC.md`](docs/SPEC.md) | Exact signatures, contracts, required copy strings |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Where does the logic live, and why there |
| [`docs/DECISIONS.md`](docs/DECISIONS.md) | Nine ADRs. **Read before changing structural behaviour** |
| [`docs/INTEGRATION.md`](docs/INTEGRATION.md) | What the backend must provide |
| [`docs/EDGE_CASES.md`](docs/EDGE_CASES.md) | All 149 tests, mapped to the cases they cover |
| [`docs/PRODUCTION_READINESS.md`](docs/PRODUCTION_READINESS.md) | **What is not covered.** Read before deploying |

Then `src/domain/langfuse.ts`, whose header comment explains the single most
important thing in the codebase: how our product model maps onto Langfuse's,
and the one place they conflict.

---

## The product model in one page

**Questions live once, at the agent level.** A suite is a *selection* over
them, not a container. Adding a question to a suite is a metadata edit on one
row — there is no copy operation anywhere in the codebase, and that absence is
what makes drift structurally impossible.

Why it matters: "Smoke" and "Full regression" are not different tests, they are
different time budgets over the same tests. If the smoke suite held copies,
then the moment they drift it would lie to you on every commit — the
highest-frequency, highest-trust surface in the product.

Full argument in ADR-002.

### Screens

| Route | Purpose |
|---|---|
| `/agents/:id/evals` | Suite list. Never renders questions, so it is bounded regardless of library size |
| `…/library` | Every question, once. `Used in` column discloses edit blast radius |
| `…/suites/:name` | Checkbox selection over the library |
| `…/runs/:name` | Score header → failures grouped by cause → passes collapsed |
| `…/compare?a=&b=` | Splits real regressions from criteria edits |

### Design decisions you will notice

- **Failures group by root cause**, not by test. Thirty failures from one
  missing scope rule is one problem with one fix, not thirty rows.
- **Comparison separates drift from regression.** An edited criteria never
  masquerades as the agent getting worse.
- **Unscored ≠ failed.** A broken judge shows as "Not scored" and is excluded
  from the pass rate, not painted red.
- **Runs target the saved agent version**, with a warning when your draft is
  ahead.
- **Soft delete only.** Archived questions stay readable in past runs.

---

## ⚠ The one Langfuse constraint to know

Langfuse enforces that a `DatasetItem` belongs to exactly one `Dataset`:

> Dataset items are upserted on their id. Id needs to be unique
> (project-level) and cannot be reused across datasets.

That is suite-ownership — the model we deliberately rejected. **Resolution:**
one Dataset per agent acts as the library; suite membership lives in
`DatasetItem.metadata.suites: string[]`. Suites are derived by scanning it.

Costs accepted: suite rename is a non-atomic N-row write (handled with per-id
failure reporting and targeted retry), and per-suite aggregates are computed
client-side. Both documented in ADR-003.

Two hard requirements turned out to be **free**: `status: ARCHIVED` is native
soft delete, and dataset versioning by timestamp is a native run snapshot.

---

## ⚠ Highest-value backend change

**Have your LLM judge emit a structured `causeId` in `Score.comment`:**

```
{"causeId":"missing-scope-boundary","cause":"No scope boundary","fix":"Add a rule…"}
Free prose reasoning follows here.
```

Root-cause grouping is the most valuable transform in the UI and its riskiest
assumption. With `causeId`, grouping is exact. Without it, the frontend falls
back to text clustering and — below a confidence floor — refuses to group at
all, because a wrong grouping is worse than none.

Details in INTEGRATION.md §5.

---

## Layout

```
src/
  domain/      Pure logic. No React, no fetch.
    langfuse.ts    Wire types + the mapping explanation. START HERE.
    model.ts       UI model + the single JSON translation point
    library.ts     Suite derivation, membership, cap, duplicate detection
    grouping.ts    Root-cause clustering with a confidence floor
    compare.ts     Drift detection
    rollup.ts      Per-suite aggregates
  api/         HTTP, error taxonomy, retry, the results join
  hooks/       React Query wrappers; cache-dependent rules (the cap)
  components/  Shared primitives
  routes/      Five screens
  test/        149 tests + deliberately awkward fixtures
docs/          Architecture, ADRs, integration, edge cases
```

Dependencies point downward only. `domain/` imports nothing from the layers
above it.

---

## Testing

```bash
npm test              # all 149
npm test -- domain    # 72 pure-logic tests, sub-second
```

Fixtures include awkward data on purpose: a 60-word question, an orphan, an
archived item, an empty-criteria question. Clean fixtures hide the bugs that
reach users.

Three real bugs were caught this way during development — empty criteria
rendering as literal `{"criteria":""}`, a silent "run not found" on a
non-envelope response, and truncation leaving partial words. All three would
have shipped.

---

## Stack

React 19 · TypeScript · Vite · React Router 7 · TanStack Query 5 · Vitest ·
Testing Library

No UI framework. Styling is plain CSS with design tokens in
`src/styles/tokens.css` — every colour and radius comes from there, so a theme
swap is a single-file change.
