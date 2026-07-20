# Architecture Decision Records

Each record states the decision, the reasoning, the alternatives rejected, and
the cost accepted. Read these before changing structural behaviour — most of
them exist because the obvious alternative fails in a way that is not obvious.

Format: **Context → Decision → Consequences.**

---

## ADR-001 — Runs target the SAVED agent version, never the draft

**Context.** The agent editor and the evals section share a screen. The editor
has a "Save changes" button that can be active while evals are visible, so at
any moment the draft may be ahead of what is saved.

**Decision.** A run always executes against the last saved agent version. The
version is recorded in `DatasetRun.metadata.agentVersion` and displayed in the
results header. When the draft is ahead, the UI shows a persistent warning
with a save action.

**Alternatives rejected.**

- *Run against the draft.* Tempting because it shortens the edit-test loop, but
  it makes results unreproducible: the "version" tested has no identity and
  cannot be returned to. Comparison between runs becomes meaningless.
- *Prompt on every run.* A modal on the most frequent action in the section.
  Users learn to dismiss it, so it stops carrying information.

**Consequences.** Users must save before testing an edit, which is one extra
click. In exchange every run is attributable to a specific version, which is
what makes ADR-004's comparison view trustworthy. The warning banner is the
mitigation — without it, users silently test a version they are not looking at,
which is the worst outcome of the three.

Implemented in: `routes/AgentHome.tsx`, `hooks/useEvals.ts::useTriggerRun`.

---

## ADR-002 — The library model: questions are owned at the agent level

**Context.** A question like "how long is the refund window" belongs in both a
quick smoke suite and a full regression suite. Two ways to model that:

- **Ownership** — each suite owns its questions. Sharing means copying.
- **Library** — questions live once at the agent level; a suite is a
  *selection* over them.

**Decision.** The library model.

**Reasoning.** Three arguments, in order of weight.

1. *The versioning machinery is needed either way.* Comparing two runs requires
   snapshotting the question set (ADR-004). That snapshot is the expensive part
   of a library — content-addressed records, immutable at run time. Once built,
   suite-as-selection is a join on top of infrastructure that already exists.
   So ownership's supposed simplicity is not real: you pay for the machinery
   regardless, and with ownership you pay it *and* inherit duplication.

2. *Suites are time budgets, not different tests.* "Smoke" and "Full
   regression" are not distinct test sets — they are the ten you run on every
   change versus the sixty you run before release. Under ownership the ten are
   copies, and the moment they drift the smoke suite lies to you on every
   commit. That is the highest-frequency, highest-trust surface in the product
   and the worst place to put drift.

3. *The cap means the right thing.* Capping at 100 (ADR-005) should limit how
   many tests one run executes. Under ownership it also limits how many
   distinct tests can exist per suite, conflating two unrelated concerns — the
   same question consumes cap space in five places.

**Alternative rejected — ownership with mitigations.** Near-duplicate detection
at write time, explicit *Copy* rather than *Add* wording, and divergence
flagging in results. These make ownership survivable and are cheaper to build.
Rejected because they manage a problem the library model does not have.

**Consequences.**

- Editing a question changes it everywhere it is used. This surprises people.
  Mitigated by the **Used in** column, which discloses the blast radius before
  the edit. Visible surprise beats invisible drift.
- A new failure mode appears: a question in no suite exists but never runs
  (see EDGE_CASES #3). Silent no-ops are the worst outcome for an evals tool,
  so orphans are flagged in the library and listed in coverage gaps.
- Langfuse does not support this natively. See ADR-003.

Implemented in: `domain/library.ts`.

---

## ADR-003 — Mapping the library model onto Langfuse

**Context.** Langfuse's data model conflicts with ADR-002. From their docs:

> Dataset items are upserted on their id. Id needs to be unique
> (project-level) and cannot be reused across datasets.

A `DatasetItem` belongs to exactly one `Dataset`. That *is* suite-ownership —
precisely the model ADR-002 rejected.

**Decision.** One Dataset per agent acts as the **library**, holding every
question exactly once. Suite membership is stored in
`DatasetItem.metadata.suites: string[]`. Suites are *derived* by scanning that
field; no suite record exists. A suite run is a `DatasetRun` over the library
dataset restricted to the items whose metadata names that suite.

**Alternative rejected — one Dataset per suite.** The natural mapping, and
wrong. It forces copying the item into each dataset, reintroducing exactly the
drift ADR-002 exists to prevent. Editing one question would need N writes that
can partially fail, leaving two suites disagreeing about what a correct answer
is.

**Consequences accepted.**

- *Langfuse's own UI shows one large dataset rather than several tidy ones.*
  Acceptable: this frontend is the primary interface.
- *Langfuse's native per-dataset aggregate is library-wide, not per-suite.* We
  compute per-suite aggregates client-side in `domain/rollup.ts`. Cheap at the
  100-question cap; move server-side if the cap is ever raised past ~1000.
- *Renaming a suite is a non-atomic N-row metadata write.* On partial failure
  the UI briefly shows both names. Handled explicitly: `planRename` returns the
  write set, the bulk API reports per-id success, and the UI offers a targeted
  retry on the remainder. This is the main operational cost of deriving suites
  from metadata.
- *Membership toggling is a read-modify-write and therefore racy.* Two tabs
  toggling different suites on one question can clobber each other. Accepted
  rather than adding optimistic-concurrency plumbing Langfuse does not support;
  the window is small and a lost toggle is redoable.

Implemented in: `domain/langfuse.ts` (documented at length), `api/questions.ts`.

---

## ADR-004 — Runs snapshot question content by hash

**Context.** A user compares this week's run to last week's and sees
"Escalation: passed → failed". Two very different things cause that:

- the agent genuinely regressed, or
- someone tightened the criteria.

Conflating them destroys trust: a false regression sends an engineer debugging
a prompt that is fine.

**Decision.** Every `RunResult` carries `hashAtRun`, an FNV-1a digest of
`prompt + criteria` (see `domain/model.ts::contentHash`). The comparison view
splits results into **comparable** (hash unchanged) and **changed** (hash
differs), rendered in separate, clearly-labelled tables. A regression inside
the changed table is captioned as possibly-not-a-regression and counted
separately as `unattributable`.

**Design details worth preserving.**

- Only prompt and criteria are hashed. Renaming a question or moving it between
  suites does *not* invalidate historical comparisons — correctly, since
  neither changes what the agent was scored against.
- A null-byte separator prevents `('ab','c')` and `('a','bc')` colliding, which
  would make a real edit read as unchanged.
- A **missing** hash on either side is treated as *changed*, not comparable.
  Conservative direction: a false "comparable" produces a false regression,
  which is the failure this ADR exists to prevent.

**Consequences.** Requires storing a hash per run item. Langfuse's dataset
versioning by timestamp covers the same ground natively and can replace this if
your backend forwards `datasetVersion` on run creation — see INTEGRATION.md.

Implemented in: `domain/compare.ts`, `domain/model.ts::contentHash`.

---

## ADR-005 — Cap the library at 100 questions

**Context.** Unbounded question lists force virtualization, slow runs, and
unscannable results.

**Decision.** 100 active (non-archived) questions per agent. The cap is
displayed continuously (`87 / 100`), warns at 85%, and at the limit explains
itself rather than silently disabling the create button.

**Reasoning.** 100 is above what most teams write, keeps a rendered table under
the threshold where virtualization is needed, and keeps a full run cheap enough
that people keep doing it. Under the library model the cap limits how many
tests *exist*, which — combined with the agent home listing suites rather than
questions (ADR-007) — means no view ever renders an unbounded list.

**Consequences.** Client-side filtering and sorting are safe. If the cap is
raised past ~1000, three things must move server-side: library filtering,
per-suite rollup, and failure grouping (which is O(n²)).

The cap message matters as much as the number. Caps that explain themselves
read as a design decision; caps that just block read as a bug.

Implemented in: `domain/library.ts::QUESTION_CAP`, `hooks/useEvals.ts`.

---

## ADR-006 — Failures group by root cause, with a confidence floor

**Context.** A bad prompt change can fail 30 tests at once. Thirty rows with
thirty identical "Apply fix" buttons is unusable. One row saying "no scope
boundary — 30 tests" with one fix is actionable.

**Decision.** Cluster failures by underlying cause. Three paths, in priority
order:

1. **Structured** — the judge emits `{"causeId":"...","cause":"...","fix":"..."}`
   as a JSON prefix in `Score.comment`. Grouping is exact; confidence 1.0.
2. **Fallback** — no structured field, so cluster on judge-prose token overlap.
   Confidence is the mean pairwise similarity and is surfaced in the UI.
3. **Floor** — below `CONFIDENCE_FLOOR` (0.45) we **do not group at all**.
   Every failure becomes a singleton and the UI renders a flat list with an
   explanatory line.

**Why the floor exists.** A wrong grouping is worse than no grouping: it tells
the user two unrelated bugs are one bug and hides the second behind a collapsed
row. Refusing to group is the safe failure mode.

**This is the riskiest assumption in the product.** Grouping quality depends
entirely on the judge writing consistent comments. If your judge produces
free-form prose that varies per call, clustering degrades and the results
screen becomes a flat list with extra chrome.

**Action for the backend team:** emit `causeId`. It converts this from a
heuristic into an exact operation and is cheap to add to the judge prompt.
Validate against real judge output before trusting the clusters.

Implemented in: `domain/grouping.ts`.

---

## ADR-007 — Agent home lists suites, not questions

**Context.** The original design had three tabs — Overview, Run Results, Test
Questions — which are *stages of a linear workflow*, not parallel views. Users
landed on a tab that was empty because they had not done the prior step, and
each of three empty states pointed at a different tab. Overview said "go to
Test Questions"; Run Results said "go to Overview". A loop, not a flow.

**Decision.** The agent home lists **suites**. Questions live one level down in
the library. Empty states are collapsed to one per screen, each with exactly
one primary action.

**Consequences.**

- The rendered row count on the landing screen is bounded by suite count (a
  handful), independent of library size. This is what makes the 100-cap
  sufficient without virtualization.
- Users reach questions in two clicks rather than one. Accepted: the common
  action is running a suite and reading results, not browsing questions.
- The suite picker that sat disabled at the top of every original screen is
  gone. It now lives in the run bar, next to the button that consumes it.

Implemented in: `routes/AgentHome.tsx`.

---

## ADR-008 — Soft delete only

**Context.** Historical runs reference questions. Hard-deleting one makes an old
run's comparison view unreadable, retroactively.

**Decision.** Never hard-delete. Archiving sets Langfuse's native
`status: ARCHIVED`. Archived questions are excluded from suite counts, from the
selectable set in the suite editor, and from the default library view, but stay
readable in past runs and restorable at any time.

**Detail worth preserving.** Archiving does **not** strip suite membership. A
restored question returns to the suites it was in, which is what users expect.
Suite counts already ignore archived items, so a stale membership is harmless.

**Consequences.** The archive confirmation must warn when it empties a suite —
otherwise coverage silently drops to zero. Implemented via
`suitesAffectedByArchive`.

Implemented in: `api/questions.ts::archive`, `routes/Library.tsx`.

---

## ADR-009 — Unscored results are excluded from the pass rate

**Context.** A question can finish with no interpretable score: the judge
failed, the trace expired, or the score used an unrecognised value type.

**Decision.** `scoreToOutcome` returns `'error'`, not `'failed'`. Errored
results are counted separately and **excluded from the pass-rate denominator**.
The UI shows them in a distinct "Not scored" pill and a banner explaining they
are an evaluation problem, not an agent failure.

**Alternatives rejected.**

- *Count as failed.* Shows a red suite for an infrastructure problem and sends
  the user debugging a prompt that is fine.
- *Count as passed.* Hides real failures behind a broken judge.
- *Drop silently.* The pass rate silently describes a subset, with no
  indication which.

Excluding them and surfacing the count separately is the only honest option.

**Related.** When *nothing* was scored, `SuiteStats.inconclusive` is true and
the UI renders `—` rather than `0%`. Those two look identical otherwise, and
the first one causes unnecessary panic.

Implemented in: `domain/model.ts::scoreToOutcome`, `domain/rollup.ts`.
