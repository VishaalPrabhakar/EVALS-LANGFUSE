/**
 * ============================================================================
 * QUESTIONS API
 * ============================================================================
 *
 * CRUD for the question library, expressed in product terms. Every function
 * here translates between our `Question` shape and Langfuse's `DatasetItem`.
 *
 * The key thing to understand: SUITE MEMBERSHIP IS A METADATA WRITE ON ONE
 * ROW. There is no copy operation anywhere in this file, and there must never
 * be one — that absence is what makes drift structurally impossible.
 * ============================================================================
 */

import type { ApiClient } from './client';
import { fetchAllPages } from './client';
import type { LangfuseDatasetItem, Paginated } from '../domain/langfuse';
import { toQuestion, type Question } from '../domain/model';
import { toggleMembership } from '../domain/library';

/** Payload for creating or editing a question. */
export interface QuestionDraft {
  name: string;
  prompt: string;
  criteria: string;
  suites?: string[];
  tags?: string[];
}

/**
 * Build the Langfuse item body from our draft.
 *
 * We store the prompt under `input.question` and criteria under
 * `expectedOutput.criteria`. These key names are matched by `readText()` in
 * model.ts — change both together if your backend uses different keys.
 */
function toItemBody(draft: QuestionDraft, datasetId: string) {
  return {
    datasetId,
    input: { question: draft.prompt },
    expectedOutput: { criteria: draft.criteria },
    metadata: {
      name: draft.name,
      suites: [...new Set(draft.suites ?? [])].sort(),
      tags: [...new Set(draft.tags ?? [])].sort(),
    },
  };
}

export class QuestionsApi {
  // NOTE: explicit fields rather than TypeScript parameter properties.
  // The project enables `erasableSyntaxOnly`, which forbids the constructor
  // shorthand because it emits runtime code. Keep this form.
  private client: ApiClient;
  /** The library dataset id for this agent. One per agent. */
  private datasetId: string;

  constructor(client: ApiClient, datasetId: string) {
    this.client = client;
    this.datasetId = datasetId;
  }

  /**
   * Load the whole library.
   *
   * Pages eagerly because the 100-question cap bounds the size, and every
   * view needs the full set anyway: suites are derived by scanning all
   * questions, so partial data would produce wrong suite counts.
   *
   * @param includeArchived Archived items are excluded by default. The
   *   library view exposes a filter that sets this true.
   */
  async list(includeArchived = false): Promise<Question[]> {
    const items = await fetchAllPages<LangfuseDatasetItem>((page) =>
      this.client.get<Paginated<LangfuseDatasetItem>>('/dataset-items', {
        datasetId: this.datasetId,
        page,
        limit: 50,
      }),
    );
    const all = items.map(toQuestion);
    return includeArchived ? all : all.filter((q) => !q.archived);
  }

  async get(id: string): Promise<Question> {
    const item = await this.client.get<LangfuseDatasetItem>(`/dataset-items/${encodeURIComponent(id)}`);
    return toQuestion(item);
  }

  /**
   * Create a question.
   *
   * CAP ENFORCEMENT IS THE CALLER'S JOB. This method does not check the cap,
   * because the check needs the current count and callers already hold it.
   * The mutation hook in `src/hooks/useQuestions.ts` enforces it before
   * calling here. See docs/EDGE_CASES.md #2.
   */
  async create(draft: QuestionDraft): Promise<Question> {
    const item = await this.client.post<LangfuseDatasetItem>(
      '/dataset-items',
      toItemBody(draft, this.datasetId),
    );
    return toQuestion(item);
  }

  /**
   * Edit a question.
   *
   * ⚠ THIS CHANGES THE QUESTION EVERYWHERE IT IS USED. Under the library
   * model that is the intended behaviour — it is how we avoid drift — but it
   * surprises people. The edit UI must show "Used in N suites" before
   * saving. See docs/EDGE_CASES.md #5.
   *
   * Langfuse upserts dataset items on id, so we POST with the existing id
   * rather than PATCH.
   */
  async update(id: string, draft: QuestionDraft): Promise<Question> {
    const item = await this.client.post<LangfuseDatasetItem>('/dataset-items', {
      id,
      ...toItemBody(draft, this.datasetId),
    });
    return toQuestion(item);
  }

  /**
   * Add or remove a question from a suite.
   *
   * Reads current membership, computes the new array, writes it back. This is
   * a read-modify-write, so it is racy: two tabs toggling different suites on
   * the same question can clobber each other.
   *
   * Mitigation: the UI toggles are per-question and the window is tiny, so we
   * accept the race rather than adding optimistic-concurrency plumbing
   * Langfuse does not support. A conflict manifests as one toggle silently
   * reverting, which the user can redo. Documented in docs/EDGE_CASES.md #17.
   */
  async setSuiteMembership(id: string, suite: string, include: boolean): Promise<Question> {
    const current = await this.get(id);
    const suites = toggleMembership(current.suites, suite, include);
    return this.update(id, {
      name: current.name,
      prompt: current.prompt,
      criteria: current.criteria,
      suites,
      tags: current.tags,
    });
  }

  /**
   * Bulk membership update, for the suite editor's checkbox grid.
   *
   * Runs writes sequentially rather than in parallel. Langfuse rate-limits,
   * and a 100-item parallel burst reliably trips it. Sequential is slower but
   * predictable; the UI shows progress.
   *
   * Returns per-id success so the caller can retry only what failed — a
   * partial failure must not leave the user guessing which half applied.
   */
  async setSuiteMembershipBulk(
    updates: Array<{ id: string; suites: string[] }>,
    onProgress?: (done: number, total: number) => void,
  ): Promise<{ ok: string[]; failed: Array<{ id: string; error: unknown }> }> {
    const ok: string[] = [];
    const failed: Array<{ id: string; error: unknown }> = [];

    for (let i = 0; i < updates.length; i++) {
      const u = updates[i];
      try {
        const current = await this.get(u.id);
        await this.update(u.id, {
          name: current.name,
          prompt: current.prompt,
          criteria: current.criteria,
          suites: u.suites,
          tags: current.tags,
        });
        ok.push(u.id);
      } catch (error) {
        failed.push({ id: u.id, error });
      }
      onProgress?.(i + 1, updates.length);
    }
    return { ok, failed };
  }

  /**
   * Archive a question (soft delete).
   *
   * We NEVER hard-delete. Historical runs reference dataset items; removing
   * one makes an old run's comparison view unreadable. Langfuse's ARCHIVED
   * status is exactly the semantics we want and needs no extra storage.
   *
   * Archiving does NOT strip suite membership. If the user restores the
   * question it returns to the suites it was in, which is what they expect.
   * Suite counts already ignore archived items (see library.ts::deriveSuites).
   */
  async archive(id: string): Promise<void> {
    await this.client.patch(`/dataset-items/${encodeURIComponent(id)}`, { status: 'ARCHIVED' });
  }

  async restore(id: string): Promise<void> {
    await this.client.patch(`/dataset-items/${encodeURIComponent(id)}`, { status: 'ACTIVE' });
  }
}
