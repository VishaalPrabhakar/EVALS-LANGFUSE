# START HERE

You have been asked to replicate this application. Read this file completely
before doing anything else. It takes two minutes and will save you several
wrong turns.

---

## What this is

A React + TypeScript frontend for **agent evaluation** — writing test
questions, running them against an AI agent, and reading scored results. The
backend is [Langfuse](https://langfuse.com); the agents are LangGraph.

The repository you are looking at is complete and working: 43 source files,
149 passing tests, clean typecheck, successful build. Your job is to
reproduce it.

---

## How to proceed

**Follow `docs/BUILD_PLAN.md` step by step.** It is an ordered task list with
a verification command after each step. Do not reorder it; later steps depend
on earlier files.

Two companion documents support it:

| When you need | Read |
|---|---|
| Exact type signatures, function contracts, copy strings | `docs/SPEC.md` |
| The behaviour each test must assert | `docs/EDGE_CASES.md` |

Read `docs/DECISIONS.md` only if you want to change a design choice. It
explains why each one exists and what the rejected alternative was.

---

## The five things that will trip you up

These caused real bugs during the original build. Each is called out again at
the relevant step, but knowing them in advance helps.

### 1. `erasableSyntaxOnly` forbids parameter properties

```ts
constructor(private client: ApiClient) {}   // ❌ TS1294
```

Use explicit fields. Affects `QuestionsApi` and `RunsApi`.

### 2. `readText` needs a middle branch for empty strings

An intentionally empty criteria must return `''`, not fall through to
`JSON.stringify`. Otherwise the UI renders the literal text
`{"criteria":""}` in the results table.

### 3. `contentHash` needs a null-byte separator

Without it, `('ab','c')` and `('a','bc')` collide, and drift detection
silently stops working.

### 4. A missing score is `'error'`, never `'failed'`

A broken judge is an infrastructure problem. Painting it red sends users to
debug a prompt that is fine, and it must be excluded from the pass rate.

### 5. `RunsApi.list` must accept a bare array as well as a paginated envelope

Real deployments return both shapes. Being strict produces a silent
"run not found" that is very hard to trace.

---

## The one architectural idea

Everything else follows from this.

**Questions are owned at the agent level. A suite is a *selection* over them,
not a container.** One question can appear in five suites without ever being
copied.

This matters because "Smoke" and "Full regression" are not different tests —
they are different time budgets over the same tests. If a suite held copies,
the moment they drifted the smoke suite would lie to you on every commit.

**Langfuse does not support this natively.** A `DatasetItem` belongs to
exactly one `Dataset`. The workaround, which you must implement:

- One Dataset per agent is the **library**, holding every question once.
- Suite membership lives in `DatasetItem.metadata.suites: string[]`.
- Suites are **derived** by scanning that array. No suite record exists.

The practical consequence for you: **there is no copy operation anywhere in
the codebase, and there must not be one.** A test asserts the absence of a
copy button in the suite editor. That absence is what makes drift
structurally impossible.

Full reasoning: `docs/DECISIONS.md` ADR-002 and ADR-003.

---

## Layer rules

```
routes/    React components. No business logic, no raw JSON parsing.
hooks/     React Query wrappers. Rules needing cache state (the 100 cap).
api/       HTTP, error taxonomy, retry, pagination, the results join.
domain/    Pure functions. No React, no fetch.
```

**Dependencies point downward only.** `domain/` imports nothing from the
layers above it. If a rule needs React to be testable, it is in the wrong
layer.

Two files are deliberately the sole owners of a concern:

- `domain/model.ts::toQuestion` — the **only** place that parses Langfuse JSON
- `api/runs.ts::getRunResults` — the **only** place that knows the four-way
  join exists

If the backend changes shape, exactly one of these changes.

---

## Verification

After each phase in the build plan:

```bash
npm test           # 74 → 103 → 149 as phases complete
npm run typecheck  # must stay clean throughout
npm run build      # must succeed from Phase 4 onward
```

Final state: **149 tests passing**, clean typecheck, successful build.

---

## Reading order for the existing code

If you prefer to read before building:

1. `src/domain/langfuse.ts` — the header comment explains the Langfuse
   mapping and the one conflict. This is the highest-value file to read.
2. `src/domain/library.ts` — the library model
3. `src/domain/grouping.ts` — root-cause clustering and its safety floor
4. `src/api/runs.ts` — the results join and why it is shaped that way
5. `src/routes/AgentHome.tsx` — how a route composes the layers

Every file carries a header comment stating what it does and why the obvious
alternative was rejected.

---

## Interactive reference

`evals-prototype.html` in the project root is a standalone clickable
prototype — no build, no dependencies. It shows all 13 UI states across both
user routes (guided wizard and experienced/manual). Open it to see what you
are building before you build it.

Design tokens in the prototype are copied verbatim from
`src/styles/tokens.css`, so it renders identically to the React app.
