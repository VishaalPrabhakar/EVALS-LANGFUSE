# Edge Cases

Every case here has a test. The numbering matches the `describe` blocks in
`src/test/`. If you change behaviour, update both the test and this file.

These are not coverage padding — each one either produced a design decision or
caught a real bug during development.

**Test files:**
- `src/test/domain.test.ts` — cases 1–18 (74 tests)
- `src/test/api.test.ts` — cases 19–24 (29 tests)
- `src/test/routes.test.tsx` — cases 25–30 (34 tests)
- `src/test/config.test.ts` — case 31 (12 tests)

Total: **149 tests.**

---

## Library model

### 1. Archived questions must not inflate suite counts
An archived question still carries suite membership (ADR-008). If it counted,
a suite would advertise 3 questions while running 2 — the UI would promise more
coverage than exists. `deriveSuites` and `questionsInSuite` both skip archived.

### 2. The cap boundary
At-cap is reported *exactly* at 100, not one past it. `remaining` never goes
negative even if the backend allowed writes the UI did not. A warning state
fires at 85% so the limit is never a surprise.

### 3. Orphan questions — a failure mode created by the library model
A question in no suite exists, looks correct in the table, and never runs. This
state cannot occur under suite-ownership; it is the cost of ADR-002. Silent
no-ops are the worst outcome for an evals tool, so orphans are flagged amber in
the library and listed in coverage gaps.

An *archived* orphan is **not** reported — it is not meant to run, and flagging
it would train users to ignore the warning.

### 4. A suite emptied of all questions must not vanish
Suites are derived from question metadata, so removing the last member would
delete the suite. A user emptying a suite to rebuild it did not intend that.
Known suite names persist in `localStorage`; `deriveSuites` accepts them and
reports `questionCount: 0`. Blank names are ignored; a known suite that also
has members is not duplicated.

### 5. Membership toggling is idempotent
Adding twice is a no-op. Removing an absent suite is a no-op. Output is always
sorted, so writes are stable and diffs are readable.

### 6. Suite rename is a non-atomic multi-row write
`planRename` produces one update per member — including archived members, or
restoring one would resurrect a dead suite name. Renaming onto an existing
suite name merges without producing a duplicate entry. Empty and no-op renames
are refused.

### 7. Deleting a suite must never delete questions
`planDeleteSuite` strips membership only. A user reorganising their tests must
not lose work.

### 8. Archiving the last test in a suite
`suitesAffectedByArchive` reports which suites would be left at zero, driving
an explicit warning in the confirmation dialog. An unknown question id returns
empty rather than throwing.

### 9. Near-duplicate detection
Uses token-overlap (Jaccard), not edit distance: questions are sentences, and
"How long to return an item?" versus "What is the return window?" are close in
meaning and far apart in characters. The question being edited is excluded from
its own duplicate check. An empty prompt returns no matches rather than
dividing by zero.

---

## Parsing and translation

### 10. Langfuse arbitrary-JSON fields
`input` and `expectedOutput` accept any JSON. `readText` handles: bare strings,
keyed objects (in priority order), chat-shaped `{messages:[...]}`, null and
undefined, and blank-string values that should fall through to the next key.

**Regression guard:** an *intentionally empty* field returns `''`, not
stringified JSON. This was a real bug — empty criteria rendered in the library
table as the literal text `{"criteria":""}` because the empty string is falsy
and fell through to `JSON.stringify`. The fix must not swallow genuinely
unrecognised shapes, which are still stringified so users can debug their own
pipeline.

### 11. Question conversion tolerates missing fields
A name is synthesised from the prompt when `metadata.name` is absent, and falls
back to "Untitled question" when there is no text at all. Junk in
`metadata.suites` — a non-array, or an array containing numbers and nulls — is
filtered rather than crashing the library view.

### 12. Content hashing
Stable across calls. Changes when criteria change. A null-byte separator
prevents `('ab','c')` and `('a','bc')` colliding, which would make a real edit
read as unchanged. Empty strings hash cleanly.

### 13. Truncation
Cuts at the last complete word, so no partial word survives. Hard-cuts when the
first word exceeds the limit — returning a bare ellipsis would be useless.

*(Found during testing: the original implementation left partial words.)*

### 14. Score interpretation must not turn infra errors into failures
Handles BOOLEAN, NUMERIC (threshold inclusive at 0.5), and CATEGORICAL
(case-insensitive) scores. A **missing** score returns `'error'`, not
`'failed'` — see ADR-009. An uninterpretable value likewise. This is the single
most important branch in the parsing layer.

---

## Root-cause grouping

### 15. Judge comment parsing
Accepts a leading JSON object followed by prose, a fenced ```json block, or
plain prose. Brace-matching handles nested objects and braces inside strings,
so a payload containing `{curly}` does not truncate the parse. Malformed JSON
degrades to plain prose — a judge emitting bad JSON must not blank the results
screen. An undefined comment is safe.

### 16. Failure grouping
Groups exactly on `causeId` when every failure has one. **Spans suites** — one
cause appearing in three suites is one group, not three. Ignores non-failed
results defensively. Returns empty for no failures.

**Refuses to group below the confidence floor** (ADR-006): two unrelated
failures stay separate rather than being falsely merged.

Deterministic: same input yields the same groups in the same order (largest
first, then alphabetical). A `causeId` with no display title is humanised
(`missing-scope-boundary` → `Missing scope boundary`).

---

## Comparison and drift

### 17. Comparison separates drift from regression
The core of ADR-004. An unchanged question that went pass→fail is a real
regression. An *edited* question that went pass→fail is **not** — it lands in
the changed table, is captioned as possibly-not-a-regression, and is counted as
`unattributable` rather than `broke`.

A missing hash is treated as changed (conservative direction). Added and
removed questions are reported rather than dropped — a test that vanished
usually means someone archived it, which is itself worth knowing. Two empty
runs compare cleanly. An `error` outcome is `unknown` movement, neither a fix
nor a break. Prompt edits are described distinctly from criteria edits.

### 18. Per-suite rollup
A question counts in every suite it belongs to. Suite-less results are filed
under a sentinel rather than disappearing.

**Unscored results are excluded from the pass-rate denominator** (ADR-009):
1 passed + 1 failed + 1 unscored = 50%, not 33%. When nothing was scored,
`inconclusive` is true and the UI shows `—`, not `0%` — those look identical
otherwise and the first causes unnecessary panic.

---

## API layer

### 19. HTTP error taxonomy
401/403 → auth, 404 → notfound, 409 → conflict, 429 → ratelimit, 5xx → server,
other 4xx → client. Retryability is derived from the kind and decides whether
the UI shows a retry button at all — offering one for a 400 is a dead action.
Every kind has a plain user-facing message that does not leak internals.

### 20. Malformed and empty responses
Non-JSON with a 200 raises a parse error. **204 No Content is success**, not an
error — DELETE and PATCH legitimately return no body. An empty 200 body is
likewise success.

### 21. Retry behaviour
Retryable failures retry with exponential backoff plus jitter (jitter matters:
without it, parallel requests retry in lockstep and hammer a recovering
server). Non-retryable failures do not retry — a 400 will never succeed, and
retrying a POST that already succeeded server-side could double-write. Gives up
after `maxAttempts`. A thrown network failure becomes an `ApiError`.

### 22. URL and query construction
Empty, null and undefined params are omitted rather than sent as blanks. Array
params repeat the key, matching Langfuse list-filter convention. A trailing
slash on `baseUrl` is normalised. Ids containing spaces or slashes are escaped —
Langfuse ids are usually safe, but user-supplied suite names are not.

### 23. Pagination
Stops on an empty page **even when `totalPages` lies** — some Langfuse versions
report a stale count, and without this check every load runs to `maxPages`.
Respects `maxPages` as a runaway guard. Stops when the reported total is
reached.

### 24. Questions API library semantics
Archived items are filtered by default and included on request. Archiving uses
`PATCH { status: 'ARCHIVED' }`, never DELETE.

**Bulk membership reports per-id success and failure.** Silent partial success
is the worst outcome here: the user cannot tell what their suite actually
contains. Progress is reported for the UI.

**Membership updates preserve name, criteria and tags** — an early bug would
have blanked question content on every suite edit.

---

## Routes and navigation

### 25. Agent home
First-run shows **one** empty state with one primary action — the original
design had three competing empty states pointing at each other (ADR-007). Once
questions exist, the view lists suites and the long question text does **not**
appear, confirming the view is bounded by suite count rather than library size.

The stale-draft warning appears when the editor has unsaved changes (ADR-001).
Orphans surface in the coverage panel. A failed library load shows an error
state with a working retry.

### 26. Library view
The **Used in** column is present — this is the disclosure that makes shared
editing safe (ADR-002). Orphans are flagged distinctly. Empty criteria renders
an explicit "No criteria set" marker, never a blank cell: a blank reads as a
rendering bug, a marker reads as a state the user can act on.

Archived questions are hidden by default. Search filters across name, prompt
and criteria. A filter matching nothing offers a way out — a dead-end empty
state is a trap. The cap counter is visible.

Archiving the last question in a suite warns explicitly and names the suite.
The confirmation can be cancelled without archiving.

### 27. Suite editor
Questions already in the suite are pre-ticked.

**There is no copy affordance.** The test asserts the absence of any
copy/duplicate button. That absence is what makes drift structurally
impossible — if this test fails, ADR-002 has been broken.

Unticking is explained as not deleting the question. A suite that exists but has
no questions left warns rather than looking broken. With an empty library, the
user is directed to the library rather than shown an empty grid. Save is
disabled until a new suite has a name. The selected count updates live.

**Archived questions are not offered as selectable** — you cannot add one to a
suite, so offering it would be a dead checkbox.

### 28. Run results
Failures group by root cause with **one** fix action per cause, not one per
failing test. Expected vs actual render side by side.

An unknown run shows a not-found state. A run that produced **no results** —
trigger succeeded but nothing executed — renders an explicit state rather than
0% failure. Unscored questions are separated from failures with an explanation
that they are an evaluation problem, not an agent failure (ADR-009).

*(Found during testing: `RunsApi.list` broke when the endpoint returned a bare
array instead of a paginated envelope, producing a silent "run not found" with
no trace of why. Now tolerates both shapes.)*

### 29. Compare runs
Fewer than two runs explains that comparison needs two, rather than rendering an
empty table. No selection prompts for one. **Comparing a run against itself is
caught** — otherwise the result is a wall of "unchanged" rows.

### 30. Accessibility floor
Every interactive control has an accessible name. Checkboxes in the suite editor
are labelled individually. Errors announce with `role="alert"`. The archive
confirmation is a proper modal dialog with `aria-modal` and an accessible name.

Non-negotiable and enforced by test rather than by review.

---

## Configuration

### 31. Startup validation
Reports **every** missing environment variable at once — one at a time turns a
single fix into several deploy cycles. Empty and whitespace-only values count
as missing, since a variable set to `''` in a deploy manifest is a common
failure and indistinguishable from absent.

Host overrides take precedence over the environment, so an embedding app can
supply the agent id at runtime rather than baking it into a build.

**A Langfuse secret key in the browser environment throws.** That is a security
incident, not a misconfiguration, and failing to start is correct. Pointing
`VITE_EVALS_API` straight at Langfuse warns but does not throw — local dev
against a throwaway project is legitimate.

The startup error renders as readable HTML rather than a blank page, and
escapes its input, since env values reach that renderer.

---

## Known gaps

Things deliberately **not** handled, and why.

| Gap | Reason |
|---|---|
| Concurrent membership edits across tabs | Read-modify-write race. Window is small, a lost toggle is redoable, and Langfuse offers no optimistic concurrency. See ADR-003. |
| Suite rename atomicity | Non-atomic by construction. Handled with per-id failure reporting and targeted retry rather than a transaction. |
| Virtualization | Unnecessary at the 100 cap (ADR-005). Required if the cap is raised past ~1000. |
| Grouping at scale | O(n²) clustering. Fine at 100; move server-side beyond ~1000. |
| Real-time run updates | Polling every 3s rather than SSE, because polling needs nothing from the backend. Swap in SSE if available. |
| i18n | Strings are inline. Extraction is mechanical but was out of scope. |
