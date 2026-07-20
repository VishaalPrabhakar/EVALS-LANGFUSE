# Integration Guide

Everything the backend must provide for this frontend to work, and the
assumptions it makes about your Langfuse deployment.

---

## 1. Security: never expose the Langfuse secret key

Langfuse authenticates with HTTP Basic using a public/secret key pair. **The
secret key must never reach the browser.**

Point `baseUrl` at your own backend, which proxies to Langfuse and injects
credentials server-side:

```
Browser  ──►  Your backend  ──►  Langfuse
              (adds auth)
```

The `authToken` option on `ApiClient` exists for local development against a
throwaway project only. Do not use it in production.

Your proxy is also the right place to enforce tenancy: the frontend sends a
`datasetId` it was configured with, and nothing stops a modified client from
sending a different one. Validate that the caller may access the dataset.

---

## 2. Endpoints the frontend calls

All paths are relative to `baseUrl`. Most map 1:1 onto Langfuse's public API,
so a thin pass-through proxy satisfies them.

| Method | Path | Maps to | Notes |
|---|---|---|---|
| GET | `/dataset-items?datasetId&page&limit` | Langfuse `/api/public/dataset-items` | Paginated |
| GET | `/dataset-items/:id` | same | |
| POST | `/dataset-items` | same | Upserts on `id` |
| PATCH | `/dataset-items/:id` | same | Used only for `{status}` |
| GET | `/datasets/:name/runs?limit` | Langfuse `/api/public/datasets/{name}/runs` | Envelope **or** bare array both accepted |
| GET | `/dataset-run-items?datasetId&runName&page&limit` | Langfuse `/api/public/dataset-run-items` | Paginated |
| GET | `/scores?name&page&limit` | Langfuse `/api/public/scores` | Filtered by score name |
| GET | `/traces/:id` | Langfuse `/api/public/traces/{id}` | Reads `output`, `latency` |
| **POST** | **`/runs`** | **your service** | See §4 — not a Langfuse endpoint |

### Response shapes

Paginated endpoints return:

```json
{ "data": [...], "meta": { "page": 1, "limit": 50, "totalItems": 12, "totalPages": 1 } }
```

`GET /datasets/:name/runs` may return either that envelope or a bare array —
the client normalises both. This tolerance exists because a proxy that unwraps
the envelope is a reasonable thing to build, and being strict produced a silent
"run not found" that was hard to trace.

---

## 3. Data conventions

### Question storage

```jsonc
{
  "id": "item_abc",
  "datasetId": "<the agent's library dataset>",
  "input":          { "question": "How long do I have to return an item?" },
  "expectedOutput": { "criteria": "30 days from delivery, receipt required" },
  "metadata": {
    "name":   "Refund window",
    "suites": ["Smoke", "Full regression"],   // ← suite membership lives here
    "tags":   []
  },
  "status": "ACTIVE"                          // or "ARCHIVED" for soft delete
}
```

**`metadata.suites` is the whole suite model.** See DECISIONS.md ADR-003 for
why membership lives in metadata rather than in separate datasets. If you
change this key, update `api/questions.ts::toItemBody` and
`domain/model.ts::toQuestion` together.

If your backend stores a different shape for `input`/`expectedOutput`, change
`domain/model.ts::readText` and `toQuestion` — those are the **only** places
that touch raw Langfuse JSON. Nothing else in the codebase parses it.

### One dataset per agent

Each agent gets exactly one Langfuse Dataset, acting as its question library.
Pass its id and name in `EvalsConfig`. Do **not** create a dataset per suite —
that reintroduces the drift the library model exists to prevent (ADR-002).

---

## 4. The run trigger endpoint (you must build this)

Langfuse does not execute your agent. Your LangGraph service does, then writes
`DatasetRunItem`s and `Score`s back to Langfuse.

**Request:**

```jsonc
POST /runs
{
  "datasetName": "agent-42-library",
  "suite": "Smoke",                    // omit to run everything
  "agentVersion": "v14",               // the SAVED version — see ADR-001
  "itemIds": ["item_a", "item_b"]      // optional explicit subset
}
```

**Response:**

```jsonc
{ "runName": "run-2026-07-19T12-00-00" }
```

The frontend polls on `runName` and does not block on this call.

### Your executor must

1. **Resolve the suite** to dataset items by filtering
   `metadata.suites.includes(suite)`. Skip items with
   `status === 'ARCHIVED'`.
2. **Run against the saved agent version**, not the draft (ADR-001), and record
   it in `DatasetRun.metadata.agentVersion` so the results header can state
   what was tested.
3. **Create one `DatasetRunItem` + `Trace` per question.**
4. **Write a `Score`** per trace named `correctness` (or change
   `VERDICT_SCORE_NAME` in `api/runs.ts`).
5. **Set `DatasetRun.metadata.suite`** to the suite name.

### Score conventions

`scoreToOutcome` accepts several shapes so you are not forced into one:

| dataType | Pass condition |
|---|---|
| `BOOLEAN` | value === 1 |
| `NUMERIC` | value ≥ 0.5 |
| `CATEGORICAL` | `pass`/`passed`/`correct`/`yes`/`true`/`good` (case-insensitive) |

A **missing or uninterpretable** score becomes `'error'`, not `'failed'` — it is
reported as "Not scored" and excluded from the pass rate (ADR-009).

---

## 5. ⚠ Make the judge emit `causeId` — highest-value backend change

Root-cause grouping is the most valuable transform in the UI and the riskiest
assumption in the product (ADR-006). It works far better with structured
output.

**Have your LLM judge prefix `Score.comment` with a JSON object:**

```
{"causeId":"missing-scope-boundary","cause":"No scope boundary in the system prompt","fix":"Add an explicit rule so the agent declines unrelated requests."}
The agent responded with a joke instead of declining.
```

- `causeId` — stable identifier. **Grouping keys on this.** Use a slug, and
  reuse the same slug for the same underlying problem across runs.
- `cause` — human title shown as the group header.
- `fix` — remediation, shown once per group with an Apply button.
- Everything after the JSON is free prose, shown as reasoning.

A fenced ```json block also works. Malformed JSON degrades to plain prose
rather than breaking the screen.

**Without `causeId`** the frontend falls back to token-similarity clustering
and, below a confidence floor, refuses to group at all — rendering a flat list
with an explanatory line. That is safe but much less useful.

**Validate this before trusting it.** Run your existing eval data through the
judge and check that the same underlying problem produces the same `causeId`
across runs. If it does not, grouping degrades to the flat list.

---

## 6. Async execution, queues, and caching

Langfuse self-hosted uses Redis (or a drop-in fork such as **Valkey**, e.g. via
AWS ElastiCache) for its queue and cache layer. Run execution is therefore
asynchronous behind a worker, which is already the frontend's assumption:
`POST /runs` returns immediately and the UI polls.

Two things to confirm on your deployment:

**Write-then-read lag.** If scores are queued before being written through,
polling immediately after a run item completes may return a missing score. The
UI renders that as "Not scored" — honest, but transient and potentially
confusing mid-run. Check whether your read path goes through the cache or
straight to the primary store. If lag is significant, either read through to
the primary for in-flight runs, or have the trigger response include an
expected item count so the UI can distinguish "not written yet" from "failed to
score".

**Poll interval.** `useRunProgress` polls every 3s, which is a guess. If your
worker's write cadence is known, match it. Polling stops automatically once
`done >= total`.

**If you can push instead of poll:** replace the `refetchInterval` in
`hooks/useEvals.ts::useRunProgress` with an SSE or WebSocket subscription. The
rest of the app is unaffected — nothing else knows how progress arrives.

---

## 7. Performance: consider a server-side join

Assembling a results view requires joining four Langfuse endpoints. The
frontend batches this down to roughly `3 + ceil(N/6)` requests (see the header
comment in `api/runs.ts`), which is acceptable at the 100-question cap.

**If you can do the join server-side, do it.** Expose one endpoint returning
assembled results and replace `RunsApi.getRunResults` with a single call:

```jsonc
GET /runs/:runName/results
{
  "run": { "id", "name", "suite", "agentVersion", "createdAt" },
  "results": [{
    "questionId", "questionName", "prompt", "criteria",
    "outcome": "passed" | "failed" | "error",
    "actual", "judgeComment", "suites", "traceId", "hashAtRun", "latencyMs"
  }]
}
```

`api/runs.ts` is the only module that knows about the join. Everything else is
unaffected.

---

## 8. Run snapshots and drift detection

The comparison view distinguishes "the agent regressed" from "someone edited
the criteria" using a content hash (ADR-004). The frontend computes this
client-side, which has a limitation: for a question edited since the run, it
can only report *that* it changed, not what the old text was.

**Langfuse already solves this natively.** Dataset versioning by timestamp lets
you fetch items as they existed at a point in time. If your executor forwards
`datasetVersion` when creating run items, you can:

1. Store the version on `DatasetRun.metadata.datasetVersion`.
2. Have the results endpoint resolve question text *at that version*.
3. Return the true historical `prompt`/`criteria` in `hashAtRun`'s place.

This makes the comparison view fully accurate rather than merely honest about
its uncertainty. Recommended if you are building the server-side join anyway.

---

## 9. Mounting the frontend

**Standalone** (owns its router):

```tsx
import App from './App';

<App config={{
  baseUrl: '/api/evals',
  datasetId: 'ds_abc',
  datasetName: 'agent-42-library',
  agentId: 'agent-42',
  agentVersion: 'v14',
  hasUnsavedChanges: editorIsDirty,   // drives the stale-draft banner
}} />
```

**Embedded** in an app that already has a router:

```tsx
import { EvalsRoutes, ErrorBoundary } from './App';
import { ApiProvider } from './api/provider';

<ErrorBoundary>
  <ApiProvider config={config}>
    <Route path="/agents/:id/evals/*" element={<EvalsRoutes />} />
  </ApiProvider>
</ErrorBoundary>
```

You supply your own `QueryClientProvider` in the embedded case, or reuse the
host app's.

`hasUnsavedChanges` should be wired to your editor's dirty state. Without it
the stale-draft warning never fires and users silently test a version they are
not looking at.

---

## 10. Configuration checklist

- [ ] Proxy endpoint deployed; Langfuse secret key server-side only
- [ ] Tenancy validated on the proxy (caller may access `datasetId`)
- [ ] One library dataset created per agent
- [ ] `POST /runs` trigger endpoint implemented
- [ ] Executor filters by `metadata.suites` and skips `ARCHIVED`
- [ ] Executor records `agentVersion` and `suite` in run metadata
- [ ] Judge writes `correctness` scores
- [ ] **Judge emits `causeId` in `Score.comment`** ← do this one
- [ ] `hasUnsavedChanges` wired to the editor's dirty state
- [ ] Poll interval matched to worker cadence (or SSE substituted)
- [ ] Cache read-through behaviour confirmed for in-flight runs
